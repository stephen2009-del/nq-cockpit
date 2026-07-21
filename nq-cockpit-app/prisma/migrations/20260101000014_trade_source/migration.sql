-- AlterTable
ALTER TABLE "Trade" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Trade" ADD COLUMN "externalRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Trade_externalRef_key" ON "Trade"("externalRef");
