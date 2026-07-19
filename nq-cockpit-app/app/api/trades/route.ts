import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const trades = await prisma.trade.findMany({ orderBy: { date: "asc" } });
  return NextResponse.json(trades);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const trade = await prisma.trade.create({
    data: {
      symbol: body.symbol,
      dir: body.dir,
      session: body.session,
      entry: body.entry ? parseFloat(body.entry) : null,
      exit: body.exit ? parseFloat(body.exit) : null,
      size: body.size ? parseFloat(body.size) : null,
      pnl: parseFloat(body.pnl),
      setup: body.setup,
      emotion: body.emotion,
      notes: body.notes,
      disciplined: body.disciplined,
      checklistSnapshot: body.checklistSnapshot,
      plannedStop: body.plannedStop ? parseFloat(body.plannedStop) : null,
      plannedTarget: body.plannedTarget ? parseFloat(body.plannedTarget) : null,
    },
  });
  return NextResponse.json(trade);
}
