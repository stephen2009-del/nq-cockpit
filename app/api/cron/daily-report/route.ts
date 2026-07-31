import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { tradingDayStart, tradingDayKey } from "@/lib/tradingWindow";
import { summarizeGroup, buildRichReportHtml, generateAiAnalysis, renderAnalysisHtml, holdTimeLabel, etTime } from "@/lib/serverReports";

// Ensures this route always executes fresh — no cached GET response could
// ever explain identical output across requests while debugging the AI
// analysis integration.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const to = process.env.REPORT_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "REPORT_EMAIL is not set" }, { status: 500 });
  }

  // Which account(s) this report covers.
  // Defaults to Live specifically — not Settings' current environment,
  // since that toggle changes whenever you're testing something in Demo,
  // and the automated report shouldn't silently follow that. Override
  // with ?env=all|live|demo in the cron URL if you ever want a different
  // scope for a specific run. Without any env filter at all, every trade
  // regardless of account gets blended into one number — exactly the
  // Demo/Live mixing problem the rest of this app was built to eliminate,
  // which is what was happening here before this fix.
  const envParam = req.nextUrl.searchParams.get("env");
  const envFilter: "all" | "live" | "demo" =
    envParam === "all" || envParam === "live" || envParam === "demo" ? envParam : "live";
  const sourceWhere = envFilter === "all" ? {} : { source: envFilter };
  const envLabel = envFilter === "all" ? "All Accounts" : envFilter === "live" ? "Live" : "Demo";

  const now = new Date();
  // A "trading day" runs 6pm ET to 6pm ET the next day (CME Globex
  // convention), matching tradingDayKey/tradingDayStart used everywhere
  // else in the app.
  const startOfDay = tradingDayStart(now);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const tradingDayLabel = new Date(`${tradingDayKey(now)}T12:00:00`).toDateString();

  // A trading day (6pm ET–6pm ET) that falls on a calendar Saturday or
  // Sunday is always fully inside Globex's weekend closure (last close
  // ~5pm ET Friday, reopen ~6pm ET Sunday) — there's no scenario where
  // that window has real trades. Skip sending rather than mail an
  // always-empty $0.00/0-trades report every weekend.
  const dayOfWeek = new Date(`${tradingDayKey(now)}T12:00:00`).getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return NextResponse.json({ ok: true, skipped: true, reason: "weekend — market closed" });
  }

  const trades = await prisma.trade.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay }, ...sourceWhere },
    orderBy: { date: "asc" },
  });

  // Best-effort: not every email client renders embedded base64 images
  // (data URIs), but most modern ones (Gmail, Apple Mail) do. This only
  // matters for the plain-text body anyway now — the attachment is opened
  // in a real browser, where this always works.
  const snapshots = await prisma.chartSnapshot.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay } },
    orderBy: { date: "asc" },
  });

  const blockedLogs = await prisma.tradovateOrderLog.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay }, status: "BLOCKED", ...(envFilter === "all" ? {} : { env: envFilter }) },
    select: { blockedReason: true, date: true },
  });

  // Orders with a bracket stop attached — cross-referenced against each
  // trade's own exit to check whether that stop was actually honored.
  const stopOrderLogs = await prisma.tradovateOrderLog.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay }, status: "SUBMITTED", stopLossPrice: { not: null }, ...(envFilter === "all" ? {} : { env: envFilter }) },
    select: { symbol: true, side: true, date: true, stopLossPrice: true, status: true },
  });

  // Only included for Live reports — these entries are about real trading
  // headspace, not Demo practice, so Demo/All-scoped reports skip them
  // entirely rather than mixing in journal notes that may not even be
  // about the account this report covers.
  const emoEntries = envFilter === "live"
    ? await prisma.emotionalLogEntry.findMany({
        where: { date: { gte: startOfDay, lt: endOfDay } },
        orderBy: { date: "asc" },
      })
    : [];

  const group = summarizeGroup(`${tradingDayLabel} \u2014 ${envLabel}`, trades);
  const analysis = await generateAiAnalysis(group, blockedLogs, "Daily", emoEntries, stopOrderLogs);

  const rows = trades
    .map(
      (t) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${etTime(new Date(t.date))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.symbol}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.source.toUpperCase()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.dir.toUpperCase()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.entry !== null ? t.entry : "-"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.exit !== null ? t.exit : "-"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${holdTimeLabel(t.entryDate, t.date) ?? "-"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;color:${t.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${t.pnl >= 0 ? "$" : "-$"}${Math.abs(t.pnl).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</td>
    </tr>`
    )
    .join("");

  // Email BODY stays plain HTML with no <script> — most email clients
  // strip scripts entirely, so the interactive equity chart only lives in
  // the attached report (opened in a real browser), not here.
  const html = `
    <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
      <h2 style="color:#F5A623;margin:0 0 4px;">NQ COCKPIT — Daily Report (${envLabel})</h2>
      <p style="color:#7F8CA6;margin:0 0 16px;">${tradingDayLabel}</p>
      <div style="display:flex;gap:24px;margin-bottom:16px;font-size:14px;flex-wrap:wrap;">
        <div><strong>P&amp;L:</strong> ${group.pnl >= 0 ? "$" : "-$"}${Math.abs(group.pnl).toFixed(2)}</div>
        <div><strong>Trades:</strong> ${trades.length}</div>
        <div><strong>Win rate:</strong> ${group.winRate}%</div>
        <div><strong>Clean/Flagged${group.unrated ? "/Unrated" : ""}:</strong> ${group.clean}/${group.flagged}${group.unrated ? "/" + group.unrated : ""}</div>
      </div>
      ${renderAnalysisHtml(analysis)}
      ${
        trades.length
          ? `<table style="border-collapse:collapse;width:100%;font-size:13px;">
              <thead><tr>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Time</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Symbol</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Account</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Dir</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Entry</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Exit</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Hold</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">P&amp;L</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Discipline</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : `<p style="color:#7F8CA6;">No trades logged today.</p>`
      }
      ${emoEntries.length ? `
      <div style="margin-top:16px;">
        <div style="color:#F5A623;font-weight:bold;margin-bottom:6px;">Emotional Journal</div>
        <table style="border-collapse:collapse;width:100%;font-size:13px;">
          <thead><tr>
            <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Time</th>
            <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Tag</th>
            <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Note</th>
          </tr></thead>
          <tbody>
            ${emoEntries.map((e) => `
            <tr>
              <td style="padding:6px 10px;border-bottom:1px solid #263654;">${etTime(new Date(e.date))}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #263654;">${e.tag || "\u2014"}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #263654;">${e.note}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : ""}
      <p style="color:#7F8CA6;font-size:12px;margin-top:16px;">Full report with charts and any chart snapshots is attached as an HTML file — open it in a browser for the interactive version.</p>
    </div>
  `;

  const reportHtml = buildRichReportHtml(group, snapshots, "Daily", emoEntries, stopOrderLogs);

  await sendEmail({
    to,
    subject: `NQ Cockpit (${envLabel}) — ${trades.length} trade(s), ${group.pnl >= 0 ? "+" : "-"}$${Math.abs(group.pnl).toFixed(2)} — ${tradingDayLabel}`,
    html,
    attachments: [
      {
        filename: `nq-cockpit-daily-report-${envFilter}-${tradingDayKey(now)}.html`,
        content: Buffer.from(reportHtml, "utf-8").toString("base64"),
      },
    ],
  });

  return NextResponse.json({ ok: true, tradesCount: trades.length, env: envFilter });
}
