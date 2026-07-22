-- AlterTable
ALTER TABLE "TradovateOrderLog"
  ADD COLUMN "stopLossPrice" DOUBLE PRECISION,
  ADD COLUMN "targetPrice" DOUBLE PRECISION;
