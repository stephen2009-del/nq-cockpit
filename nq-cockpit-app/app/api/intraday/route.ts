import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const checks = await prisma.intradayCheck.findMany({
    where: { date: { gte: startOfDay } },
    orderBy: { date: "asc" },
  });
  return NextResponse.json(checks);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const qqqPrice = parseFloat(body.qqqPrice);
  const multiplier = parseFloat(body.multiplier);
  const nqPrice = qqqPrice * multiplier;
  const check = await prisma.intradayCheck.create({
    data: { qqqPrice, nqPrice },
  });
  return NextResponse.json(check);
}
