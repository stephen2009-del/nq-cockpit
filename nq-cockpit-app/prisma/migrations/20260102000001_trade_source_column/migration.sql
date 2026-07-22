-- Ensures the "source" column exists regardless of whether the earlier
-- (previously stuck) migration actually applied it successfully — safe to
-- run even if the column is already there.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
