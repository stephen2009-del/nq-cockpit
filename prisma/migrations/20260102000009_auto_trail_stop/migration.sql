-- Adds continuous Auto Trail support to Automatic Stop Management,
-- mirroring Tradovate's own ATM Auto Trail template (Stop Loss / Profit
-- Trigger / Frequency) rather than the previous single one-shot move.
ALTER TABLE "StopManagementRule" ALTER COLUMN "newStopOffset" DROP NOT NULL;
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'oneshot';
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "trailAmount" DOUBLE PRECISION;
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "checkFrequency" DOUBLE PRECISION;
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "lastRatchetPrice" DOUBLE PRECISION;
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "ratchetCount" INTEGER NOT NULL DEFAULT 0;
