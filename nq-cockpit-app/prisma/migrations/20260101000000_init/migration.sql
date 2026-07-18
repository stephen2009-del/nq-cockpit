-- CreateTable
CREATE TABLE "Rule" (
    "id" SERIAL NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "entry" DOUBLE PRECISION,
    "exit" DOUBLE PRECISION,
    "size" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION NOT NULL,
    "setup" TEXT,
    "emotion" TEXT,
    "notes" TEXT,
    "disciplined" BOOLEAN NOT NULL,
    "checklistSnapshot" JSONB NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "dailyLossLimit" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "contract" TEXT NOT NULL DEFAULT 'NQ',
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 20,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- Seed default settings row and default checklist rules
INSERT INTO "Settings" ("id", "dailyLossLimit", "contract", "multiplier") VALUES (1, 500, 'NQ', 20);

INSERT INTO "Rule" ("text", "order") VALUES
('Aligned with higher-timeframe bias', 0),
('Waited for valid confirmation signal', 1),
('Stop-loss defined before entry', 2),
('Position size follows my risk plan', 3),
('Not in cooldown after a prior loss', 4),
('Still under today''s max loss limit', 5),
('This is not a chase / FOMO entry', 6);
