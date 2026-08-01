import { prisma } from "@/lib/prisma";
import {
  findOpenPosition,
  extractPositionPnl,
  getCashBalance,
  extractAccountOpenPnl,
  findWorkingStopOrder,
  modifyStopOrder,
  getOrderById,
} from "@/lib/tradovate";
import { sendEmail } from "@/lib/email";
import { tradingDayStart } from "@/lib/tradingWindow";

// Shared by the manual /api/tradovate/stop-rules/check route and the
// in-process 60s poller (instrumentation.ts) — one implementation, two
// ways to trigger it, same pattern as the other pollers in this app.
export async function checkStopRules(): Promise<{ checked: number; results: any[] }> {
  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) settings = await prisma.settings.create({ data: { id: 1 } });

  const activeRules = await prisma.stopManagementRule.findMany({ where: { status: "active" } });
  const results: any[] = [];

  for (const rule of activeRules) {
    try {
      const env = rule.env as "demo" | "live";

      // Step 1 — figure out the current implied price. Prefer Tradovate's
      // own P&L numbers over anything manually logged, same priority order
      // as the "no adding to losers" guard.
      const position = await findOpenPosition(env, rule.accountId, rule.symbol);
      if (!position) {
        // Two very different situations look identical here: a resting
        // Limit order that simply hasn't filled yet (never had a
        // position — keep waiting, don't give up), vs. a position that
        // WAS open and has since closed (genuinely done, stop checking).
        // everSeenOpen is what tells them apart.
        if (rule.mode === "trail" && rule.everSeenOpen) {
          await prisma.stopManagementRule.update({
            where: { id: rule.id },
            data: { status: "cancelled", detail: "Position closed — trail stopped checking." },
          });
          results.push({ ruleId: rule.id, skipped: "position closed, rule cancelled" });
        } else {
          results.push({ ruleId: rule.id, skipped: "no open position yet — order may still be resting/unfilled, will keep checking" });
        }
        continue;
      }

      if (!rule.everSeenOpen) {
        await prisma.stopManagementRule.update({ where: { id: rule.id }, data: { everSeenOpen: true } });
        rule.everSeenOpen = true;
      }

      let directPnl = extractPositionPnl(position);
      if (directPnl === null) {
        const cashResult = await getCashBalance(env, rule.accountId);
        if (cashResult.ok) directPnl = extractAccountOpenPnl(cashResult.body);
      }

      let impliedPrice: number | null = null;
      if (directPnl !== null) {
        const perPoint = settings.multiplier * rule.qty;
        impliedPrice = rule.direction === "long"
          ? rule.entryPrice + directPnl / perPoint
          : rule.entryPrice - directPnl / perPoint;
      } else {
        const now = new Date();
        const startOfDay = tradingDayStart(now);
        const lastCheck = await prisma.intradayCheck.findFirst({ where: { date: { gte: startOfDay } }, orderBy: { date: "desc" } });
        impliedPrice = lastCheck?.nqPrice ?? null;
      }

      if (impliedPrice === null) {
        results.push({ ruleId: rule.id, skipped: "no price data available (no Tradovate P&L and no logged price)" });
        continue;
      }

      if (rule.mode === "trail") {
        await checkTrailRule(rule, env, impliedPrice, results);
      } else {
        await checkOneshotRule(rule, env, impliedPrice, results);
      }
    } catch (err: any) {
      console.error(`Stop rule ${rule.id} check failed:`, err.message || err);
      results.push({ ruleId: rule.id, error: err.message || String(err) });
    }
  }

  return { checked: activeRules.length, results };
}

async function checkOneshotRule(rule: any, env: "demo" | "live", impliedPrice: number, results: any[]) {
  const triggered = rule.direction === "long"
    ? impliedPrice >= rule.entryPrice + rule.triggerOffset
    : impliedPrice <= rule.entryPrice - rule.triggerOffset;

  if (!triggered) {
    results.push({ ruleId: rule.id, skipped: `not triggered yet (implied price ${impliedPrice.toFixed(2)})` });
    return;
  }

  const stopOrder = await findWorkingStopOrder(env, rule.accountId, rule.symbol);
  if (!stopOrder) {
    await prisma.stopManagementRule.update({
      where: { id: rule.id },
      data: { status: "failed", triggeredAt: new Date(), detail: "Triggered, but no working stop order was found to modify." },
    });
    results.push({ ruleId: rule.id, failed: "no working stop order found" });
    return;
  }

  const newStopPrice = rule.direction === "long" ? rule.entryPrice + (rule.newStopOffset ?? 0) : rule.entryPrice - (rule.newStopOffset ?? 0);
  const { verified, actualStopPrice } = await modifyAndVerify(env, stopOrder, newStopPrice, rule.qty);

  await prisma.stopManagementRule.update({
    where: { id: rule.id },
    data: {
      status: "triggered",
      triggeredAt: new Date(),
      newStopPrice,
      verified,
      detail: verified
        ? `Stop moved and verified at ${actualStopPrice}.`
        : `WARNING: modify request was sent but verification found the stop still at ${actualStopPrice ?? "unknown"}, not the requested ${newStopPrice}. Check Tradovate directly immediately.`,
    },
  });

  await notify(rule, verified, newStopPrice, actualStopPrice);
  results.push({ ruleId: rule.id, triggered: true, verified, newStopPrice });
}

