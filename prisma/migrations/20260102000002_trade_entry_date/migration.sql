-- Adds a separate entry timestamp so hold time (entryDate -> date, which
-- represents exit time for synced trades) can actually be computed in
-- reports. Previously only one timestamp existed per trade, so hold time
-- was never knowable at all. Nullable + IF NOT EXISTS: existing trades
-- (manual entries, and anything synced before this) simply won't have a
-- hold time available, rather than backfilling a guessed value.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "entryDate" TIMESTAMP(3);
