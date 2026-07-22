-- CreateTable
CREATE TABLE "StopManagementRule" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "env" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "qty" INTEGER NOT NULL,
    "triggerOffset" DOUBLE PRECISION NOT NULL,
    "newStopOffset" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "triggeredAt" TIMESTAMP(3),
    "newStopPrice" DOUBLE PRECISION,
    "verified" BOOLEAN,
    "detail" TEXT,

    CONSTRAINT "StopManagementRule_pkey" PRIMARY KEY ("id")
);
