export type TradovateFill = {
  id: number;
  contractId: number;
  symbolName: string;
  timestamp: string;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
};

export type MatchedTrade = {
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
};

export type HoldTimeFlag = { trade: MatchedTrade; holdMinutes: number; text: string };

export type HoldTimeAnalysis = {
  avgWinnerHoldMinutes: number | null;
  avgLoserHoldMinutes: number | null;
  patternFlag: string | null;
  flaggedTrades: HoldTimeFlag[];
};

// Compares how long winning trades were held vs. losing trades — the
// classic "let losers run, cut winners short" pattern (disposition effect),
// using real fill timestamps from Tradovate, not self-reported data.
export function analyzeHoldTimes(trades: MatchedTrade[]): HoldTimeAnalysis {
  const withDuration = trades.map((t) => ({
    trade: t,
    holdMinutes: (new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) / 60000,
  }));

  const winners = withDuration.filter((t) => t.trade.pnl > 0);
  const losers = withDuration.filter((t) => t.trade.pnl < 0);

  const avgWinnerHoldMinutes = winners.length ? winners.reduce((s, t) => s + t.holdMinutes, 0) / winners.length : null;
  const avgLoserHoldMinutes = losers.length ? losers.reduce((s, t) => s + t.holdMinutes, 0) / losers.length : null;

  let patternFlag: string | null = null;
  if (avgWinnerHoldMinutes !== null && avgLoserHoldMinutes !== null && winners.length >= 2 && losers.length >= 2) {
    const ratio = avgLoserHoldMinutes / (avgWinnerHoldMinutes || 1);
    if (ratio >= 1.5) {
      patternFlag = `On average, you hold losing trades ${avgLoserHoldMinutes.toFixed(1)} min — ${ratio.toFixed(1)}x longer than winning trades (${avgWinnerHoldMinutes.toFixed(1)} min). That's the classic pattern of letting losses run while cutting winners short.`;
    }
  }

  const flaggedTrades: HoldTimeFlag[] = [];
  if (avgWinnerHoldMinutes !== null && avgWinnerHoldMinutes > 0) {
    losers.forEach(({ trade, holdMinutes }) => {
      if (holdMinutes > avgWinnerHoldMinutes * 2) {
        flaggedTrades.push({
          trade,
          holdMinutes,
          text: `Held this loser for ${holdMinutes.toFixed(1)} min — ${(holdMinutes / avgWinnerHoldMinutes).toFixed(1)}x longer than your average winning trade (${avgWinnerHoldMinutes.toFixed(1)} min).`,
        });
      }
    });
  }

  return { avgWinnerHoldMinutes, avgLoserHoldMinutes, patternFlag, flaggedTrades };
}

// MNQ (Micro E-mini Nasdaq-100) is fixed by CME at exactly 1/10th of NQ's
// point value — this isn't a user-configurable setting, it's a contract
// spec. Previously every symbol used the same `multiplier` (meant for NQ),
// which overstated MNQ fills' P&L by 10x.
function pointValueFor(symbol: string, nqMultiplier: number): number {
  return symbol.startsWith("MNQ") ? nqMultiplier / 10 : nqMultiplier;
}

// Matches fills FIFO, per symbol, into closed round-trip trades. Any fills
// left over at the end (an open position) are not included — those show up
// in the live Positions data instead.
export function matchFillsToTrades(fills: TradovateFill[], multiplier: number): MatchedTrade[] {
  const bySymbol = new Map<string, TradovateFill[]>();
  fills.forEach((f) => {
    if (!bySymbol.has(f.symbolName)) bySymbol.set(f.symbolName, []);
    bySymbol.get(f.symbolName)!.push(f);
  });

  const trades: MatchedTrade[] = [];

  bySymbol.forEach((symbolFills, symbol) => {
    const sorted = [...symbolFills].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    type Lot = { qty: number; price: number; time: string; action: "Buy" | "Sell" };
    const queue: Lot[] = [];

    for (const fill of sorted) {
      let remaining = fill.qty;

      while (remaining > 0 && queue.length > 0 && queue[0].action !== fill.action) {
        const lot = queue[0];
        const matchedQty = Math.min(lot.qty, remaining);
        const side: "long" | "short" = lot.action === "Buy" ? "long" : "short";
        const pointValue = pointValueFor(symbol, multiplier);
        const pnl =
          side === "long"
            ? (fill.price - lot.price) * pointValue * matchedQty
            : (lot.price - fill.price) * pointValue * matchedQty;

        trades.push({
          symbol,
          side,
          entryTime: lot.time,
          exitTime: fill.timestamp,
          entryPrice: lot.price,
          exitPrice: fill.price,
          qty: matchedQty,
          pnl,
        });

        lot.qty -= matchedQty;
        remaining -= matchedQty;
        if (lot.qty === 0) queue.shift();
      }

      if (remaining > 0) {
        queue.push({ qty: remaining, price: fill.price, time: fill.timestamp, action: fill.action });
      }
    }
  });

  return trades.sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());
}
