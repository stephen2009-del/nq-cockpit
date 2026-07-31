import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.chartSnapshot.delete({ where: { id: parseInt(id) } });
  return NextResponse.json({ ok: true });
}

// Lets a note be added/edited after the image is already uploaded — the
// upload itself fires immediately on file selection, so if you picked the
// image before typing the note, there was previously no way to attach it
// afterward.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const snapshot = await prisma.chartSnapshot.update({
    where: { id: parseInt(id) },
    data: { note: body.note ?? null },
  });
  return NextResponse.json(snapshot);
}
