import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rules = await prisma.rule.findMany({ orderBy: { order: "asc" } });
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const count = await prisma.rule.count();
  const rule = await prisma.rule.create({
    data: { text: body.text, order: count },
  });
  return NextResponse.json(rule);
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  await prisma.rule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