async function checkTrailRule(rule: any, env: "demo" | "live", impliedPrice: number, results: any[]) {
  const profit = rule.direction === "long" ? impliedPrice - rule.entryPrice : rule.entryPrice - impliedPrice;

  if (profit < rule.triggerOffset) {
    results.push({ ruleId: rule.id, skipped: `trail not active yet (profit ${profit.toFixed(2)} pts, needs ${rule.triggerOffset})` });
    return;
  }

  // Best (most favorable) price seen since the trail activated — a long's
  // "best" is the highest price, a short's is the lowest. Never moves
  // backward even if price pulls back afterward, same as a real trailing
  // stop only ever tightening, never loosening.
  const priorBest = rule.lastRatchetPrice ?? rule.entryPrice;
  const currentBest = rule.direction === "long" ? Math.max(priorBest, impliedPrice) : Math.min(priorBest, impliedPrice);
  const advancedSinceLastRatchet = Math.abs(currentBest - priorBest);

  if (rule.lastRatchetPrice !== null && advancedSinceLastRatchet < (rule.checkFrequency ?? 0)) {
    results.push({ ruleId: rule.id, skipped: `waiting for next ${rule.checkFrequency}-pt step (advanced ${advancedSinceLastRatchet.toFixed(2)} so far)` });
    return;
  }

  const idealStop = rule.direction === "long" ? currentBest - (rule.trailAmount ?? 0) : currentBest + (rule.trailAmount ?? 0);

  const stopOrder = await findWorkingStopOrder(env, rule.accountId, rule.symbol);
  if (!stopOrder) {
    await prisma.stopManagementRule.update({
      where: { id: rule.id },
      data: { status: "failed", triggeredAt: new Date(), detail: "Trail activated, but no working stop order was found to modify." },
    });
    results.push({ ruleId: rule.id, failed: "no working stop order found" });
    return;
  }

  const currentStop = stopOrder.stopPrice ?? stopOrder.price;
  // Never loosen — only ratchet if the ideal stop is actually more
  // favorable than where the stop already sits.
  const wouldImprove = typeof currentStop !== "number" || (rule.direction === "long" ? idealStop > currentStop : idealStop < currentStop);
  if (!wouldImprove) {
    results.push({ ruleId: rule.id, skipped: `ideal stop ${idealStop.toFixed(2)} would not improve on current stop ${currentStop}` });
    return;
  }

  const { verified, actualStopPrice } = await modifyAndVerify(env, stopOrder, idealStop, rule.qty);

  await prisma.stopManagementRule.update({
    where: { id: rule.id },
    data: {
      triggeredAt: new Date(),
      newStopPrice: idealStop,
      lastRatchetPrice: currentBest,
      ratchetCount: rule.ratchetCount + 1,
      verified,
      detail: verified
        ? `Ratchet #${rule.ratchetCount + 1}: stop moved to ${idealStop.toFixed(2)} (trailing ${rule.trailAmount} behind ${currentBest.toFixed(2)}).`
        : `WARNING: ratchet #${rule.ratchetCount + 1} modify request sent but verification found the stop still at ${actualStopPrice ?? "unknown"}, not ${idealStop.toFixed(2)}. Check Tradovate directly.`,
    },
  });

  await notify(rule, verified, idealStop, actualStopPrice, rule.ratchetCount + 1);
  results.push({ ruleId: rule.id, ratcheted: true, verified, newStopPrice: idealStop, ratchetCount: rule.ratchetCount + 1 });
}

async function modifyAndVerify(env: "demo" | "live", stopOrder: any, newStopPrice: number, fallbackQty?: number) {
  // MANDATORY verification — never trust the modify response alone.
  // Tradovate's own community has documented cases where it reports
  // success without the order actually changing.
  await modifyStopOrder(env, stopOrder.id, stopOrder.orderQty ?? fallbackQty, newStopPrice);
  const verifyResult = await getOrderById(env, stopOrder.id);
  const actualStopPrice = verifyResult.ok ? (verifyResult.body.stopPrice ?? verifyResult.body.price) : null;
  const verified = actualStopPrice !== null && Math.abs(actualStopPrice - newStopPrice) < 0.01;
  return { verified, actualStopPrice };
}

async function notify(rule: any, verified: boolean, newStopPrice: number, actualStopPrice: number | null, ratchetCount?: number) {
  if (!process.env.REPORT_EMAIL || !process.env.RESEND_API_KEY) return;
  const label = ratchetCount ? `Ratchet #${ratchetCount}` : "Stop moved";
  try {
    await sendEmail({
      to: process.env.REPORT_EMAIL,
      subject: verified
        ? `NQ Cockpit — ${label} to ${newStopPrice.toFixed(2)} (${rule.symbol})`
        : `\u26a0 NQ Cockpit — stop move UNVERIFIED for ${rule.symbol}, check Tradovate now`,
      html: verified
        ? `<p>Your ${rule.direction} position in ${rule.symbol} hit its trigger. ${label}: stop moved to ${newStopPrice.toFixed(2)} and verified.</p>`
        : `<p style="color:#E5484D;font-weight:bold;">Trigger hit for ${rule.symbol}, and a stop modification was sent — but verification could not confirm the stop actually moved to ${newStopPrice.toFixed(2)} (found ${actualStopPrice ?? "unknown"} instead). Please check Tradovate directly right away.</p>`,
    });
  } catch (e: any) {
    console.error("Stop rule notification email failed:", e.message || e);
  }
}
