-- AlterTable
ALTER TABLE "Trade" ALTER COLUMN "disciplined" DROP NOT NULL;
ALTER TABLE "Trade" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Trade" ADD COLUMN "syncKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Trade_syncKey_key" ON "Trade"("syncKey");
