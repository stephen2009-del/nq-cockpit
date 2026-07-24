import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { tradingDayStart, tradingDayKey } from "@/lib/tradingWindow";

// Same logic as holdTimeLabel in app/page.tsx — duplicated here since this
// route can't import from a "use client" component.
function holdTimeLabel(entryDate: Date | null, exitDate: Date): string | null {
  if (!entryDate) return null;
  const ms = exitDate.getTime() - entryDate.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

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
  // A "trading day" runs 6pm ET to 6pm ET the next day (CME Globex
  // convention), matching tradingDayKey/tradingDayStart used everywhere
  // else in the app. Was previously the server's raw local timezone (UTC
  // on Railway) at midnight — same class of bug fixed in the order route.
  const startOfDay = tradingDayStart(now);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  // startOfDay is a 6pm-ET-the-evening-before timestamp, so its raw
  // .toDateString() would show the wrong (prior) calendar day — derive the
  // actual trading-day label from the key instead.
  const tradingDayLabel = new Date(`${tradingDayKey(now)}T12:00:00`).toDateString();

  const trades = await prisma.trade.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay } },
    orderBy: { date: "asc" },
  });

  // Best-effort: not every email client renders embedded base64 images
  // (data URIs), but most modern ones (Gmail, Apple Mail) do.
  const snapshots = await prisma.chartSnapshot.findMany({
    where: { date: { gte: startOfDay, lt: endOfDay } },
    orderBy: { date: "asc" },
  });

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0;
  const clean = trades.filter((t) => t.disciplined === true).length;
  const flagged = trades.filter((t) => t.disciplined === false).length;
  const unrated = trades.length - clean - flagged;

  const rows = trades
    .map(
      (t) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
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

  const html = `
    <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
      <h2 style="color:#F5A623;margin:0 0 4px;">NQ COCKPIT — Daily Report</h2>
      <p style="color:#7F8CA6;margin:0 0 16px;">${tradingDayLabel}</p>
      <div style="display:flex;gap:24px;margin-bottom:16px;font-size:14px;">
        <div><strong>P&amp;L:</strong> ${totalPnl >= 0 ? "$" : "-$"}${Math.abs(totalPnl).toFixed(2)}</div>
        <div><strong>Trades:</strong> ${trades.length}</div>
        <div><strong>Win rate:</strong> ${winRate}%</div>
        <div><strong>Clean/Flagged${unrated ? "/Unrated" : ""}:</strong> ${clean}/${flagged}${unrated ? "/" + unrated : ""}</div>
      </div>
      ${
        trades.length
          ? `<table style="border-collapse:collapse;width:100%;font-size:13px;">
              <thead><tr>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Time</th>
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
      ${
        snapshots.length
          ? `<h3 style="color:#3FD0C9;font-size:15px;margin:20px 0 8px;">Chart Snapshots</h3>
             <div style="display:flex;flex-wrap:wrap;gap:12px;">
               ${snapshots.map((s) => `
               <div style="width:280px;">
                 <img src="${s.imageData}" style="width:100%;border-radius:6px;border:1px solid #263654;" />
                 <div style="color:#7F8CA6;font-size:12px;margin-top:4px;">${new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${s.note ? ` — ${s.note}` : ""}</div>
               </div>`).join("")}
             </div>`
          : ""
      }
    </div>
  `;

  await sendEmail({
    to,
    subject: `NQ Cockpit — ${trades.length} trade(s), ${totalPnl >= 0 ? "+" : "-"}$${Math.abs(totalPnl).toFixed(2)} — ${tradingDayLabel}`,
    html,
  });

  return NextResponse.json({ ok: true, tradesCount: trades.length });
}
