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

function currentEtMinutes(now: Date): number {
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
  if (etWeekday === "Sat" || etWeekday === "Sun") {
    return { allowed: false, reason: `Markets are closed on weekends (${etWeekday}).`, etLabel };
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
  if (current >= cutoff) {
    return {
      allowed: false,
      reason: `Within the final ${settings.cutoffMinutesBeforeClose} minutes before close — cutoff was ${minutesToLabel(cutoff)} ET.`,
      etLabel,
    };
  }
  if (current >= end) {
    return { allowed: false, reason: `Outside your trading window — closed at ${minutesToLabel(end)} ET.`, etLabel };
  }
  return { allowed: true, reason: `Trading window open until ${minutesToLabel(cutoff)} ET.`, etLabel };
}
