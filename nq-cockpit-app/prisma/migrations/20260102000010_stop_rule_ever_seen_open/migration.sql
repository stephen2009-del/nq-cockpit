-- Distinguishes "this order hasn't filled yet" from "the position
-- closed" — without this, a resting Limit order that simply hasn't
-- filled yet was being misread as an already-closed position on the
-- very first check, cancelling Auto Trail/Fixed Move rules that never
-- actually had anything to track yet.
ALTER TABLE "StopManagementRule" ADD COLUMN IF NOT EXISTS "everSeenOpen" BOOLEAN NOT NULL DEFAULT false;
