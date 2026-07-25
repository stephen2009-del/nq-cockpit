import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { weekStart, weekStartKey } from "@/lib/tradingWindow";
import { summarizeGroup, buildRichReportHtml, analyzeGroup, renderAnalysisHtml } from "@/lib/serverReports";

// Trigger this on its own external schedule (same mechanism as
// daily-report — an external cron hitting this URL with ?key=CRON_SECRET),
// once a week. Friday afternoon/evening or Sunday before Globex reopens
// both work equally well: weekStart/weekStartKey key off Friday-any-hour
// and Saturday as still belonging to the week that just ended, so this
// resolves to the completed week either way.
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const to = process.env.REPORT_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "REPORT_EMAIL is not set" }, { status: 500 });
  }

  const now = new Date();
  // A "trading week" runs Sunday 6pm ET through Friday 1pm ET — not the
  // standard Mon-Fri calendar week — matching the Reports tab's Weekly view.
  const startOfWeek = weekStart(now);
  const endOfWeek = new Date(startOfWeek.getTime() + (5 * 24 - 5) * 60 * 60 * 1000); // Sun 6pm + 5 days - 5h = Fri 1pm
  const weekKey = weekStartKey(now);
  const sunday = new Date(`${weekKey}T12:00:00`);
  const friday = new Date(sunday.getTime() + 5 * 24 * 60 * 60 * 1000);
  const weekLabel = `Week of ${sunday.toLocaleDateString([], { month: "short", day: "numeric" })} \u2013 ${friday.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;

  const trades = await prisma.trade.findMany({
    where: { date: { gte: startOfWeek, lt: endOfWeek } },
    orderBy: { date: "asc" },
  });

  const snapshots = await prisma.chartSnapshot.findMany({
    where: { date: { gte: startOfWeek, lt: endOfWeek } },
    orderBy: { date: "asc" },
  });

  const blockedLogs = await prisma.tradovateOrderLog.findMany({
    where: { date: { gte: startOfWeek, lt: endOfWeek }, status: "BLOCKED" },
    select: { blockedReason: true, date: true },
  });

  const group = summarizeGroup(weekLabel, trades);
  const analysis = analyzeGroup(group, blockedLogs);

  // Per-day breakdown inside the week, for a quick at-a-glance table in the
  // email body (the full per-trade table lives in the attached report —
  // a week's worth of individual trade rows is a lot to read inline).
  const dayMap = new Map<string, { label: string; pnl: number; count: number }>();
  for (const t of trades) {
    const dKey = new Date(t.date).toDateString();
    const existing = dayMap.get(dKey) || { label: dKey, pnl: 0, count: 0 };
    existing.pnl += t.pnl;
    existing.count += 1;
    dayMap.set(dKey, existing);
  }
  const dayRows = Array.from(dayMap.values())
    .sort((a, b) => new Date(a.label).getTime() - new Date(b.label).getTime())
    .map(
      (d) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${d.label}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${d.count}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;color:${d.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${d.pnl >= 0 ? "$" : "-$"}${Math.abs(d.pnl).toFixed(2)}</td>
    </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
      <h2 style="color:#F5A623;margin:0 0 4px;">NQ COCKPIT — Weekly Report</h2>
      <p style="color:#7F8CA6;margin:0 0 16px;">${weekLabel}</p>
      <div style="display:flex;gap:24px;margin-bottom:16px;font-size:14px;flex-wrap:wrap;">
        <div><strong>P&amp;L:</strong> ${group.pnl >= 0 ? "$" : "-$"}${Math.abs(group.pnl).toFixed(2)}</div>
        <div><strong>Trades:</strong> ${trades.length}</div>
        <div><strong>Win rate:</strong> ${group.winRate}%</div>
        <div><strong>Clean/Flagged${group.unrated ? "/Unrated" : ""}:</strong> ${group.clean}/${group.flagged}${group.unrated ? "/" + group.unrated : ""}</div>
      </div>
      ${renderAnalysisHtml(analysis)}
      ${
        trades.length
          ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:8px;">
              <thead><tr>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Day</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Trades</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">P&amp;L</th>
              </tr></thead>
              <tbody>${dayRows}</tbody>
            </table>`
          : `<p style="color:#7F8CA6;">No trades logged this week.</p>`
      }
      <p style="color:#7F8CA6;font-size:12px;margin-top:16px;">Full per-trade report with charts and any chart snapshots is attached as an HTML file — open it in a browser for the interactive version.</p>
    </div>
  `;

  const reportHtml = buildRichReportHtml(group, snapshots, "Weekly");

  await sendEmail({
    to,
    subject: `NQ Cockpit Weekly — ${trades.length} trade(s), ${group.pnl >= 0 ? "+" : "-"}$${Math.abs(group.pnl).toFixed(2)} — ${weekLabel}`,
    html,
    attachments: [
      {
        filename: `nq-cockpit-weekly-report-${weekKey}.html`,
        content: Buffer.from(reportHtml, "utf-8").toString("base64"),
      },
    ],
  });

  return NextResponse.json({ ok: true, tradesCount: trades.length });
}
