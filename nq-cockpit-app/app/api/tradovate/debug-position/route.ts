import { NextRequest, NextResponse } from "next/server";
import { getPositions } from "@/lib/tradovate";

// TEMPORARY debug tool. Shows the exact raw JSON Tradovate returns for your
// positions, so we can see what they actually call the P&L field instead of
// guessing. Safe to leave in (read-only, no orders placed) but fine to
// delete once we've found the field name.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const accountId = parseInt(req.nextUrl.searchParams.get("accountId") || "0");

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const result = await getPositions(env, accountId);
  return NextResponse.json(result, { status: 200 });
}
