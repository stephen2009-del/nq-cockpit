import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/tradovate";
import { getTradingWindowStatus } from "@/lib/tradingWindow";

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
