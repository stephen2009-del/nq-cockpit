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
      // Allows callers (e.g. Tradovate sync) to backdate the entry to the
      // real fill time instead of defaulting to "now".
      ...(body.date ? { date: new Date(body.date) } : {}),
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
      source: body.source ?? "manual",
    },
  });
  return NextResponse.json(trade);
}
