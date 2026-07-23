import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const snapshots = await prisma.chartSnapshot.findMany({ orderBy: { date: "desc" } });
  return NextResponse.json(snapshots);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.imageData) {
    return NextResponse.json({ error: "imageData is required" }, { status: 400 });
  }
  const snapshot = await prisma.chartSnapshot.create({
    data: {
      note: body.note || null,
      imageData: body.imageData,
      ...(body.date ? { date: new Date(body.date) } : {}),
    },
  });
  return NextResponse.json(snapshot);
}
