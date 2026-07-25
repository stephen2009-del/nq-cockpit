-- Hard caps on adding to an already-open same-direction position — a
-- deterministic max-contracts limit and a minimum cooldown between
-- same-direction entries, built after a week's report showed up to 11
-- concurrent longs stacked with a ~1-minute median gap between adds.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "maxConcurrentAdds" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "addOnCooldownMinutes" INTEGER NOT NULL DEFAULT 3;
