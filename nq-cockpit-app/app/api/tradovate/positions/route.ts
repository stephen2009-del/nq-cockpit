import { NextRequest, NextResponse } from "next/server";
import { getPositions, getContractName, extractPositionPnl, getCashBalance, extractAccountOpenPnl } from "@/lib/tradovate";
import { prisma } from "@/lib/prisma";
import { getLastKnownNqPriceWithAge } from "@/lib/lastKnownPrice";

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

  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) settings = await prisma.settings.create({ data: { id: 1 } });

  const loggedPriceInfo = await getLastKnownNqPriceWithAge();

  const open = result.body.filter((p: any) => p.netPos && p.netPos !== 0);
  const enriched = await Promise.all(
    open.map(async (p: any) => {
      const contract = await getContractName(env, p.contractId);
      const symbol = contract.ok ? contract.body.name || String(p.contractId) : String(p.contractId);

      let pnl: number | null = extractPositionPnl(p);
      let pnlSource: "position" | "account" | "estimated" | null = pnl !== null ? "position" : null;

      if (pnl === null) {
        const cashResult = await getCashBalance(env, accountId);
        if (cashResult.ok) {
          const accountPnl = extractAccountOpenPnl(cashResult.body);
          if (accountPnl !== null) {
            pnl = accountPnl;
            pnlSource = "account";
          }
        }
      }

      if (pnl === null && loggedPriceInfo !== null) {
        const direction = p.netPos > 0 ? 1 : -1;
        pnl = direction * (loggedPriceInfo.price - p.netPrice) * settings.multiplier * Math.abs(p.netPos);
        pnlSource = "estimated";
      }

      // Tradovate's own timestamp on the position record — used as a proxy
      // for "time since this position was last opened/changed", so we can
      // flag a real-time "you've been holding this loser a while" warning
      // instead of only reporting on it after the fact.
      const openSinceMinutes = p.timestamp ? (Date.now() - new Date(p.timestamp).getTime()) / 60000 : null;

      return {
        symbol,
        netPos: p.netPos,
        netPrice: p.netPrice,
        pnl,
        pnlSource,
        loggedPrice: loggedPriceInfo?.price ?? null,
        loggedPriceAgeMinutes: loggedPriceInfo?.ageMinutes ?? null,
        openSinceMinutes,
      };
    })
  );

  return NextResponse.json({ positions: enriched });
}
