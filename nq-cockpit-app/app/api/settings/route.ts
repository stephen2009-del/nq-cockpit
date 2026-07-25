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

  let existing = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!existing) {
    existing = await prisma.settings.create({ data: { id: 1 } });
  }

  const isLocked = existing.tradingWindowLocked;

  const data = {
    dailyLossLimit: parseFloat(body.dailyLossLimit),
    contract: body.contract,
    multiplier: parseFloat(body.multiplier),
    tradovateEnv: body.tradovateEnv === "live" ? "live" : "demo",

    // Once locked, these five fields are frozen server-side, no matter what
    // the request body contains. There is no unlock path — matching
    // Tradovate's own "Lock Risk Settings" behavior, and the same
    // no-override philosophy used by the other guards in this app.
    tradingWindowStart: isLocked ? existing.tradingWindowStart : (body.tradingWindowStart || "09:30"),
    tradingWindowEnd: isLocked ? existing.tradingWindowEnd : (body.tradingWindowEnd || "16:00"),
    cutoffMinutesBeforeClose: isLocked ? existing.cutoffMinutesBeforeClose : (parseInt(body.cutoffMinutesBeforeClose) || 65),
    openingBufferMinutes: isLocked ? existing.openingBufferMinutes : (parseInt(body.openingBufferMinutes) ?? 10),
    // One-way: can go false -> true, never true -> false via this endpoint.
    tradingWindowLocked: isLocked ? true : !!body.tradingWindowLocked,
    liveAccountId: body.liveAccountId || null,
    demoAccountId: body.demoAccountId || null,
    maxConcurrentAdds: Number.isFinite(parseInt(body.maxConcurrentAdds)) ? Math.max(1, parseInt(body.maxConcurrentAdds)) : 2,
    addOnCooldownMinutes: Number.isFinite(parseInt(body.addOnCooldownMinutes)) ? Math.max(0, parseInt(body.addOnCooldownMinutes)) : 3,
  };

  const settings = await prisma.settings.update({ where: { id: 1 }, data });
  return NextResponse.json(settings);
}
