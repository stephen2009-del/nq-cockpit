-- Real-time unrealized-loss alert threshold — built after a specific
-- admitted pattern (trade goes against the trader, they disable
-- Tradovate's own daily loss limit directly, then add to the loser).
-- 0 disables the check entirely.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "unrealizedLossAlertThreshold" DOUBLE PRECISION NOT NULL DEFAULT 500;
