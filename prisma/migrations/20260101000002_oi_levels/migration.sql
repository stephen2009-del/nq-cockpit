-- AlterTable
ALTER TABLE "PreMarketPrep" ADD COLUMN "openInterestNotes" TEXT;

-- CreateTable
CREATE TABLE "OpenInterestLevel" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "strike" DOUBLE PRECISION NOT NULL,
    "oi" DOUBLE PRECISION NOT NULL,
    "note" TEXT,

    CONSTRAINT "OpenInterestLevel_pkey" PRIMARY KEY ("id")
);
