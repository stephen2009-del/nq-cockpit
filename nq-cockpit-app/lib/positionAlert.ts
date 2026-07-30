import { getPositions, getContractName, extractPositionPnl, getCashBalance, extractAccountOpenPnl, getAccounts } from "@/lib/tradovate";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

// In-memory, per-process state tracking which specific position "openings"
// have already triggered an alert, so a position sitting underwater
// doesn't re-email on every single poll tick — only once per crossing.
// Keyed loosely by contract + entry price rather than a database row,
// since Tradovate positions aren't a "record" this app owns; if the
// process restarts, a still-open underwater position will alert again
// once — treated as an acceptable tradeoff for staying simple, given the
// whole point of this feature is "better a duplicate alert than a missed
// one."
const alertedPositions = new Set<string>();

// Live only, deliberately — same reasoning as the Emotional Journal
// scoping: this is about real trading risk, not Demo practice. Runs
// independent of equity market hours (unlike the Alpaca-based intraday
// price poller) since it reads Tradovate's own position data directly,
// which is live whenever NQ itself is tradeable on Globex — including
// overnight, where nothing else in this app currently has any visibility
// at all.
export async function checkUnrealizedLossAlerts(): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return;
  const threshold = Math.abs(settings.unrealizedLossAlertThreshold || 0);
  if (threshold <= 0) return; // 0 = feature disabled

  const to = process.env.REPORT_EMAIL;
  if (!to) return;

  const env = "live" as const;
  let accountId: number | null = settings.liveAccountId ? parseInt(settings.liveAccountId) : null;
  if (!accountId) {
    const accountsResult = await getAccounts(env);
    if (accountsResult.ok && Array.isArray(accountsResult.body) && accountsResult.body.length === 1) {
      accountId = accountsResult.body[0].id;
    }
  }
  if (!accountId) return; // ambiguous or unconfigured — nothing safe to check

  const result = await getPositions(env, accountId);
  if (!result.ok || !Array.isArray(result.body)) return;

  const open = result.body.filter((p: any) => p.netPos && p.netPos !== 0);
  const stillOpenKeys = new Set<string>();

  for (const p of open) {
    const key = `${accountId}:${p.contractId}:${p.netPrice}`;
    stillOpenKeys.add(key);

    // Real Tradovate P&L only — no estimated/derived fallback here. An
    // alert about money at risk should never be based on a guess; if the
    // real number isn't available this tick, it just gets checked again
    // next tick rather than firing on a possibly-wrong estimate.
    let pnl: number | null = extractPositionPnl(p);
    if (pnl === null) {
      const cashResult = await getCashBalance(env, accountId);
      if (cashResult.ok) pnl = extractAccountOpenPnl(cashResult.body);
    }
    if (pnl === null) continue;

    if (pnl <= -threshold && !alertedPositions.has(key)) {
      alertedPositions.add(key);
      const contract = await getContractName(env, p.contractId);
      const symbol = contract.ok ? contract.body.name || String(p.contractId) : String(p.contractId);
      const direction = p.netPos > 0 ? "LONG" : "SHORT";

      try {
        await sendEmail({
          to,
          subject: `\u26a0 NQ Cockpit — ${symbol} down $${Math.abs(pnl).toFixed(2)} unrealized`,
          html: `
            <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
              <h2 style="color:#E5484D;margin:0 0 10px;">\u26a0 Unrealized Loss Alert</h2>
              <p style="font-size:16px;margin:0 0 6px;">${symbol} (${direction} ${Math.abs(p.netPos)}) is down
                <b style="color:#E5484D;">$${Math.abs(pnl).toFixed(2)}</b> unrealized right now.</p>
              <p style="color:#7F8CA6;font-size:12px;margin:0;">Entry: ${p.netPrice} &middot; Alert threshold: $${threshold.toFixed(2)}</p>
              <p style="color:#7F8CA6;font-size:12px;margin-top:16px;">This is a live-position check, independent of today's report — it exists to shrink the time between a trade going underwater and you knowing about it.</p>
            </div>
          `,
        });
        console.log(`[LOSS-ALERT] Sent unrealized loss alert: ${symbol} ${direction} down $${Math.abs(pnl).toFixed(2)} (threshold $${threshold})`);
      } catch (err: any) {
        console.error("[LOSS-ALERT] Failed to send alert email:", err.message || err);
        // Don't leave it marked as alerted if the email genuinely failed
        // to send — better to retry next tick than silently miss it.
        alertedPositions.delete(key);
      }
    }
  }

  // Clear the "already alerted" flag for anything no longer open, so a
  // fresh position at the same price level in the future can alert again.
  for (const key of Array.from(alertedPositions)) {
    if (!stillOpenKeys.has(key)) alertedPositions.delete(key);
  }
}

