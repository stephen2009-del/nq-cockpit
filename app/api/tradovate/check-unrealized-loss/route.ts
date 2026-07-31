import { NextRequest, NextResponse } from "next/server";
import { checkUnrealizedLossAlerts } from "@/lib/positionAlert";

// instrumentation.ts triggers this same logic automatically every 60s.
// Kept here as a manually-triggerable / externally-monitorable version,
// same pattern as /api/alpaca/auto-log.
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await checkUnrealizedLossAlerts();
  return NextResponse.json({ ok: true });
}
