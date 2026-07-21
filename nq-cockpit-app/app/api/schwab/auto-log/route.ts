import { NextRequest, NextResponse } from "next/server";
import { getQuote } from "@/lib/schwab";
import { prisma } from "@/lib/prisma";

// Tries several plausible shapes for Schwab's quote response, since the
// exact field name wasn't independently confirmed before building this
// (same situation as Tradovate's P&L field earlier — verify via the raw
// response if this returns null).
function extractQqqPrice(body: any, symbol: string): number | null {
  const entry = body?.[symbol];
  const candidates = [
    entry?.quote?.lastPrice,
    entry?.quote?.mark,
    entry?.quote?.closePrice,
    entry?.lastPrice,
    entry?.mark,
    body?.lastPrice,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
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
        error: "Could not find a price field in Schwab's quote response — field name guess didn't match. See rawResponse.",
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
