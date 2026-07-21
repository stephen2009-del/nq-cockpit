import { NextRequest, NextResponse } from "next/server";
import { getQuote } from "@/lib/alpaca";
import { prisma } from "@/lib/prisma";

// Alpaca's documented quote shape is { "quotes": { "QQQ": { "ap": askPrice,
// "bp": bidPrice, ... } } }. Uses the bid/ask midpoint as "current price" —
// a reasonable top-of-book representation. Falls back through a few other
// plausible shapes in case the documented format doesn't match what's
// actually returned (same defensive approach as the Schwab integration).
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

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await getQuote("QQQ");
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.body, status: result.status }, { status: 502 });
    }

    const qqqPrice = extractQqqPrice(result.body, "QQQ");
    if (qqqPrice === null) {
      return NextResponse.json({
        ok: false,
        error: "Could not find a price field in Alpaca's quote response — field name guess didn't match. See rawResponse.",
        rawResponse: result.body,
      }, { status: 502 });
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayPrep = await prisma.preMarketPrep.findFirst({
      where: { date: { gte: startOfDay } },
      orderBy: { date: "desc" },
    });
    const multiplier = todayPrep?.multiplier ?? 41.36;
    const nqPrice = qqqPrice * multiplier;

    if (!Number.isFinite(qqqPrice) || !Number.isFinite(nqPrice)) {
      return NextResponse.json({ ok: false, error: "Computed price was not a valid number." }, { status: 500 });
    }

    const check = await prisma.intradayCheck.create({ data: { qqqPrice, nqPrice } });
    return NextResponse.json({ ok: true, qqqPrice, nqPrice, multiplierUsed: multiplier, check });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}
