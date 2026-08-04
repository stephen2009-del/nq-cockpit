import { prisma } from "@/lib/prisma";
import { getAccounts, getEnrichedFills } from "@/lib/tradovate";
import { matchFillsToTrades, MatchedTrade } from "@/lib/fifoMatch";

// Same session-label logic as the client's TV Analytics tab, but using
// explicit Eastern Time rather than the server process's local hour —
// this is exactly the kind of thing that silently broke once before
// (see the daily/weekly report timezone bug) when a helper assumed the
// runtime's local time was already ET. Railway's container has no reason
// to actually be on ET, so this must be explicit.
function sessionFromDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hh = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  const h = (hh === 24 ? 0 : hh) + mm / 60;
  if (h >= 9.5 && h < 10.5) return "NY Open";
  if (h >= 10.5 && h < 14) return "NY AM";
  if (h >= 14 && h < 16) return "NY PM";
  if (h >= 3 && h < 8) return "London";
  if (h >= 20 || h < 3) return "Asia";
  return "Overnight";
}

// Same dedup rule as the client's findSyncedTrade — a matched trade is
// treated as already synced if a Trade row exists with the same
// symbol/direction/entry/exit (within a tick) and an exit time within a
// minute of it.
function isAlreadySynced(mt: MatchedTrade, existing: { symbol: string; dir: string; entry: number | null; exit: number | null; date: Date }[]): boolean {
  const exitMs = new Date(mt.exitTime).getTime();
  return existing.some((t) => {
    if (t.symbol !== mt.symbol) return false;
    if (t.dir !== mt.side) return false;
    if (t.entry === null || t.exit === null) return false;
    if (Math.abs(t.entry - mt.entryPrice) > 0.01) return false;
    if (Math.abs(t.exit - mt.exitPrice) > 0.01) return false;
    return Math.abs(new Date(t.date).getTime() - exitMs) < 60_000;
  });
}

export async function autoSyncTrades(): Promise<{ synced: number; checkedEnvs: string[] }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return { synced: 0, checkedEnvs: [] };

  let totalSynced = 0;
  const checkedEnvs: string[] = [];

  for (const env of ["live", "demo"] as const) {
    let accountId: number | null = env === "live"
      ? (settings.liveAccountId ? parseInt(settings.liveAccountId) : null)
      : (settings.demoAccountId ? parseInt(settings.demoAccountId) : null);

    if (!accountId) {
      const accountsResult = await getAccounts(env);
      if (accountsResult.ok && Array.isArray(accountsResult.body) && accountsResult.body.length === 1) {
        accountId = accountsResult.body[0].id;
      }
    }
    if (!accountId) continue; // ambiguous (multiple accounts, none pinned) — skip rather than guess

    checkedEnvs.push(env);

    let fills: any[];
    try {
      fills = await getEnrichedFills(env, accountId);
    } catch (err: any) {
      console.error(`[AUTO-SYNC] Failed to fetch ${env} fills:`, err.message || err);
      continue;
    }
    if (!Array.isArray(fills) || fills.length === 0) continue;

    const matched = matchFillsToTrades(fills, settings.multiplier);
    if (matched.length === 0) continue;

    // Only need to dedup against this env's own trades.
    const existingTrades = await prisma.trade.findMany({
      where: { source: env },
      select: { symbol: true, dir: true, entry: true, exit: true, date: true },
    });
    const existingMutable = [...existingTrades];

    for (const mt of matched) {
      if (isAlreadySynced(mt, existingMutable)) continue;
      const created = await prisma.trade.create({
        data: {
          symbol: mt.symbol,
          dir: mt.side,
          session: sessionFromDate(mt.exitTime),
          entry: mt.entryPrice,
          exit: mt.exitPrice,
          size: mt.qty,
          pnl: mt.pnl,
          setup: null,
          emotion: null,
          notes: "Synced from Tradovate \u2014 auto-imported from real fills, not self-reported.",
          disciplined: null, // no checklist exists for a broker fill; leave unrated rather than assuming clean
          source: env,
          checklistSnapshot: [],
          plannedStop: null,
          plannedTarget: null,
          date: new Date(mt.exitTime),
          entryDate: new Date(mt.entryTime),
        },
      });
      // Avoid re-matching the same fill twice within this same run.
      existingMutable.push({ symbol: created.symbol, dir: created.dir, entry: created.entry, exit: created.exit, date: created.date });
      totalSynced++;
    }
  }

  if (totalSynced > 0) {
    console.log(`[AUTO-SYNC] Synced ${totalSynced} trade(s) across ${checkedEnvs.join(", ")}.`);
  }

  return { synced: totalSynced, checkedEnvs };
}
