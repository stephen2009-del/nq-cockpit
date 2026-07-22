import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 14);
  const entries = await prisma.emotionalLogEntry.findMany({
    where: { date: { gte: cutoff } },
    orderBy: { date: "desc" },
  });
  return NextResponse.json(entries);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.note || !body.note.trim()) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }
  const entry = await prisma.emotionalLogEntry.create({
    data: { tag: body.tag || null, note: body.note.trim() },
  });
  return NextResponse.json(entry);
}
