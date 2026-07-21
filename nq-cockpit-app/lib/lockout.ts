import { prisma } from "@/lib/prisma";

export async function getActiveLockout() {
  const now = new Date();
  return prisma.tradeLockout.findFirst({
    where: { until: { gt: now } },
    orderBy: { until: "desc" },
  });
}

export async function createLockout(until: Date, reason: string) {
  return prisma.tradeLockout.create({ data: { until, reason } });
}
