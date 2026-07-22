import { NextRequest, NextResponse } from "next/server";
import { runIntradayAutoLog } from "@/lib/intradayAutoLog";

// instrumentation.ts now triggers this same logic automatically every
// minute during market hours. Kept here as a manually-triggerable /
// externally-monitorable version of the same thing (e.g. to confirm it's
// working after a process restart, or from an external monitor).
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runIntradayAutoLog();
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
