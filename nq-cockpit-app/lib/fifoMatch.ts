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
        const pnl =
          side === "long"
            ? (fill.price - lot.price) * multiplier * matchedQty
            : (lot.price - fill.price) * multiplier * matchedQty;

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
