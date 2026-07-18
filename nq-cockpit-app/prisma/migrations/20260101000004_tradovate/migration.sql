-- AlterTable
ALTER TABLE "Settings"
  ADD COLUMN "tradingWindowStart" TEXT NOT NULL DEFAULT '09:30',
  ADD COLUMN "tradingWindowEnd" TEXT NOT NULL DEFAULT '16:00',
  ADD COLUMN "cutoffMinutesBeforeClose" INTEGER NOT NULL DEFAULT 65,
  ADD COLUMN "tradovateEnv" TEXT NOT NULL DEFAULT 'demo';

-- CreateTable
CREATE TABLE "TradovateOrderLog" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "env" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "orderType" TEXT NOT NULL,
    "limitPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "blockedReason" TEXT,
    "tradovateOrderId" TEXT,
    "rawResponse" JSONB,

    CONSTRAINT "TradovateOrderLog_pkey" PRIMARY KEY ("id")
);
