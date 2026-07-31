import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rules = await prisma.stopManagementRule.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, accountId, symbol, direction, entryPrice, qty, triggerOffset, mode, newStopOffset, trailAmount, checkFrequency } = body;

  if (!env || !accountId || !symbol || !direction || !entryPrice || !qty || triggerOffset === undefined) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  const ruleMode = mode === "trail" ? "trail" : "oneshot";
  if (ruleMode === "oneshot" && newStopOffset === undefined) {
    return NextResponse.json({ error: "newStopOffset is required for a one-shot rule" }, { status: 400 });
  }
  if (ruleMode === "trail" && (trailAmount === undefined || checkFrequency === undefined)) {
    return NextResponse.json({ error: "trailAmount and checkFrequency are required for an Auto Trail rule" }, { status: 400 });
  }

  const rule = await prisma.stopManagementRule.create({
    data: {
      env,
      accountId: parseInt(accountId),
      symbol,
      direction,
      entryPrice: parseFloat(entryPrice),
      qty: parseInt(qty),
      triggerOffset: parseFloat(triggerOffset),
      mode: ruleMode,
      newStopOffset: ruleMode === "oneshot" ? parseFloat(newStopOffset) : null,
      trailAmount: ruleMode === "trail" ? parseFloat(trailAmount) : null,
      checkFrequency: ruleMode === "trail" ? parseFloat(checkFrequency) : null,
    },
  });
  return NextResponse.json(rule);
}