// In-memory snapshot of which contracts were open as of the last poll
// tick (~60s ago), used to detect a position that's NEW since then rather
// than trying to reconcile a long-open position's entire history — much
// more reliable than guessing from position size alone, and avoids
// false positives on positions that have been open (and already checked)
// for a while.
let previousOpenPositionKeys: Set<string> = new Set();

// Detects a position that appeared directly in Tradovate, bypassing this
// app's own Trade Ticket entirely — the other real gap named directly:
// "I go to Tradovate and trade." This can't block that (nothing here sits
// between the trader and Tradovate's own interface), but it can notice it
// within about a minute instead of finding out days later from an
// admission. A newly-opened position with no matching SUBMITTED order in
// this app's own log, in a generous 10-minute window, is treated as
// placed outside the app.
export async function checkBypassAlerts(): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return;

  const to = process.env.REPORT_EMAIL;
  if (!to) return;

  const env = "live" as const;
  let accountId: number | null = settings.liveAccountId ? parseInt(settings.liveAccountId) : null;
  if (!accountId) {
    const accountsResult = await getAccounts(env);
    if (accountsResult.ok && Array.isArray(accountsResult.body) && accountsResult.body.length === 1) {
      accountId = accountsResult.body[0].id;
    }
  }
  if (!accountId) return;

  const result = await getPositions(env, accountId);
  if (!result.ok || !Array.isArray(result.body)) return;

  const open = result.body.filter((p: any) => p.netPos && p.netPos !== 0);
  const currentKeys = new Set<string>();

  for (const p of open) {
    const key = `${accountId}:${p.contractId}`;
    currentKeys.add(key);
    if (previousOpenPositionKeys.has(key)) continue; // was already open last tick — not new

    const contract = await getContractName(env, p.contractId);
    const symbol = contract.ok ? contract.body.name || String(p.contractId) : String(p.contractId);
    const side = p.netPos > 0 ? "Buy" : "Sell";

    const matchingOrder = await prisma.tradovateOrderLog.findFirst({
      where: {
        env,
        symbol,
        side,
        status: "SUBMITTED",
        date: { gte: new Date(Date.now() - 10 * 60_000) },
      },
    });

    if (!matchingOrder) {
      try {
        await sendEmail({
          to,
          subject: `\u26a0 NQ Cockpit — new ${symbol} position not placed through the app`,
          html: `
            <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
              <h2 style="color:#F5A623;margin:0 0 10px;">\u26a0 Position Opened Outside NQ Cockpit</h2>
              <p style="font-size:16px;margin:0 0 6px;">A new ${symbol} ${side === "Buy" ? "LONG" : "SHORT"} (${Math.abs(p.netPos)}) just appeared on your Live account with no matching order in this app's own log.</p>
              <p style="color:#7F8CA6;font-size:12px;margin:0;">Entry: ${p.netPrice}</p>
              <p style="color:#7F8CA6;font-size:12px;margin-top:16px;">This doesn't mean anything went wrong technically — it just means this trade was placed directly in Tradovate, so none of this app's guards (concurrency cap, cooldown, fat-finger check) had a chance to run on it.</p>
            </div>
          `,
        });
        console.log(`[BYPASS-ALERT] New ${symbol} position with no matching order log entry — likely placed directly in Tradovate.`);
      } catch (err: any) {
        console.error("[BYPASS-ALERT] Failed to send alert email:", err.message || err);
      }
    }
  }

  previousOpenPositionKeys = currentKeys;
}
