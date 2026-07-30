// Starts an in-process scheduler that auto-logs a live QQQ/NQ price every
// minute during market hours, using Alpaca's real-time market data
// (https://app.alpaca.markets/connect), so the Intraday Checks table updates
// on its own instead of relying on someone manually re-typing a price.
//
// This relies on the app running as a single, always-on container (Railway,
// 1 replica) rather than a serverless/multi-instance deployment — if this
// app is ever scaled to multiple replicas, this would fire once per
// replica and log duplicate checks. If that changes, move this to a proper
// external scheduler (e.g. Railway's own Cron Job feature, minimum 5-minute
// interval) hitting /api/alpaca/auto-log instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Guards against register() firing more than once (e.g. dev-mode hot
  // reload) and stacking multiple intervals.
  const g = globalThis as unknown as { __intradayAutoLogStarted?: boolean };
  if (g.__intradayAutoLogStarted) return;
  g.__intradayAutoLogStarted = true;

  const { runIntradayAutoLog } = await import("@/lib/intradayAutoLog");

  setInterval(() => {
    runIntradayAutoLog().catch((err) => {
      console.error("Intraday auto-log scheduler tick failed:", err?.message || err);
    });
  }, 60_000);

  console.log("Intraday auto-log scheduler started (every 60s, regular market hours only).");

  // Separate poller: checks real Tradovate position P&L (Live only) every
  // 60s and emails an alert the first time a position's unrealized loss
  // crosses the configured threshold. Deliberately NOT limited to equity
  // market hours like the poller above — this reads Tradovate's own
  // position data directly, which is live whenever NQ itself is
  // tradeable on Globex, including overnight, where nothing else in this
  // app currently has any visibility at all. Built specifically to
  // shrink the gap between a trade going underwater and knowing about
  // it, aimed at the moment before an averaging-down sequence starts.
  const { checkUnrealizedLossAlerts } = await import("@/lib/positionAlert");

  setInterval(() => {
    checkUnrealizedLossAlerts().catch((err) => {
      console.error("Unrealized-loss alert scheduler tick failed:", err?.message || err);
    });
  }, 60_000);

  console.log("Unrealized-loss alert scheduler started (every 60s, Live account, all hours).");

  // Third poller, same 60s cadence: notices a position that appeared
  // directly in Tradovate with no matching order in this app's own log —
  // can't block a trade placed outside the app entirely, but surfaces it
  // within about a minute instead of only finding out from an admission
  // days later.
  const { checkBypassAlerts } = await import("@/lib/positionAlert");

  setInterval(() => {
    checkBypassAlerts().catch((err) => {
      console.error("Bypass-detection scheduler tick failed:", err?.message || err);
    });
  }, 60_000);

  console.log("Bypass-detection scheduler started (every 60s, Live account, all hours).");
}
