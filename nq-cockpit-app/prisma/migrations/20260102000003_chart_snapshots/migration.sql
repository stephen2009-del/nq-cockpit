-- Stores chart screenshots (e.g. from Thinkorswim) uploaded during the day
-- as a reminder of good/bad trades. Image stored as base64 text directly in
-- Postgres for simplicity (no external file storage service) — the app
-- resizes/compresses images client-side before upload specifically so this
-- doesn't grow unbounded.
CREATE TABLE IF NOT EXISTS "ChartSnapshot" (
  "id" SERIAL PRIMARY KEY,
  "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "imageData" TEXT NOT NULL
);
