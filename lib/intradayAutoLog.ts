import { getQuote } from "@/lib/alpaca";
import { prisma } from "@/lib/prisma";
import { currentEtMinutes, tradingDayStart } from "@/lib/tradingWindow";

// Alpaca's documented quote shape is { "quotes": { "QQQ": { "ap": askPrice,
// "bp": bidPrice, ... } } }. Uses the bid/ask midpoint as "current price" —
// same extraction logic as the existing /api/alpaca/auto-log route.
function extractQqqPrice(body: any, symbol: string): number | null {
  const q = body?.quotes?.[symbol];
  if (q && typeof q.ap === "number" && typeof q.bp === "number" && q.ap > 0 && q.bp > 0) {
    return (q.ap + q.bp) / 2;
  }
  const candidates = [q?.ap, q?.bp, body?.[symbol]?.ap, body?.[symbol]?.lastPrice, body?.lastPrice];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

// Regular US equity market hours only (9:30am-4:00pm ET, Mon-Fri). QQQ
// itself doesn't trade outside this window, and since NQ price here is a
// derived proxy (QQQ * multiplier) rather than a real futures quote,
// logging outside these hours would just repeat a frozen number — which is
// the exact "not updating" symptom this was built to fix.
export function isRegularMarketHoursEt(now: Date = new Date()): boolean {
  const etWeekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  if (etWeekday === "Sat" || etWeekday === "Sun") return false;
  const mins = currentEtMinutes(now);
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

export type IntradayAutoLogResult =
  | { ok: true; skipped: string }
  | { ok: true; qqqPrice: number; nqPrice: number; multiplierUsed: number }
  | { ok: false; error: string };

export async function runIntradayAutoLog(now: Date = new Date()): Promise<IntradayAutoLogResult> {
  if (!isRegularMarketHoursEt(now)) {
    return { ok: true, skipped: "outside regular market hours (9:30am\u20134:00pm ET, Mon\u2013Fri)" };
  }

  try {
    const result = await getQuote("QQQ");
    if (!result.ok) {
      return { ok: false, error: typeof result.body === "string" ? result.body : JSON.stringify(result.body) };
    }

    const qqqPrice = extractQqqPrice(result.body, "QQQ");
    if (qqqPrice === null) {
      return { ok: false, error: "Could not find a price field in Alpaca's quote response \u2014 field name guess didn't match." };
    }

    // Uses the shared trading-day boundary (6pm ET rollover) instead of a
    // rough hardcoded EDT offset, for consistency with the rest of the app.
    const startOfDayEt = tradingDayStart(now);

    const todayPrep = await prisma.preMarketPrep.findFirst({
      where: { date: { gte: startOfDayEt } },
      orderBy: { date: "desc" },
    });
    const multiplier = todayPrep?.multiplier ?? 41.36;
    const nqPrice = qqqPrice * multiplier;

    if (!Number.isFinite(qqqPrice) || !Number.isFinite(nqPrice)) {
      return { ok: false, error: "Computed price was not a valid number." };
    }

    await prisma.intradayCheck.create({ data: { qqqPrice, nqPrice } });
    return { ok: true, qqqPrice, nqPrice, multiplierUsed: multiplier };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}
