-- CreateTable
CREATE TABLE "EmotionalLogEntry" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tag" TEXT,
    "note" TEXT NOT NULL,

    CONSTRAINT "EmotionalLogEntry_pkey" PRIMARY KEY ("id")
);
