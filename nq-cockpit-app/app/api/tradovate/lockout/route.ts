import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActiveLockout, createLockout } from "@/lib/lockout";
import { etTimeTodayToUtc } from "@/lib/tradingWindow";

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") || "demo";
  const active = await getActiveLockout(env);
  return NextResponse.json({ active });
}

// No DELETE/cancel endpoint on purpose — once a lockout is set, it runs its
// course, same as Tradovate's own Manual Lockout and consistent with the
// "hard block, no override" approach used elsewhere in this app.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const env = body.env || "demo";
  const existing = await getActiveLockout(env);
  if (existing) {
    return NextResponse.json(
      { error: `Already locked until ${existing.until}. Cannot stack or override an active lockout.` },
      { status: 409 }
    );
  }

  let until: Date;
  let reason: string;

  if (body.restOfDay) {
    let settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) settings = await prisma.settings.create({ data: { id: 1 } });
    until = etTimeTodayToUtc(settings.tradingWindowEnd);
    reason = "Manual lockout — rest of trading day";
  } else {
    const minutes = parseInt(body.minutes);
    if (!minutes || minutes <= 0) {
      return NextResponse.json({ error: "minutes must be a positive number, or set restOfDay: true" }, { status: 400 });
    }
    until = new Date(Date.now() + minutes * 60 * 1000);
    reason = `Manual lockout — ${minutes} minutes`;
  }

  const lockout = await createLockout(env, until, reason);
  return NextResponse.json({ lockout });
}
