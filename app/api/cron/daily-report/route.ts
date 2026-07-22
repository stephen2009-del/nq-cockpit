import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

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
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const trades = await prisma.trade.findMany({
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
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.dir.toUpperCase()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.setup || "-"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;color:${t.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${t.pnl >= 0 ? "$" : "-$"}${Math.abs(t.pnl).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #263654;">${t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</td>
    </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
      <h2 style="color:#F5A623;margin:0 0 4px;">NQ COCKPIT — Daily Report</h2>
      <p style="color:#7F8CA6;margin:0 0 16px;">${startOfDay.toDateString()}</p>
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
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Dir</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Setup</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">P&amp;L</th>
                <th style="text-align:left;padding:6px 10px;color:#7F8CA6;">Discipline</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : `<p style="color:#7F8CA6;">No trades logged today.</p>`
      }
    </div>
  `;

  await sendEmail({
    to,
    subject: `NQ Cockpit — ${trades.length} trade(s), ${totalPnl >= 0 ? "+" : "-"}$${Math.abs(totalPnl).toFixed(2)} — ${startOfDay.toLocaleDateString()}`,
    html,
  });

  return NextResponse.json({ ok: true, tradesCount: trades.length });
}
