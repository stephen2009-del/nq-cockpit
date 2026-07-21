import { NextRequest, NextResponse } from "next/server";
import { getEnrichedFills } from "@/lib/tradovate";
import { matchFillsToTrades } from "@/lib/fifoMatch";
import { prisma } from "@/lib/prisma";

function deriveSession(entryTimeIso: string): string {
  const d = new Date(entryTimeIso);
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d)
  );
  if (etHour >= 9 && etHour < 10) return "NY Open";
  if (etHour >= 10 && etHour < 12) return "NY AM";
  if (etHour >= 12 && etHour < 16) return "NY PM";
  return "Overnight";
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, accountId } = body;

  if (!env || !accountId) {
    return NextResponse.json({ error: "env and accountId are required" }, { status: 400 });
  }

  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) settings = await prisma.settings.create({ data: { id: 1 } });

  const fills = await getEnrichedFills(env, parseInt(accountId));
  if (fills.length === 0) {
    return NextResponse.json({ ok: true, totalMatchedTrades: 0, newlyImported: 0, alreadyPresent: 0, note: "No fills returned from Tradovate for this account." });
  }

  const matched = matchFillsToTrades(fills, settings.multiplier);

  // Auto-synced trades never went through the Pre-Trade checklist — they
  // are marked "unclassified" (disciplined: null), never guessed as clean
  // or flagged. syncKey makes re-running this safe: skipDuplicates means
  // a trade already imported is never inserted twice.
  const rows = matched.map((t) => ({
    date: new Date(t.exitTime),
    symbol: t.symbol,
    dir: t.side,
    session: deriveSession(t.entryTime),
    entry: t.entryPrice,
    exit: t.exitPrice,
    size: t.qty,
    pnl: t.pnl,
    setup: null,
    emotion: null,
    notes: "Auto-synced from Tradovate fills — no checklist was run for this trade.",
    disciplined: null,
    checklistSnapshot: [],
    source: "tradovate_sync",
    externalRef: `${env}-${accountId}-${t.symbol}-${t.entryTime}-${t.exitTime}-${t.qty}`,
  }));

  const result = await prisma.trade.createMany({ data: rows, skipDuplicates: true });

  return NextResponse.json({
    ok: true,
    totalMatchedTrades: matched.length,
    newlyImported: result.count,
    alreadyPresent: matched.length - result.count,
  });
}
