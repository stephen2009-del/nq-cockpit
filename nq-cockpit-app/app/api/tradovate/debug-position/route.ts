import { NextRequest, NextResponse } from "next/server";
import { getPositions, getAccounts } from "@/lib/tradovate";

// TEMPORARY debug tool. Shows the exact raw JSON Tradovate returns for your
// positions, so we can see what they actually call the P&L field instead of
// guessing. Safe to leave in (read-only, no orders placed) but fine to
// delete once we've found the field name.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const accountParam = req.nextUrl.searchParams.get("accountId") || "";

  let accountId = parseInt(accountParam);

  // If it wasn't a plain number, treat it as an account name (e.g.
  // "DEMO95538") and resolve it to the numeric ID Tradovate actually uses.
  if (isNaN(accountId)) {
    const accountsResult = await getAccounts(env);
    if (!accountsResult.ok || !Array.isArray(accountsResult.body)) {
      return NextResponse.json({ error: "Could not fetch accounts to resolve name", raw: accountsResult.body }, { status: 502 });
    }
    const match = accountsResult.body.find((a: any) => a.name === accountParam);
    if (!match) {
      return NextResponse.json({
        error: `No account found matching "${accountParam}"`,
        availableAccounts: accountsResult.body.map((a: any) => ({ id: a.id, name: a.name })),
      }, { status: 404 });
    }
    accountId = match.id;
  }

  const result = await getPositions(env, accountId);
  return NextResponse.json({ resolvedAccountId: accountId, ...result }, { status: 200 });
}
