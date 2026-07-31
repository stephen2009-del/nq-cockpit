-- Blocks ANY new order (any symbol, any direction) for N minutes after a
-- realized loss of this size or worse — journal entries described
-- "Tilted / Revenge" behavior not limited to averaging into the same
-- losing position. 0 disables it.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "postLossCooldownMinutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "postLossCooldownThreshold" DOUBLE PRECISION NOT NULL DEFAULT 300;
