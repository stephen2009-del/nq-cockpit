import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.trade.delete({ where: { id: parseInt(id) } });
  return NextResponse.json({ ok: true });
}

// Currently only used to backfill entryDate on trades synced before that
// field existed, matched against fresh Tradovate fill data. Deliberately
// narrow — only accepts entryDate, not a general-purpose trade editor.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  if (!body.entryDate) {
    return NextResponse.json({ error: "Only entryDate can be patched here." }, { status: 400 });
  }
  const trade = await prisma.trade.update({
    where: { id: parseInt(id) },
    data: { entryDate: new Date(body.entryDate) },
  });
  return NextResponse.json(trade);
}
