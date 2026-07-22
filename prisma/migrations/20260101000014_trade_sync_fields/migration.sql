-- AlterTable
ALTER TABLE "Trade" ALTER COLUMN "disciplined" DROP NOT NULL;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "syncKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Trade_syncKey_key" ON "Trade"("syncKey");
