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

  // Fourth poller: Automatic Stop Management — both the one-shot
  // breakeven-style move and continuous Auto Trail ratcheting. Previously
  // only externally-triggerable, meaning a trailing stop was only as
  // responsive as whatever cron schedule was pinging it; wiring it into
  // the same 60s in-process loop as everything else makes it actually
  // behave like Tradovate's own ATM Auto Trail, checked continuously
  // rather than on an external schedule someone has to remember to set up.
  const { checkStopRules } = await import("@/lib/stopRuleCheck");

  setInterval(() => {
    checkStopRules().catch((err) => {
      console.error("Stop-rule check scheduler tick failed:", err?.message || err);
    });
  }, 60_000);

  console.log("Stop-rule (Automatic Stop Management / Auto Trail) scheduler started (every 60s).");

  // Fifth poller: automatically pulls Tradovate fills and FIFO-matches
  // them into Trade records — replacing the manual "Sync to Journal"
  // click on the TV Analytics tab, which was an easy step to forget and
  // meant reports/analysis silently had nothing to show for a day's real
  // trading until someone remembered to click it.
  const { autoSyncTrades } = await import("@/lib/autoSync");

  setInterval(() => {
    autoSyncTrades().catch((err) => {
      console.error("Auto-sync scheduler tick failed:", err?.message || err);
    });
  }, 60_000);

  console.log("Trade auto-sync scheduler started (every 60s, both Demo and Live).");
}
