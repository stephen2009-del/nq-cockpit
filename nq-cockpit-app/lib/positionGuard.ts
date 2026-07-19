export type PositionGuardResult = { blocked: boolean; reason: string | null };

// If Tradovate gives us a direct, already-computed P&L for the position (or
// the account), that's used first — it's the broker's own number, more
// trustworthy than anything derived from a manually logged price. The
// logged-price comparison only kicks in when Tradovate doesn't expose one.
export function checkAddingToLoser(params: {
  existingNetPos: number; // positive = long, negative = short, 0 = flat
  existingNetPrice: number;
  newOrderSide: "Buy" | "Sell";
  currentPrice?: number;
  directPnl?: number | null;
  pnlSource?: "position" | "account" | "logged_price";
}): PositionGuardResult {
  const { existingNetPos, existingNetPrice, newOrderSide, currentPrice, directPnl, pnlSource } = params;

  if (existingNetPos === 0) {
    return { blocked: false, reason: null };
  }

  const existingDirection = existingNetPos > 0 ? "long" : "short";
  const newDirection = newOrderSide === "Buy" ? "long" : "short";

  if (newDirection !== existingDirection) {
    // Reducing, closing, or reversing — not "adding", always allowed by this guard.
    return { blocked: false, reason: null };
  }

  let unrealized: number;
  let sourceLabel: string;

  if (directPnl !== undefined && directPnl !== null) {
    unrealized = directPnl;
    sourceLabel = pnlSource === "account" ? "Tradovate account-level P&L" : "Tradovate's own position P&L";
  } else if (currentPrice !== undefined) {
    unrealized = existingDirection === "long" ? currentPrice - existingNetPrice : existingNetPrice - currentPrice;
    sourceLabel = `your last logged price (${currentPrice.toFixed(2)}) — not live Tradovate data`;
  } else {
    // No data at all to judge this by — don't block on a guess.
    return { blocked: false, reason: null };
  }

  if (unrealized < 0) {
    return {
      blocked: true,
      reason: `You have an open ${existingDirection} position averaging ${existingNetPrice.toFixed(2)}, currently down ${Math.abs(unrealized).toFixed(2)} (via ${sourceLabel}). Adding to a losing position is blocked.`,
    };
  }

  return { blocked: false, reason: null };
}
