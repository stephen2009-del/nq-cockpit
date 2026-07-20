import { NextRequest, NextResponse } from "next/server";
import { getPositions, getContractName, extractPositionPnl } from "@/lib/tradovate";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const accountId = parseInt(req.nextUrl.searchParams.get("accountId") || "0");

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const result = await getPositions(env, accountId);
  if (!result.ok || !Array.isArray(result.body)) {
    return NextResponse.json({ error: result.body || "Could not fetch positions" }, { status: 502 });
  }

  const open = result.body.filter((p: any) => p.netPos && p.netPos !== 0);
  const enriched = await Promise.all(
    open.map(async (p: any) => {
      const contract = await getContractName(env, p.contractId);
      return {
        symbol: contract.ok ? contract.body.name || String(p.contractId) : String(p.contractId),
        netPos: p.netPos,
        netPrice: p.netPrice,
        directPnl: extractPositionPnl(p),
      };
    })
  );

  return NextResponse.json({ positions: enriched });
}
