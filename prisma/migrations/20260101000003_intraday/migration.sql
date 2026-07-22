-- CreateTable
CREATE TABLE "IntradayCheck" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qqqPrice" DOUBLE PRECISION NOT NULL,
    "nqPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "IntradayCheck_pkey" PRIMARY KEY ("id")
);
