function getEtOffsetString(date: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const offsetPart = dtf.formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT-5";
  const match = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = match ? parseInt(match[1], 10) : -5;
  const sign = offsetHours <= 0 ? "-" : "+";
  const abs = String(Math.abs(offsetHours)).padStart(2, "0");
  return `${sign}${abs}:00`;
}

// Builds a proper UTC Date object for a given "HH:MM" time on *today's* date,
// as measured in US Eastern time (handles EST/EDT automatically).
export function etTimeTodayToUtc(hhmm: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const offset = getEtOffsetString(now);
  return new Date(`${y}-${m}-${d}T${hhmm}:00${offset}`);
}

export type TradingWindowSettings = {
  tradingWindowStart: string; // "09:30"
  tradingWindowEnd: string; // "16:00"
  cutoffMinutesBeforeClose: number; // 65
  openingBufferMinutes: number; // 10
};

// A "trading day" runs 6pm ET to 6pm ET the next calendar day — matching
// CME Globex's actual session rollover, not midnight. E.g. a trade at
// 11pm ET Wednesday belongs to "Thursday's" trading day, same as a trade
// at 3pm ET Thursday — both before the *next* 6pm ET rollover.

// Returns a stable "YYYY-MM-DD" key for grouping/comparing which trading
// day a given timestamp falls into.
// A "trading week" runs Sunday 6pm ET (Globex's weekly reopen) through
// Friday 1pm ET — not the standard Mon-Fri calendar week. Returns the
// Sunday calendar date (ET, as "YYYY-MM-DD") that started the week
// containing the given timestamp, same style as tradingDayKey above.
// Shared between the client Reports tab and the server-side weekly-report
// cron, rather than duplicated — unlike tradingDayKey/tradingDayStart's
// usual pattern of being re-implemented per-route, this one's identical
// logic in both places so it lives in one spot.
export function weekStartKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(date);
  const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const m = parseInt(parts.find((p) => p.type === "month")!.value, 10);
  const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);
  let hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  if (hour === 24) hour = 0;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekdayIdx = weekdayMap[parts.find((p) => p.type === "weekday")!.value] ?? 0;
  const dayDate = new Date(Date.UTC(y, m - 1, d));
  const daysBack = weekdayIdx === 0 && hour < 18 ? 7 : weekdayIdx;
  dayDate.setUTCDate(dayDate.getUTCDate() - daysBack);
  return dayDate.toISOString().slice(0, 10);
}

// The actual UTC instant of the Sunday-6pm-ET rollover that started the
// trading week containing `now` — for server-side date-range queries,
// mirroring tradingDayStart's role for a single day.
export function weekStart(now: Date = new Date()): Date {
  const key = weekStartKey(now);
  const [y, m, d] = key.split("-").map(Number);
  const offset = getEtOffsetString(new Date(Date.UTC(y, m - 1, d)));
  return new Date(`${key}T18:00:00${offset}`);
}

export function tradingDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(date);
  const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const m = parseInt(parts.find((p) => p.type === "month")!.value, 10);
  const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);
  let hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  if (hour === 24) hour = 0; // some environments report midnight as "24"
  const dayDate = new Date(Date.UTC(y, m - 1, d));
  if (hour >= 18) dayDate.setUTCDate(dayDate.getUTCDate() + 1);
  return dayDate.toISOString().slice(0, 10);
}

// Returns the actual UTC timestamp marking the start of the *current*
// trading day (the most recent 6pm ET rollover) — for server-side
// date-range queries (WHERE date >= tradingDayStart).
export function tradingDayStart(now: Date = new Date()): Date {
  const todaySixPm = etTimeTodayToUtc("18:00", now);
  if (now.getTime() >= todaySixPm.getTime()) return todaySixPm;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return etTimeTodayToUtc("18:00", yesterday);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function currentEtMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return h * 60 + m;
}

function minutesToLabel(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export function getTradingWindowStatus(
  settings: TradingWindowSettings,
  now: Date = new Date()
): { allowed: boolean; reason: string; etLabel: string } {
  const current = currentEtMinutes(now);
  const start = toMinutes(settings.tradingWindowStart);
  const end = toMinutes(settings.tradingWindowEnd);
  const cutoff = end - settings.cutoffMinutesBeforeClose;
  const effectiveStart = start + (settings.openingBufferMinutes || 0);
  const etLabel = minutesToLabel(current);

  const etWeekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  if (etWeekday === "Sat") {
    return { allowed: false, reason: `Markets are closed on Saturday.`, etLabel };
  }

  if (current < start) {
    return {
      allowed: false,
      reason: `Before your trading window (Globex/overnight session) — opens at ${minutesToLabel(start)} ET.`,
      etLabel,
    };
  }
  if (current < effectiveStart) {
    return {
      allowed: false,
      reason: `Within the first ${settings.openingBufferMinutes} minutes after the open — trading allowed starting ${minutesToLabel(effectiveStart)} ET.`,
      etLabel,
    };
  }
  if (current >= end) {
    return { allowed: false, reason: `Outside your trading window — closed at ${minutesToLabel(end)} ET. Opens again at ${minutesToLabel(effectiveStart)} ET.`, etLabel };
  }
  if (current >= cutoff) {
    return {
      allowed: false,
      reason: `Within the final ${settings.cutoffMinutesBeforeClose} minutes before close — cutoff was ${minutesToLabel(cutoff)} ET.`,
      etLabel,
    };
  }
  return { allowed: true, reason: `Trading window open until ${minutesToLabel(cutoff)} ET.`, etLabel };
}
