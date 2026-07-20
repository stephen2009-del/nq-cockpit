import { prisma } from "@/lib/prisma";

// Returns the most recent valid NQ price from today's Intraday checks,
// falling back to today's Pre-Market prep. Filters out any non-finite
// values (NaN, Infinity) that may already exist in the database from
// before input validation was added, rather than propagating them further.
export async function getLastKnownNqPrice(): Promise<number | null> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const checks = await prisma.intradayCheck.findMany({
    where: { date: { gte: startOfDay } },
    orderBy: { date: "desc" },
  });
  const validCheck = checks.find((c) => Number.isFinite(c.nqPrice));
  if (validCheck) return validCheck.nqPrice;

  const preps = await prisma.preMarketPrep.findMany({
    where: { date: { gte: startOfDay } },
    orderBy: { date: "desc" },
  });
  const validPrep = preps.find((p) => Number.isFinite(p.nqPrice));
  if (validPrep) return validPrep.nqPrice;

  return null;
}
