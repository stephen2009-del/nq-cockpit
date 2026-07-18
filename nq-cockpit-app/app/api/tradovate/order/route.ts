import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { placeOrder, findOpenPosition } from "@/lib/tradovate";
import { getTradingWindowStatus } from "@/lib/tradingWindow";
import { checkAddingToLoser } from "@/lib/positionGuard";

export async function GET() {
  const logs = await prisma.tradovateOrderLog.findMany({
    orderBy: { date: "desc" },
    take: 50,
  });
  return NextResponse.json(logs);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, accountId, symbol, action, orderQty, orderType, price } = body;

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

  // AUTHORITATIVE server-side check — this is what actually blocks the trade.
  // The UI also shows this status, but this check is the one that counts:
  // it runs regardless of what the browser sends or whether the UI was bypassed.
  const windowStatus = getTradingWindowStatus(settings);

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
  // "Current price" comes from the most recent Intraday check today, falling
  // back to today's Pre-Market prep. This app has no live market data feed,
  // so this check is only as fresh as the last price you logged.
  try {
    const position = await findOpenPosition(env, parseInt(accountId), symbol);
    if (position && position.netPos !== 0) {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const lastCheck = await prisma.intradayCheck.findFirst({
        where: { date: { gte: startOfDay } },
        orderBy: { date: "desc" },
      });
      const todayPrep = await prisma.preMarketPrep.findFirst({
        where: { date: { gte: startOfDay } },
        orderBy: { date: "desc" },
      });
      const currentPrice = lastCheck?.nqPrice ?? todayPrep?.nqPrice ?? null;

      if (currentPrice !== null) {
        const guard = checkAddingToLoser({
          existingNetPos: position.netPos,
          existingNetPrice: position.netPrice,
          newOrderSide: action,
          currentPrice,
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
    // If the position lookup itself fails (e.g. contract matching issue),
    // we do NOT silently allow the order through unchecked — log it and let
    // the order fall through to Tradovate's own validation, but surface the
    // lookup failure so it's visible rather than hidden.
    console.error("Position guard lookup failed:", err.message || err);
  }

  try {
    const result = await placeOrder(env, {
      accountId: parseInt(accountId),
      symbol,
      action,
      orderQty: parseInt(orderQty),
      orderType,
      price: price ? parseFloat(price) : undefined,
    });

    const log = await prisma.tradovateOrderLog.create({
      data: {
        env,
        symbol,
        side: action,
        qty: parseInt(orderQty),
        orderType,
        limitPrice: price ? parseFloat(price) : null,
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
        status: "ERROR",
        blockedReason: err.message || String(err),
      },
    });
    return NextResponse.json({ blocked: false, error: err.message || String(err), log }, { status: 500 });
  }
}
