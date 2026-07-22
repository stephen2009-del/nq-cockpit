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
