import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 14);
  const levels = await prisma.openInterestLevel.findMany({
    where: { date: { gte: cutoff } },
    orderBy: [{ date: "desc" }, { strike: "asc" }],
  });
  return NextResponse.json(levels);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const level = await prisma.openInterestLevel.create({
    data: {
      strike: parseFloat(body.strike),
      oi: parseFloat(body.oi),
      note: body.note || null,
    },
  });
  return NextResponse.json(level);
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  await prisma.openInterestLevel.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
