import { NextRequest, NextResponse } from "next/server";
import { getFills, getPositions, getCashBalance, getContractName } from "@/lib/tradovate";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const accountId = parseInt(req.nextUrl.searchParams.get("accountId") || "0");

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const [fillsResult, positionsResult, cashResult] = await Promise.all([
    getFills(env, accountId),
    getPositions(env, accountId),
    getCashBalance(env, accountId),
  ]);

  const fills = fillsResult.ok && Array.isArray(fillsResult.body) ? fillsResult.body : [];
  const positions = positionsResult.ok && Array.isArray(positionsResult.body) ? positionsResult.body : [];

  // Resolve each unique contractId to a readable symbol name, once per ID.
  const uniqueContractIds = Array.from(new Set(fills.map((f: any) => f.contractId).filter(Boolean)));
  const nameMap: Record<number, string> = {};
  for (const id of uniqueContractIds) {
    const contract = await getContractName(env, id as number);
    nameMap[id as number] = contract.ok ? contract.body.name || String(id) : String(id);
  }

  const enrichedFills = fills.map((f: any) => ({
    ...f,
    symbolName: nameMap[f.contractId] || String(f.contractId),
  }));

  const enrichedPositions = positions
    .filter((p: any) => p.netPos && p.netPos !== 0)
    .map((p: any) => ({ ...p, symbolName: nameMap[p.contractId] || String(p.contractId) }));

  return NextResponse.json({
    fills: enrichedFills,
    positions: enrichedPositions,
    cashBalance: cashResult.ok ? cashResult.body : null,
    cashBalanceError: cashResult.ok ? null : cashResult.body,
    fillsError: fillsResult.ok ? null : fillsResult.body,
  });
}
