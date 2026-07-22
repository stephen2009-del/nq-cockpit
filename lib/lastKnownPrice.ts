import { prisma } from "@/lib/prisma";

const FRESHNESS_MINUTES = 10;

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

// Same lookup, but also reports how old the price actually is — used
// anywhere the number is displayed to a person, so staleness is visible
// instead of presented as if it were current.
export async function getLastKnownNqPriceWithAge(): Promise<{ price: number; timestamp: Date; ageMinutes: number } | null> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const checks = await prisma.intradayCheck.findMany({
    where: { date: { gte: startOfDay } },
    orderBy: { date: "desc" },
  });
  const validCheck = checks.find((c) => Number.isFinite(c.nqPrice));
  if (validCheck) {
    return { price: validCheck.nqPrice, timestamp: validCheck.date, ageMinutes: (now.getTime() - validCheck.date.getTime()) / 60000 };
  }

  const preps = await prisma.preMarketPrep.findMany({
    where: { date: { gte: startOfDay } },
    orderBy: { date: "desc" },
  });
  const validPrep = preps.find((p) => Number.isFinite(p.nqPrice));
  if (validPrep) {
    return { price: validPrep.nqPrice, timestamp: validPrep.date, ageMinutes: (now.getTime() - validPrep.date.getTime()) / 60000 };
  }

  return null;
}

// STRICT version used by the order guard: only accepts an Intraday check
// (never Pre-Market — that's from before the session started and could be
// hours stale by definition), and only if logged within the last
// FRESHNESS_MINUTES. Returns null if there's nothing fresh enough, which the
// guard treats as "cannot verify" and blocks rather than guesses.
export async function getFreshIntradayPrice(): Promise<{ price: number; ageMinutes: number } | null> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - FRESHNESS_MINUTES * 60000);

  const checks = await prisma.intradayCheck.findMany({
    where: { date: { gte: cutoff } },
    orderBy: { date: "desc" },
  });
  const validCheck = checks.find((c) => Number.isFinite(c.nqPrice));
  if (!validCheck) return null;

  return { price: validCheck.nqPrice, ageMinutes: (now.getTime() - validCheck.date.getTime()) / 60000 };
}

export { FRESHNESS_MINUTES };
