-- Lets you pin a specific account per environment (e.g. Live has two
-- accounts, only one of which is actually active) instead of either
-- hardcoding an account number in the app's code, or being forced to
-- manually re-pick it on every page whenever more than one account exists.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "liveAccountId" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "demoAccountId" TEXT;
