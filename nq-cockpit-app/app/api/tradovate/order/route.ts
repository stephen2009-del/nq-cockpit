import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { placeOrder, placeOSO, getAccounts, findOpenPosition, getEnrichedFills, extractPositionPnl, extractAccountOpenPnl, getCashBalance } from "@/lib/tradovate";
import { getTradingWindowStatus, etTimeTodayToUtc, tradingDayStart } from "@/lib/tradingWindow";
import { checkAddingToLoser } from "@/lib/positionGuard";
import { matchFillsToTrades } from "@/lib/fifoMatch";
import { getActiveLockout, createLockout } from "@/lib/lockout";
import { getFreshIntradayPrice, FRESHNESS_MINUTES, getLastKnownNqPrice } from "@/lib/lastKnownPrice";

export async function GET() {
  const logs = await prisma.tradovateOrderLog.findMany({
    orderBy: { date: "desc" },
    take: 50,
  });
  return NextResponse.json(logs);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, accountId, symbol, action, orderQty, orderType, price, stopLoss, target } = body;

  if (!env || (env !== "demo" && env !== "live")) {
    return NextResponse.json({ error: "env must be 'demo' or 'live'" }, { status: 400 });
  }
  if (!accountId || !symbol || !action || !orderQty || !orderType) {
    return NextResponse.json({ error: "Missing required order fields" }, { status: 400 });
  }

  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.settings.create({ data: { id: 1 } });
  }

  // GUARD — fat-finger limit price sanity check (server-side backstop).
  // The Trade Ticket UI already asks for confirmation past a 3% deviation;
  // this is a hard block for a much larger deviation (25%+, e.g. a typo'd
  // extra digit) in case that client-side confirm was ever bypassed. Not a
  // risk-management guard like the ones below — a resting limit far from
  // market can be entirely intentional, which is exactly why the threshold
  // here is deliberately wide (only egregious, near-certainly-a-typo cases
  // get blocked outright) rather than matching the UI's 3% warning level.
  if (orderType === "Limit" && price) {
    const enteredPrice = parseFloat(price);
    const lastKnown = await getLastKnownNqPrice();
    if (Number.isFinite(enteredPrice) && enteredPrice > 0 && lastKnown !== null) {
      const pctOff = Math.abs(enteredPrice - lastKnown) / lastKnown;
      if (pctOff > 0.25) {
        const reason = `Limit price ${enteredPrice} is ${(pctOff * 100).toFixed(0)}% away from the last known price (${lastKnown}) \u2014 blocked as a likely data-entry error (extra/missing digit). Double-check the price and resubmit if it's really intended.`;
        await prisma.tradovateOrderLog.create({
          data: {
            env, symbol, side: action, qty: parseInt(orderQty), orderType,
            limitPrice: parseFloat(price),
            status: "BLOCKED",
            blockedReason: reason,
          },
        });
        return NextResponse.json({ blocked: true, reason }, { status: 403 });
      }
    }
  }

  // GUARD 0 — active manual/auto lockout. Checked before anything else.
  const activeLockout = await getActiveLockout();
  if (activeLockout) {
    await prisma.tradovateOrderLog.create({
      data: {
        env, symbol, side: action, qty: parseInt(orderQty), orderType,
        limitPrice: price ? parseFloat(price) : null,
        status: "BLOCKED",
        blockedReason: `Locked until ${activeLockout.until.toISOString()} — ${activeLockout.reason}`,
      },
    });
    return NextResponse.json(
      { blocked: true, reason: `Locked until ${activeLockout.until.toISOString()} — ${activeLockout.reason}` },
      { status: 403 }
    );
  }

  // AUTHORITATIVE server-side check — this is what actually blocks the trade.
  // The UI also shows this status, but this check is the one that counts:
  // it runs regardless of what the browser sends or whether the UI was bypassed.
  // Only enforced for Live — Demo is unrestricted by time, since it's for
  // practice/testing and shouldn't be gated by the same real-money guard.
  const windowStatus = env === "live"
    ? getTradingWindowStatus(settings)
    : { allowed: true, reason: "Demo — Trading Window Guard not enforced (Live only).", etLabel: "" };

  if (!windowStatus.allowed) {
    await prisma.tradovateOrderLog.create({
      data: {
        env,
        symbol,
        side: action,
        qty: parseInt(orderQty),
        orderType,
        limitPrice: price ? parseFloat(price) : null,
        status: "BLOCKED",
        blockedReason: windowStatus.reason,
      },
    });
    return NextResponse.json(
      { blocked: true, reason: windowStatus.reason },
      { status: 403 }
    );
  }

  // SECOND AUTHORITATIVE CHECK — no adding to a losing position.
  // Prefers Tradovate's OWN computed P&L (position-level, then account-level)
  // since that's the broker's real number, not something we're inferring.
  //
  // We do NOT trust the order's own submitted price anymore — that was
  // tried and it failed a real test: a limit price equal to the original
  // entry read as "flat" when the real market had already moved against
  // the position. An order's price reflects where you want to trade, not
  // necessarily where the market actually is.
  //
  // The only remaining fallback is a FRESH (logged within the last
  // FRESHNESS_MINUTES) Intraday check. No fresh check, no fallback — this
  // fails closed rather than guessing.
  try {
    const position = await findOpenPosition(env, parseInt(accountId), symbol);
    if (position && position.netPos !== 0) {
      const existingDirection = position.netPos > 0 ? "long" : "short";
      const newDirection = action === "Buy" ? "long" : "short";

      // Only same-direction orders ("adding") need any of this. Reducing,
      // closing, or reversing is always allowed regardless of data
      // availability — there's nothing to protect against there.
      if (newDirection === existingDirection) {
        let directPnl = extractPositionPnl(position);
        let pnlSource: "position" | "account" | "logged_price" = "position";

        if (directPnl === null) {
          const cashResult = await getCashBalance(env, parseInt(accountId));
          if (cashResult.ok) {
            directPnl = extractAccountOpenPnl(cashResult.body);
            pnlSource = "account";
          }
        }

        let currentPrice: number | undefined;
        let priceAgeMinutes: number | undefined;

        if (directPnl === null) {
          pnlSource = "logged_price";
          const fresh = await getFreshIntradayPrice();
          if (fresh) {
            currentPrice = fresh.price;
            priceAgeMinutes = fresh.ageMinutes;
          }
        }

        if (directPnl === null && currentPrice === undefined) {
          if (env === "live") {
            // FAIL CLOSED (live only): no Tradovate P&L, and no Intraday
            // check logged within the freshness window. Block rather than
            // guess — this matters because real money is on the line.
            const reason = `Cannot verify whether your existing ${existingDirection} position is winning or losing — no Tradovate P&L available, and no Intraday check logged within the last ${FRESHNESS_MINUTES} minutes. Log a fresh Intraday check and try again.`;
            await prisma.tradovateOrderLog.create({
              data: {
                env, symbol, side: action, qty: parseInt(orderQty), orderType,
                limitPrice: price ? parseFloat(price) : null,
                status: "BLOCKED",
                blockedReason: reason,
              },
            });
            return NextResponse.json({ blocked: true, reason }, { status: 403 });
          }
          // DEMO: fail OPEN instead. This fallback price is QQQ-derived and
          // only exists during equity market hours (9:30am-4pm ET) — but NQ
          // itself trades nearly 24/5 on Globex, so blocking demo orders
          // whenever it's after equity hours (or Tradovate's own P&L fields
          // don't resolve) has no real protective value on a practice
          // account and just gets in the way of testing overnight/Globex
          // trades. The order log still records that this check was
          // skipped, for visibility.
          await prisma.tradovateOrderLog.create({
            data: {
              env, symbol, side: action, qty: parseInt(orderQty), orderType,
              limitPrice: price ? parseFloat(price) : null,
              status: "ALLOWED",
              blockedReason: "Demo: position-guard check skipped (no Tradovate P&L or fresh Intraday price available) \u2014 not enforced on demo.",
            },
          });
        } else {

        const guard = checkAddingToLoser({
          existingNetPos: position.netPos,
          existingNetPrice: position.netPrice,
          newOrderSide: action,
          currentPrice,
          priceAgeMinutes,
          directPnl,
          pnlSource,
        });
        if (guard.blocked) {
          await prisma.tradovateOrderLog.create({
            data: {
              env,
              symbol,
              side: action,
              qty: parseInt(orderQty),
              orderType,
              limitPrice: price ? parseFloat(price) : null,
              status: "BLOCKED",
              blockedReason: guard.reason,
            },
          });
          return NextResponse.json({ blocked: true, reason: guard.reason }, { status: 403 });
        }
        }
      }
    }
  } catch (err: any) {
    // The old comment here claimed this failed closed — it didn't; it just
    // logged and let the order through. Fixed: if the position lookup
    // itself errors out, we genuinely don't know if there's a losing
    // position to protect, so block rather than guess.
    console.error("Position guard lookup failed:", err.message || err);
    const reason = `Could not check your current position before this order (lookup error: ${err.message || err}). Blocking as a precaution rather than proceeding unverified.`;
    await prisma.tradovateOrderLog.create({
      data: {
        env, symbol, side: action, qty: parseInt(orderQty), orderType,
        limitPrice: price ? parseFloat(price) : null,
        status: "BLOCKED",
        blockedReason: reason,
      },
    });
    return NextResponse.json({ blocked: true, reason }, { status: 403 });
  }

  // GUARD 3 — daily loss limit, computed from REAL Tradovate fills (not the
  // manually-logged Journal). If today's realized P&L has hit your Settings
  // loss limit, this auto-creates a lockout for the rest of the trading day
  // and blocks this order too. Adds a bit of latency (fetches + resolves
  // today's fills before every order) — a known tradeoff for using real data.
  try {
    const enrichedFills = await getEnrichedFills(env, parseInt(accountId));
    const now = new Date();
    // A "trading day" runs 6pm ET to 6pm ET the next day (CME Globex
    // convention), not midnight — matches tradingDayKey/tradingDayStart used
    // everywhere else in the app now, so this guard's "today" agrees with
    // what the UI shows as "today."
    const startOfDay = tradingDayStart(now);
    const todaysFills = enrichedFills.filter((f: any) => new Date(f.timestamp) >= startOfDay);
    const matched = matchFillsToTrades(todaysFills as any, settings.multiplier);
    const todaysRealizedPnl = matched.reduce((s, t) => s + t.pnl, 0);

    if (todaysRealizedPnl <= -settings.dailyLossLimit) {
      const until = etTimeTodayToUtc(settings.tradingWindowEnd);
      await createLockout(until, `Daily loss limit reached (${todaysRealizedPnl.toFixed(2)} vs limit -${settings.dailyLossLimit})`);
      const reason = `Daily loss limit reached: realized P&L ${todaysRealizedPnl.toFixed(2)} vs. your limit of -${settings.dailyLossLimit}. Trading locked for the rest of the day.`;
      await prisma.tradovateOrderLog.create({
        data: {
          env, symbol, side: action, qty: parseInt(orderQty), orderType,
          limitPrice: price ? parseFloat(price) : null,
          status: "BLOCKED",
          blockedReason: reason,
        },
      });
      return NextResponse.json({ blocked: true, reason }, { status: 403 });
    }
  } catch (err: any) {
    console.error("Daily loss limit check failed:", err.message || err);
  }

  const hasBracket = stopLoss !== undefined && stopLoss !== null && stopLoss !== "" && target !== undefined && target !== null && target !== "";

  try {
    let result;
    if (hasBracket) {
      // accountSpec (the account's name string) is required by Tradovate's
      // OSO endpoint alongside accountId — resolve it from the accounts list.
      const accountsResult = await getAccounts(env);
      const matchingAccount = accountsResult.ok && Array.isArray(accountsResult.body)
        ? accountsResult.body.find((a: any) => String(a.id) === String(accountId))
        : null;
      if (!matchingAccount) {
        throw new Error("Could not resolve account name (accountSpec) required for bracket orders.");
      }
      result = await placeOSO(env, {
        accountId: parseInt(accountId),
        accountSpec: matchingAccount.name,
        symbol,
        action,
        orderQty: parseInt(orderQty),
        orderType,
        price: price ? parseFloat(price) : undefined,
        stopLossPrice: parseFloat(stopLoss),
        targetPrice: parseFloat(target),
      });
    } else {
      result = await placeOrder(env, {
        accountId: parseInt(accountId),
        symbol,
        action,
        orderQty: parseInt(orderQty),
        orderType,
        price: price ? parseFloat(price) : undefined,
      });
    }

    const log = await prisma.tradovateOrderLog.create({
      data: {
        env,
        symbol,
        side: action,
        qty: parseInt(orderQty),
        orderType,
        limitPrice: price ? parseFloat(price) : null,
        stopLossPrice: hasBracket ? parseFloat(stopLoss) : null,
        targetPrice: hasBracket ? parseFloat(target) : null,
        status: result.ok ? "SUBMITTED" : "ERROR",
        tradovateOrderId: result.ok ? String(result.body.orderId ?? "") : null,
        rawResponse: result.body,
      },
    });

    if (!result.ok) {
      return NextResponse.json({ blocked: false, error: result.body, log }, { status: 502 });
    }
    return NextResponse.json({ blocked: false, result: result.body, log });
  } catch (err: any) {
    const log = await prisma.tradovateOrderLog.create({
      data: {
        env,
        symbol,
        side: action,
        qty: parseInt(orderQty),
        orderType,
        limitPrice: price ? parseFloat(price) : null,
        stopLossPrice: hasBracket ? parseFloat(stopLoss) : null,
        targetPrice: hasBracket ? parseFloat(target) : null,
        status: "ERROR",
        blockedReason: err.message || String(err),
      },
    });
    return NextResponse.json({ blocked: false, error: err.message || String(err), log }, { status: 500 });
  }
}
