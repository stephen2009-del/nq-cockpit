-- Captures why an order was an "add" to an already-open same-direction
-- position, prompted for at order time in the Trade Ticket. Synced
-- Tradovate fills otherwise carry zero self-reported context (unlike
-- manually-logged Journal entries with their checklist/emotion fields),
-- which made add-on clusters impossible to explain after the fact.
ALTER TABLE "TradovateOrderLog" ADD COLUMN IF NOT EXISTS "addReason" TEXT;
