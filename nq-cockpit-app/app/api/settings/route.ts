import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.settings.create({
      data: { id: 1, dailyLossLimit: 500, contract: "NQ", multiplier: 20 },
    });
  }
  return NextResponse.json(settings);
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const data = {
    dailyLossLimit: parseFloat(body.dailyLossLimit),
    contract: body.contract,
    multiplier: parseFloat(body.multiplier),
    tradingWindowStart: body.tradingWindowStart || "09:30",
    tradingWindowEnd: body.tradingWindowEnd || "16:00",
    cutoffMinutesBeforeClose: parseInt(body.cutoffMinutesBeforeClose) || 65,
    tradovateEnv: body.tradovateEnv === "live" ? "live" : "demo",
  };
  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });
  return NextResponse.json(settings);
}
