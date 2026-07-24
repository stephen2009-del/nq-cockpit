import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tradingDayStart } from "@/lib/tradingWindow";

export async function GET() {
  const history = await prisma.preMarketPrep.findMany({
    orderBy: { date: "desc" },
    take: 14,
  });
  return NextResponse.json(history);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const qqqPrice = parseFloat(body.qqqPrice);
  const multiplier = parseFloat(body.multiplier);
  const estimatedMove = parseFloat(body.estimatedMove);
  const openInterestNotes = body.openInterestNotes ?? null;
  const nqPrice = qqqPrice * multiplier;

  if (!Number.isFinite(qqqPrice) || !Number.isFinite(multiplier) || !Number.isFinite(estimatedMove) || !Number.isFinite(nqPrice)) {
    return NextResponse.json({ error: "qqqPrice, multiplier, and estimatedMove must be valid numbers" }, { status: 400 });
  }

  const now = new Date();
  const startOfDay = tradingDayStart(now);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const existing = await prisma.preMarketPrep.findFirst({
    where: { date: { gte: startOfDay, lt: endOfDay } },
  });

  const saved = existing
    ? await prisma.preMarketPrep.update({
        where: { id: existing.id },
        data: { qqqPrice, multiplier, estimatedMove, nqPrice, openInterestNotes },
      })
    : await prisma.preMarketPrep.create({
        data: { qqqPrice, multiplier, estimatedMove, nqPrice, openInterestNotes },
      });

  return NextResponse.json(saved);
}
