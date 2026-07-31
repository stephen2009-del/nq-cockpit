import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findOpenPosition, findWorkingStopOrder, modifyStopOrder, getOrderById } from "@/lib/tradovate";

// The closest real equivalent to "locking a stop" this app can actually
// enforce. There's no way to intercept a stop modified directly in
// Tradovate's own interface — same limitation as every other guard in
// this app, addressed head-on rather than pretended around. What IS
// buildable: if a stop is going to be modified through THIS app, make
// tightening it (reducing risk) instant, and make loosening or removing
// it (increasing risk) require an explicit typed reason first — same
// asymmetric-friction pattern as the add-on reason prompt.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, accountId, symbol, newStopPrice, reason } = body;

  if (!env || (env !== "demo" && env !== "live")) {
    return NextResponse.json({ error: "env must be 'demo' or 'live'" }, { status: 400 });
  }
  if (!accountId || !symbol || newStopPrice === undefined || newStopPrice === null) {
    return NextResponse.json({ error: "accountId, symbol, and newStopPrice are required" }, { status: 400 });
  }

  const position = await findOpenPosition(env, parseInt(accountId), symbol);
  if (!position || !position.netPos) {
    return NextResponse.json({ error: `No open position found in ${symbol}.` }, { status: 404 });
  }
  const direction: "long" | "short" = position.netPos > 0 ? "long" : "short";

  const stopOrder = await findWorkingStopOrder(env, parseInt(accountId), symbol);
  if (!stopOrder) {
    return NextResponse.json({ error: `No working stop order found for ${symbol}. This app can't create a new stop from scratch here — only adjust an existing one.` }, { status: 404 });
  }
  const currentStop = stopOrder.stopPrice ?? stopOrder.price;
  if (typeof currentStop !== "number") {
    return NextResponse.json({ error: "Could not read the current stop price from Tradovate — nothing was modified." }, { status: 502 });
  }

  const target = parseFloat(newStopPrice);
  // Tightening = moving the stop closer to the current price (less risk):
  // for a long that means UP, for a short that means DOWN. Anything else
  // is loosening, including leaving it unchanged.
  const isTightening = direction === "long" ? target > currentStop : target < currentStop;

  if (!isTightening && (!reason || !String(reason).trim())) {
    const blockReason = `Moving the stop on ${symbol} from ${currentStop} to ${target} would increase risk on this position, not reduce it \u2014 a reason is required before this app will send that change to Tradovate. Tightening a stop is instant; loosening one isn't.`;
    await prisma.tradovateOrderLog.create({
      data: {
        env, symbol, side: direction === "long" ? "Buy" : "Sell", qty: stopOrder.orderQty ?? 0, orderType: "StopModify",
        stopLossPrice: target,
        status: "BLOCKED",
        blockedReason: blockReason,
      },
    });
    return NextResponse.json({ blocked: true, reason: blockReason }, { status: 403 });
  }

  await modifyStopOrder(env, stopOrder.id, stopOrder.orderQty ?? position.netPos, target);
  // Never trust the modify response alone — verify the change actually
  // landed, same as the existing Automatic Stop Management feature does.
  const verifyResult = await getOrderById(env, stopOrder.id);
  const actualStopPrice = verifyResult.ok ? (verifyResult.body.stopPrice ?? verifyResult.body.price) : null;
  const verified = actualStopPrice !== null && Math.abs(actualStopPrice - target) < 0.01;

  const log = await prisma.tradovateOrderLog.create({
    data: {
      env, symbol, side: direction === "long" ? "Buy" : "Sell", qty: stopOrder.orderQty ?? 0, orderType: "StopModify",
      stopLossPrice: target,
      addReason: !isTightening ? String(reason).trim() : null,
      status: verified ? "SUBMITTED" : "ERROR",
      tradovateOrderId: String(stopOrder.id),
      rawResponse: { previousStop: currentStop, requestedStop: target, verifiedStop: actualStopPrice },
    },
  });

  if (!verified) {
    return NextResponse.json({
      ok: false,
      warning: `Modify request was sent but verification found the stop still at ${actualStopPrice ?? "unknown"}, not the requested ${target}. Check Tradovate directly.`,
      log,
    }, { status: 502 });
  }

  return NextResponse.json({ ok: true, previousStop: currentStop, newStop: target, tightening: isTightening, log });
}
