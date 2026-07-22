import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { placeOrder, placeOSO, getAccounts, findOpenPosition, getEnrichedFills, extractPositionPnl, extractAccountOpenPnl, getCashBalance } from "@/lib/tradovate";
import { getTradingWindowStatus, etTimeTodayToUtc } from "@/lib/tradingWindow";
import { checkAddingToLoser } from "@/lib/positionGuard";
import { matchFillsToTrades } from "@/lib/fifoMatch";
import { getActiveLockout, createLockout } from "@/lib/lockout";
import { getFreshIntradayPrice, FRESHNESS_MINUTES } from "@/lib/lastKnownPrice";

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
          // FAIL CLOSED: no Tradovate P&L, and no Intraday check logged
          // within the freshness window. Block rather than guess.
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
    // Was: new Date(now.getFullYear(), now.getMonth(), now.getDate()), which
    // uses the SERVER's local timezone (UTC on Railway) — that silently rolls
    // "today" over at 5pm Pacific instead of midnight, not matching what a
    // trader means by "today's" realized P&L. Use the same ET-based boundary
    // the trading-window logic already uses elsewhere.
    const startOfDay = etTimeTodayToUtc("00:00", now);
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
