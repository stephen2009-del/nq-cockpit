import { prisma } from "@/lib/prisma";

export async function getActiveLockout(env: string) {
  const now = new Date();
  return prisma.tradeLockout.findFirst({
    where: { until: { gt: now }, env },
    orderBy: { until: "desc" },
  });
}

export async function createLockout(env: string, until: Date, reason: string) {
  return prisma.tradeLockout.create({ data: { env, until, reason } });
}
