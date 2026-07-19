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
  const { env, accountId, symbol, direction, entryPrice, qty, triggerOffset, newStopOffset } = body;

  if (!env || !accountId || !symbol || !direction || !entryPrice || !qty || triggerOffset === undefined || newStopOffset === undefined) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
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
      newStopOffset: parseFloat(newStopOffset),
    },
  });
  return NextResponse.json(rule);
}
