import { NextRequest, NextResponse } from "next/server";
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

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
        results.push({ ruleId: rule.id, skipped: "no open position found" });
        continue;
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
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const lastCheck = await prisma.intradayCheck.findFirst({ where: { date: { gte: startOfDay } }, orderBy: { date: "desc" } });
        impliedPrice = lastCheck?.nqPrice ?? null;
      }

      if (impliedPrice === null) {
        results.push({ ruleId: rule.id, skipped: "no price data available (no Tradovate P&L and no logged price)" });
        continue;
      }

      // Step 2 — has the trigger been reached?
      const triggered = rule.direction === "long"
        ? impliedPrice >= rule.entryPrice + rule.triggerOffset
        : impliedPrice <= rule.entryPrice - rule.triggerOffset;

      if (!triggered) {
        results.push({ ruleId: rule.id, skipped: `not triggered yet (implied price ${impliedPrice.toFixed(2)})` });
        continue;
      }

      // Step 3 — find the working stop order to modify.
      const stopOrder = await findWorkingStopOrder(env, rule.accountId, rule.symbol);
      if (!stopOrder) {
        await prisma.stopManagementRule.update({
          where: { id: rule.id },
          data: { status: "failed", triggeredAt: new Date(), detail: "Triggered, but no working stop order was found to modify." },
        });
        results.push({ ruleId: rule.id, failed: "no working stop order found" });
        continue;
      }

      const newStopPrice = rule.direction === "long" ? rule.entryPrice + rule.newStopOffset : rule.entryPrice - rule.newStopOffset;

      // Step 4 — modify, then MANDATORY verification (never trust the
      // response alone — Tradovate's own community has documented cases
      // where it reports success without the order actually changing).
      await modifyStopOrder(env, stopOrder.id, stopOrder.orderQty ?? rule.qty, newStopPrice);
      const verifyResult = await getOrderById(env, stopOrder.id);
      const actualStopPrice = verifyResult.ok ? (verifyResult.body.stopPrice ?? verifyResult.body.price) : null;
      const verified = actualStopPrice !== null && Math.abs(actualStopPrice - newStopPrice) < 0.01;

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

      if (process.env.REPORT_EMAIL && process.env.RESEND_API_KEY) {
        await sendEmail({
          to: process.env.REPORT_EMAIL,
          subject: verified
            ? `NQ Cockpit — Stop moved to ${newStopPrice} (${rule.symbol})`
            : `⚠ NQ Cockpit — Stop move UNVERIFIED for ${rule.symbol}, check Tradovate now`,
          html: verified
            ? `<p>Your ${rule.direction} position in ${rule.symbol} hit its trigger. Stop moved to ${newStopPrice} and verified.</p>`
            : `<p style="color:#E5484D;font-weight:bold;">Trigger hit for ${rule.symbol}, and a stop modification was sent — but verification could not confirm the stop actually moved to ${newStopPrice}. Please check Tradovate directly right away.</p>`,
        }).catch((e) => console.error("Email send failed:", e));
      }

      results.push({ ruleId: rule.id, triggered: true, verified, newStopPrice });
    } catch (err: any) {
      console.error(`Stop rule ${rule.id} check failed:`, err.message || err);
      results.push({ ruleId: rule.id, error: err.message || String(err) });
    }
  }

  return NextResponse.json({ checked: activeRules.length, results });
}
