-- Two changes:
-- 1. Trading Window Guard now applies to both Demo and Live (enforced in
--    app code, not schema) — Demo was previously exempt on the theory
--    that practice trades shouldn't be time-gated, but that made it an
--    easy way to sidestep the restriction when testing outside the
--    intended window actually mattered.
-- 2. Updates the actual configured window to 10:05 AM - 2:55 PM ET, with
--    zero opening buffer / cutoff so the effective allowed window is
--    exactly that range, not narrowed further by the old buffers.
UPDATE "Settings"
SET "tradingWindowStart" = '10:05',
    "tradingWindowEnd" = '14:55',
    "cutoffMinutesBeforeClose" = 0,
    "openingBufferMinutes" = 0
WHERE "id" = 1;
