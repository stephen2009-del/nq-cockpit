import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await prisma.trade.delete({ where: { id: parseInt(params.id) } });
  return NextResponse.json({ ok: true });
}
