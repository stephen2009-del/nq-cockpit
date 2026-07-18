export type PositionGuardResult = { blocked: boolean; reason: string | null };

// currentPrice should be the most recent NQ price you have on hand (from an
// Intraday check or today's Pre-Market prep) — this app does not have a live
// market data subscription, so "current price" is only as fresh as the last
// time you logged one in Pre-Market or Intraday.
export function checkAddingToLoser(params: {
  existingNetPos: number; // positive = long, negative = short, 0 = flat
  existingNetPrice: number;
  newOrderSide: "Buy" | "Sell";
  currentPrice: number;
}): PositionGuardResult {
  const { existingNetPos, existingNetPrice, newOrderSide, currentPrice } = params;

  if (existingNetPos === 0) {
    return { blocked: false, reason: null };
  }

  const existingDirection = existingNetPos > 0 ? "long" : "short";
  const newDirection = newOrderSide === "Buy" ? "long" : "short";

  if (newDirection !== existingDirection) {
    // Reducing, closing, or reversing — not "adding", always allowed by this guard.
    return { blocked: false, reason: null };
  }

  const unrealized =
    existingDirection === "long"
      ? currentPrice - existingNetPrice
      : existingNetPrice - currentPrice;

  if (unrealized < 0) {
    return {
      blocked: true,
      reason: `You have an open ${existingDirection} position averaging ${existingNetPrice.toFixed(2)}, currently down ${Math.abs(unrealized).toFixed(2)} pts at ${currentPrice.toFixed(2)}. Adding to a losing position is blocked.`,
    };
  }

  return { blocked: false, reason: null };
}
