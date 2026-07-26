import fs from "fs";
import path from "path";
import { tradingDayKey } from "./tradingWindow";

// Mirrors the `Trade` shape from the Prisma model — duplicated here rather
// than imported from app/page.tsx since that's a "use client" component and
// this runs server-side in cron routes (same convention already used for
// holdTimeLabel in the daily-report route before this file existed).
export type ServerTrade = {
  id: number;
  date: Date;
  symbol: string;
  dir: string;
  entry: number | null;
  exit: number | null;
  entryDate: Date | null;
  size: number | null;
  pnl: number;
  disciplined: boolean | null;
  emotion: string | null;
  source: string;
};

export function holdTimeLabel(entryDate: Date | null, exitDate: Date): string | null {
  if (!entryDate) return null;
  const ms = exitDate.getTime() - entryDate.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

type AddOnInstance = { earlier: ServerTrade; later: ServerTrade };

// Same overlap logic as the client-side detectors in app/page.tsx: a
// "later" trade counts as adding to an "adverse"/"favorable" earlier
// position if it entered while that earlier position (same symbol, same
// direction) was still open, at a price that made things worse/better.
function findAddOnInstances(trades: ServerTrade[], favorable: boolean): AddOnInstance[] {
  const withEntry = trades.filter((t) => t.entryDate && t.entry !== null);
  const results: AddOnInstance[] = [];
  for (const later of withEntry) {
    let best: ServerTrade | null = null;
    let bestEntryTime = -Infinity;
    for (const earlier of withEntry) {
      if (earlier.id === later.id) continue;
      if (earlier.symbol !== later.symbol || earlier.dir !== later.dir) continue;
      const earlierEntry = new Date(earlier.entryDate!).getTime();
      const earlierExit = new Date(earlier.date).getTime();
      const laterEntry = new Date(later.entryDate!).getTime();
      if (!(laterEntry > earlierEntry && laterEntry < earlierExit)) continue;
      const isFavorable = earlier.dir === "long" ? later.entry! > earlier.entry! : later.entry! < earlier.entry!;
      if (isFavorable !== favorable) continue;
      if (earlierEntry > bestEntryTime) {
        bestEntryTime = earlierEntry;
        best = earlier;
      }
    }
    if (best) results.push({ earlier: best, later });
  }
  return results;
}

export const findAddedToLoserInstances = (trades: ServerTrade[]) => findAddOnInstances(trades, false);
export const findAddedToWinnerInstances = (trades: ServerTrade[]) => findAddOnInstances(trades, true);

// Concurrent-trade count for the equity-curve tooltip, same definition as
// the client's ExpectedMoveTracker-adjacent chart code: counts itself, so 1
// means never stacked with anything else. Symbol/direction-agnostic —
// holding an NQ long and an MNQ short at once is still 2 concurrent trades.
function concurrentCount(trades: ServerTrade[], t: ServerTrade): number | null {
  if (!t.entryDate) return null;
  const entryI = new Date(t.entryDate).getTime();
  const exitI = new Date(t.date).getTime();
  let count = 0;
  for (const other of trades) {
    if (!other.entryDate) continue;
    const entryJ = new Date(other.entryDate).getTime();
    const exitJ = new Date(other.date).getTime();
    if (entryI < exitJ && entryJ < exitI) count++;
  }
  return count;
}

export type ReportGroup = {
  label: string; // e.g. "Thu Jul 23 2026" or "Week of Jul 19 - Jul 24, 2026"
  trades: ServerTrade[];
  pnl: number;
  winRate: number;
  clean: number;
  flagged: number;
  unrated: number;
};

export function summarizeGroup(label: string, trades: ServerTrade[]): ReportGroup {
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const clean = trades.filter((t) => t.disciplined === true).length;
  const flagged = trades.filter((t) => t.disciplined === false).length;
  const unrated = trades.length - clean - flagged;
  return {
    label,
    trades,
    pnl,
    winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    clean,
    flagged,
    unrated,
  };
}

function fmtMoney(n: number): string {
  return `${n >= 0 ? "$" : "-$"}${Math.abs(n).toFixed(2)}`;
}

// Builds the same rich report as the Reports tab's Download HTML button —
// full trade table (with Symbol column), red/green highlighted rows for
// loser/winner adds, the callout boxes naming each instance, chart
// snapshots, and a self-contained equity curve (Chart.js embedded directly
// from this app's own /public/vendor folder via fs, not a CDN — same reason
// as the client version: doesn't depend on any external network request
// once the recipient opens the attachment).
export function buildRichReportHtml(
  group: ReportGroup,
  snapshots: { date: Date; note: string | null; imageData: string }[],
  reportLabel: string,
  emoEntries: { date: Date; tag: string | null; note: string }[] = []
): string {
  const addedToLoser = findAddedToLoserInstances(group.trades);
  const laterIds = new Set(addedToLoser.map((i) => i.later.id));
  const addedToWinner = findAddedToWinnerInstances(group.trades);
  const winnerIds = new Set(addedToWinner.map((i) => i.later.id));

  const rows = group.trades
    .map(
      (t) => `
    <tr${laterIds.has(t.id) ? ' style="background:rgba(229,72,77,0.15);"' : winnerIds.has(t.id) ? ' style="background:rgba(63,208,201,0.15);"' : ""}>
      <td>${laterIds.has(t.id) ? "!" : winnerIds.has(t.id) ? "+" : ""}</td>
      <td>${new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${t.symbol}</td>
      <td>${t.source.toUpperCase()}</td>
      <td>${t.dir.toUpperCase()}</td>
      <td>${t.entry !== null ? t.entry : "-"}</td>
      <td>${t.exit !== null ? t.exit : "-"}</td>
      <td>${holdTimeLabel(t.entryDate, t.date) ?? "-"}</td>
      <td style="color:${t.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${fmtMoney(t.pnl)}</td>
      <td>${t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</td>
      <td>${t.emotion || "-"}</td>
    </tr>`
    )
    .join("");

  const dayKeys = group.trades.map((t) => tradingDayKey(new Date(t.date)));
  const isMultiDay = new Set(dayKeys).size > 1;
  // When this chart spans more than one trading day (a weekly report), a
  // bare time like "07:37 AM" is genuinely ambiguous — several different
  // days can share the same clock time. Prefixing with a short weekday
  // fixes that in the tooltip/axis labels themselves; the background
  // shading below (keyed off the same dayKeys) makes day boundaries
  // visible on the chart at a glance too. Critically, the weekday shown
  // here is derived from the SAME tradingDayKey (6pm ET rollover) used for
  // the shading — not the raw calendar date of the timestamp — otherwise
  // a trade at, say, 8pm Wednesday gets labeled "Wed" while the shading
  // (correctly) already groups it with Thursday's trading day, and the
  // two visibly disagree right at the boundary.
  const equityLabels = group.trades.map((t, i) => {
    const time = new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dayLabel = new Date(`${dayKeys[i]}T12:00:00`).toLocaleDateString([], { weekday: "short" });
    return isMultiDay ? `${dayLabel} ${time}` : time;
  });
  let cum = 0;
  const equityData = group.trades.map((t) => (cum += t.pnl));
  const perTradePnl = group.trades.map((t) => t.pnl);
  const concurrentCounts = group.trades.map((t) => concurrentCount(group.trades, t));

  let chartJsSource = "";
  try {
    chartJsSource = fs.readFileSync(path.join(process.cwd(), "public/vendor/chart.umd.min.js"), "utf-8");
  } catch {
    // handled below via the empty-string fallback
  }

  const dataJson = JSON.stringify({ equityLabels, equityData, perTradePnl, concurrentCounts, dayKeys }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body{font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;}
  h1{color:#F5A623;font-size:20px;margin:0 0 4px;}
  .sub{color:#7F8CA6;margin:0 0 16px;}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px;}
  th{text-align:left;padding:6px 10px;color:#7F8CA6;border-bottom:1px solid #263654;}
  td{padding:6px 10px;border-bottom:1px solid #1a2540;}
  .callout{border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:13px;}
  .callout-loser{border:1px solid #E5484D;background:rgba(229,72,77,0.08);}
  .callout-winner{border:1px solid #3FD0C9;background:rgba(63,208,201,0.08);}
  .callout-line{color:#7F8CA6;margin-top:4px;}
</style>
</head>
<body>
  <h1>NQ COCKPIT — ${reportLabel} Report</h1>
  <p class="sub">${group.label}</p>
  <div style="display:flex;gap:24px;margin-bottom:16px;font-size:14px;">
    <div><strong>P&amp;L:</strong> ${fmtMoney(group.pnl)}</div>
    <div><strong>Trades:</strong> ${group.trades.length}</div>
    <div><strong>Win rate:</strong> ${group.winRate}%</div>
    <div><strong>Clean/Flagged${group.unrated ? "/Unrated" : ""}:</strong> ${group.clean}/${group.flagged}${group.unrated ? "/" + group.unrated : ""}</div>
  </div>
  ${addedToLoser.length > 0 ? `
  <div class="callout callout-loser">
    <div style="font-weight:bold;margin-bottom:6px;">! Added to a losing position — ${addedToLoser.length} instance${addedToLoser.length === 1 ? "" : "s"}</div>
    ${addedToLoser.map((inst) => `<div class="callout-line">${inst.earlier.symbol} ${inst.earlier.dir.toUpperCase()}: entered ${inst.earlier.entry} at ${new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, then added at ${inst.later.entry} at ${new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and underwater.</div>`).join("")}
  </div>` : ""}
  ${addedToWinner.length > 0 ? `
  <div class="callout callout-winner">
    <div style="font-weight:bold;margin-bottom:6px;">+ Added to a winning position — ${addedToWinner.length} instance${addedToWinner.length === 1 ? "" : "s"}</div>
    ${addedToWinner.map((inst) => `<div class="callout-line">${inst.earlier.symbol} ${inst.earlier.dir.toUpperCase()}: entered ${inst.earlier.entry} at ${new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, then added at ${inst.later.entry} at ${new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and in profit.</div>`).join("")}
  </div>` : ""}
  ${group.trades.length
      ? `<table>
          <thead><tr><th></th><th>Time</th><th>Symbol</th><th>Account</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Hold</th><th>P&amp;L</th><th>Discipline</th><th>Emotion</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : `<p style="color:#7F8CA6;">No trades logged.</p>`
    }
  ${group.trades.length && chartJsSource ? `
  <h3 style="color:#3FD0C9;font-size:15px;margin:0 0 8px;">Equity Curve</h3>
  <div style="max-width:800px;margin-bottom:20px;"><canvas id="equityChart" height="280"></canvas></div>
  <script>${chartJsSource}</script>
  <script>
  (function() {
    var d = ${dataJson};
    Chart.defaults.color = "#7F8CA6";
    Chart.defaults.font.family = "'Courier New', monospace";
    // Alternates a faint background band each time dayKeys changes, so day
    // boundaries are visible on the chart itself rather than only in the
    // (now day-prefixed) axis labels — otherwise a multi-day chart reads as
    // one undifferentiated line with repeating times like "07:37" showing
    // up several times with no visual separation.
    var dayBgPlugin = {
      id: 'dayBg',
      beforeDatasetsDraw: function(chart) {
        var keys = d.dayKeys;
        if (!keys || keys.length < 2) return;
        var area = chart.chartArea;
        var xScale = chart.scales.x;
        var half = (xScale.getPixelForValue(1) - xScale.getPixelForValue(0)) / 2;
        var ctx = chart.ctx;
        ctx.save();
        var segStart = 0, toggle = 0;
        for (var i = 1; i <= keys.length; i++) {
          if (i === keys.length || keys[i] !== keys[segStart]) {
            if (toggle % 2 === 1) {
              var xStart = Math.max(area.left, xScale.getPixelForValue(segStart) - half);
              var xEnd = Math.min(area.right, xScale.getPixelForValue(i - 1) + half);
              ctx.fillStyle = 'rgba(127,140,166,0.08)';
              ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
            }
            toggle++;
            segStart = i;
          }
        }
        ctx.restore();
      }
    };
    new Chart(document.getElementById('equityChart'), {
      type: 'line',
      data: {
        labels: d.equityLabels,
        datasets: [{
          label: 'Cumulative Realized P&L',
          data: d.equityData,
          borderColor: d.equityData[d.equityData.length - 1] >= 0 ? '#3FD0C9' : '#E5484D',
          backgroundColor: 'rgba(63,208,201,0.08)',
          fill: true, tension: 0.15, pointRadius: 3,
          pointBackgroundColor: d.perTradePnl.map(function(p) { return p >= 0 ? '#3FD0C9' : '#E5484D'; }),
        }]
      },
      plugins: [dayBgPlugin],
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) {
          var tradePnl = d.perTradePnl[ctx.dataIndex];
          var concurrent = d.concurrentCounts[ctx.dataIndex];
          var lines = ['This trade: ' + (tradePnl >= 0 ? '+' : '') + tradePnl.toFixed(2), 'Cumulative: ' + ctx.parsed.y.toFixed(2)];
          lines.push(concurrent === null ? 'Concurrent trades: unknown' : 'Concurrent trades: ' + concurrent);
          return lines;
        } } } },
        scales: { x: { ticks: { maxRotation: 60, minRotation: 60 }, grid: { color: '#263654' } }, y: { grid: { color: '#263654' } } }
      }
    });
  })();
  </script>` : ""}
  ${snapshots.length ? `
  <h3 style="color:#3FD0C9;font-size:15px;margin:20px 0 8px;">Chart Snapshots</h3>
  <div style="display:flex;flex-wrap:wrap;gap:12px;">
    ${snapshots.map((s) => `
    <div style="width:280px;">
      <img src="${s.imageData}" style="width:100%;border-radius:6px;border:1px solid #263654;" />
      <div style="color:#7F8CA6;font-size:12px;margin-top:4px;">${new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${s.note ? ` — ${s.note}` : ""}</div>
    </div>`).join("")}
  </div>` : ""}
  ${emoEntries.length ? `
  <h3 style="color:#3FD0C9;font-size:15px;margin:20px 0 8px;">Emotional Journal</h3>
  <table>
    <thead><tr><th>Time</th><th>Tag</th><th>Note</th></tr></thead>
    <tbody>
    ${emoEntries.map((e) => `
    <tr>
      <td>${new Date(e.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${e.tag || "—"}</td>
      <td>${e.note}</td>
    </tr>`).join("")}
    </tbody>
  </table>` : ""}
</body></html>`;
}

// ---- Deterministic discipline analysis ----
// Rule-based on purpose: this feeds an unattended, automated email with no
// human review before it goes out. A rule engine gives numbers you can
// trust are actually in the data (every claim below is computed directly
// from the trades/logs passed in) rather than risking a generative model
// paraphrasing or misstating a specific price/time in an email you might
// act on. Mirrors the kind of analysis given conversationally elsewhere in
// this app's development, just codified into thresholds.
export type AnalysisResult = { good: string[]; watch: string[] };

export function analyzeGroup(
  group: ReportGroup,
  blockedLogs: { blockedReason: string | null; date: Date }[],
  emoEntries: { date: Date; tag: string | null; note: string }[] = []
): AnalysisResult {
  const good: string[] = [];
  const watch: string[] = [];

  if (group.trades.length === 0) {
    return { good: [], watch: [] };
  }

  if (emoEntries.length > 0) {
    const tagCounts: Record<string, number> = {};
    for (const e of emoEntries) {
      if (e.tag) tagCounts[e.tag] = (tagCounts[e.tag] || 0) + 1;
    }
    const tagSummary = Object.entries(tagCounts).map(([tag, n]) => `${tag} x${n}`).join(", ");
    watch.push(`${emoEntries.length} Emotional Journal entr${emoEntries.length === 1 ? "y" : "ies"} logged this period${tagSummary ? ` (${tagSummary})` : ""} — worth reading alongside the trades above for direct context on what was actually going on.`);
  }

  const addedToLoser = findAddedToLoserInstances(group.trades);
  const addedToWinner = findAddedToWinnerInstances(group.trades);

  // Win rate / P&L framing
  if (group.pnl >= 0) {
    good.push(`Finished positive at ${fmtMoney(group.pnl)} across ${group.trades.length} trade(s), ${group.winRate}% win rate.`);
  } else {
    watch.push(`Finished negative at ${fmtMoney(group.pnl)} across ${group.trades.length} trade(s), ${group.winRate}% win rate.`);
  }

  // Discipline checklist usage
  if (group.unrated === group.trades.length) {
    watch.push(`0 of ${group.trades.length} trades went through the Pre-Trade discipline checklist — no self-rated data at all to learn from beyond raw P&L.`);
  } else if (group.flagged === 0 && group.clean > 0) {
    good.push(`${group.clean} trade(s) rated CLEAN, 0 flagged.`);
  } else if (group.flagged > 0) {
    watch.push(`${group.flagged} trade(s) self-flagged as undisciplined.`);
  }

  // Added-to-loser / added-to-winner
  if (addedToLoser.length === 0) {
    good.push(`No instances of adding to an already-open losing position.`);
  } else {
    const longCount = addedToLoser.filter((i) => i.earlier.dir === "long").length;
    const shortCount = addedToLoser.length - longCount;
    const gaps = addedToLoser
      .filter((i) => i.earlier.entryDate && i.later.entryDate)
      .map((i) => (new Date(i.later.entryDate!).getTime() - new Date(i.earlier.entryDate!).getTime()) / 60000);
    const medianGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
    watch.push(
      `${addedToLoser.length} instance(s) of adding to a losing position (${longCount} long / ${shortCount} short)` +
      (medianGap !== null ? `, median ${medianGap < 1 ? "under 1 minute" : `${Math.round(medianGap)} minute(s)`} between the original entry and the add.` : ".")
    );
  }
  if (addedToWinner.length > 0) {
    good.push(`${addedToWinner.length} instance(s) of adding to an already-open winning position (pyramiding a winner).`);
  }

  // Max concurrent stacking observed
  const maxConcurrent = Math.max(0, ...group.trades.map((t) => concurrentCount(group.trades, t) ?? 0));
  if (maxConcurrent >= 4) {
    watch.push(`Peak concurrency reached ${maxConcurrent} overlapping open trades at once.`);
  } else if (maxConcurrent > 0) {
    good.push(`Peak concurrency stayed at ${maxConcurrent} — never heavily stacked.`);
  }

  // Hold-time asymmetry between winners and losers
  const holdMinutes = (t: ServerTrade) => {
    if (!t.entryDate) return null;
    const m = (new Date(t.date).getTime() - new Date(t.entryDate).getTime()) / 60000;
    return Number.isFinite(m) && m >= 0 ? m : null;
  };
  const winnerHolds = group.trades.filter((t) => t.pnl > 0).map(holdMinutes).filter((m): m is number => m !== null);
  const loserHolds = group.trades.filter((t) => t.pnl <= 0).map(holdMinutes).filter((m): m is number => m !== null);
  if (winnerHolds.length > 0 && loserHolds.length > 0) {
    const avgWin = winnerHolds.reduce((s, m) => s + m, 0) / winnerHolds.length;
    const avgLoss = loserHolds.reduce((s, m) => s + m, 0) / loserHolds.length;
    if (avgLoss > avgWin * 1.5) {
      watch.push(`Losing trades were held ~${avgLoss.toFixed(0)}m on average vs. ~${avgWin.toFixed(0)}m for winners — losers ran longer than winners were allowed to.`);
    } else {
      good.push(`Hold times were roughly even between winners (~${avgWin.toFixed(0)}m avg) and losers (~${avgLoss.toFixed(0)}m avg) — no sign of cutting winners short while letting losers run.`);
    }
  }

  // Guard interventions — did the hard blocks actually fire?
  const relevantBlocks = blockedLogs.filter((l) => l.blockedReason);
  if (relevantBlocks.length > 0) {
    const cooldownBlocks = relevantBlocks.filter((l) => l.blockedReason!.includes("cooldown")).length;
    const concurrencyBlocks = relevantBlocks.filter((l) => l.blockedReason!.includes("concurrent")).length;
    const fatFingerBlocks = relevantBlocks.filter((l) => l.blockedReason!.includes("data-entry error")).length;
    const lossGuardBlocks = relevantBlocks.length - cooldownBlocks - concurrencyBlocks - fatFingerBlocks;
    const parts: string[] = [];
    if (concurrencyBlocks) parts.push(`${concurrencyBlocks} blocked for exceeding the concurrent-adds cap`);
    if (cooldownBlocks) parts.push(`${cooldownBlocks} blocked for being inside the add-on cooldown`);
    if (fatFingerBlocks) parts.push(`${fatFingerBlocks} blocked as a likely fat-finger price`);
    if (lossGuardBlocks > 0) parts.push(`${lossGuardBlocks} blocked by another guard (losing-position/trading-window/lockout)`);
    good.push(`The order guards actually intervened this period: ${parts.join(", ")}.`);
  }

  return { good, watch };
}

export function renderAnalysisHtml(analysis: AnalysisResult): string {
  if (analysis.good.length === 0 && analysis.watch.length === 0) return "";
  return `
    <div style="margin-bottom:20px;">
      ${analysis.good.length ? `
      <div style="margin-bottom:12px;">
        <div style="color:#3FD0C9;font-weight:bold;margin-bottom:6px;">What went well</div>
        <ul style="margin:0;padding-left:20px;color:#E8EDF5;">
          ${analysis.good.map((g) => `<li style="margin-bottom:4px;">${g}</li>`).join("")}
        </ul>
      </div>` : ""}
      ${analysis.watch.length ? `
      <div>
        <div style="color:#F5A623;font-weight:bold;margin-bottom:6px;">Worth a closer look</div>
        <ul style="margin:0;padding-left:20px;color:#E8EDF5;">
          ${analysis.watch.map((w) => `<li style="margin-bottom:4px;">${w}</li>`).join("")}
        </ul>
      </div>` : ""}
    </div>
  `;
}

// ---- AI-generated discipline analysis ----
// Same underlying detections as analyzeGroup above (added-to-loser/winner
// instances, concurrency, hold times, guard blocks) stay fully
// deterministic — only the SYNTHESIS/narrative layer is handed to Claude.
// That split matters: the facts fed to the model are pre-computed by this
// app's own code, not something the model has to derive itself, so a
// hallucinated number isn't possible the way it would be if the model were
// asked to do the arithmetic from a raw trade dump. If the API call fails
// for any reason (no key, network, bad JSON back), this falls back to the
// deterministic analyzeGroup rather than sending a broken/empty email.
export async function generateAiAnalysis(
  group: ReportGroup,
  blockedLogs: { blockedReason: string | null; date: Date }[],
  reportLabel: string,
  emoEntries: { date: Date; tag: string | null; note: string }[] = []
): Promise<AnalysisResult> {
  console.log(`[AI-ANALYSIS] called for ${reportLabel} — trades=${group.trades.length}, ANTHROPIC_API_KEY present=${!!process.env.ANTHROPIC_API_KEY}`);
  if (group.trades.length === 0) return { good: [], watch: [] };
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[AI-ANALYSIS] ANTHROPIC_API_KEY not set — falling back to deterministic analysis.");
    return analyzeGroup(group, blockedLogs, emoEntries);
  }

  try {
    const addedToLoser = findAddedToLoserInstances(group.trades);
    const addedToWinner = findAddedToWinnerInstances(group.trades);
    const maxConcurrent = Math.max(0, ...group.trades.map((t) => concurrentCount(group.trades, t) ?? 0));

    const holdMinutes = (t: ServerTrade) => {
      if (!t.entryDate) return null;
      const m = (new Date(t.date).getTime() - new Date(t.entryDate).getTime()) / 60000;
      return Number.isFinite(m) && m >= 0 ? Math.round(m) : null;
    };

    const facts = {
      period: reportLabel,
      label: group.label,
      pnl: Number(group.pnl.toFixed(2)),
      tradeCount: group.trades.length,
      winRate: group.winRate,
      clean: group.clean,
      flagged: group.flagged,
      unrated: group.unrated,
      maxConcurrentOpenTrades: maxConcurrent,
      addedToLosingPosition: addedToLoser.map((i) => ({
        symbol: i.earlier.symbol,
        dir: i.earlier.dir,
        earlierEntryPrice: i.earlier.entry,
        earlierEntryTime: i.earlier.entryDate ? new Date(i.earlier.entryDate).toLocaleTimeString() : null,
        laterEntryPrice: i.later.entry,
        laterEntryTime: i.later.entryDate ? new Date(i.later.entryDate).toLocaleTimeString() : null,
        gapMinutes: i.earlier.entryDate && i.later.entryDate
          ? Math.round((new Date(i.later.entryDate).getTime() - new Date(i.earlier.entryDate).getTime()) / 60000)
          : null,
      })),
      addedToWinningPosition: addedToWinner.map((i) => ({
        symbol: i.earlier.symbol,
        dir: i.earlier.dir,
        earlierEntryPrice: i.earlier.entry,
        laterEntryPrice: i.later.entry,
      })),
      trades: group.trades.map((t) => ({
        time: new Date(t.date).toLocaleTimeString(),
        symbol: t.symbol,
        dir: t.dir,
        entry: t.entry,
        exit: t.exit,
        holdMinutes: holdMinutes(t),
        pnl: t.pnl,
        disciplined: t.disciplined,
        emotion: t.emotion,
      })),
      guardBlocksThisPeriod: blockedLogs.map((l) => l.blockedReason),
      emotionalJournalEntries: emoEntries.map((e) => ({
        time: new Date(e.date).toLocaleTimeString(),
        tag: e.tag,
        note: e.note,
      })),
    };

    const prompt = `You are analyzing a futures trader's ${reportLabel.toLowerCase()} trading data for an automated email report. Be specific and reference actual numbers, times, and prices from the data below — never vague generalities. Be direct and honest about problems, not just encouraging. This trader has an established pattern of tilt (rapid same-direction adds, averaging down) that a coaching conversation already identified, so weigh in on whether this period shows that pattern or not. If emotionalJournalEntries is non-empty, treat it as the most valuable data here — it's the trader's own direct, self-reported account of what they were thinking/feeling, unlike everything else which is inferred from price/time data. Quote or closely paraphrase specific entries and connect them to specific trades/times where the timing lines up, rather than just noting entries exist.

Respond with ONLY valid JSON, no markdown fences, no preamble, no text before or after the JSON object, in exactly this shape:
{"good": ["specific observation 1", "specific observation 2"], "watch": ["specific concern 1", "specific concern 2"]}

Each array should have 2-5 items. Keep each item to ONE sentence, under 35 words, citing real numbers/times from the data — not a category label, and not a multi-sentence paragraph. If there's genuinely nothing to flag in one category, it's fine for that array to be shorter, but don't pad with filler. Stay within these limits strictly — the response must be complete, valid JSON. Never reference the raw JSON field names below (e.g. "guardBlocksThisPeriod", "addedToLosingPosition") in your written sentences — describe what they mean in plain English instead (e.g. "no automated guard blocked any of these trades" rather than "guardBlocksThisPeriod is empty").

DATA:
${JSON.stringify(facts)}`;

    console.log(`[AI-ANALYSIS] calling Anthropic API, model=${process.env.ANTHROPIC_MODEL || "claude-sonnet-5"}, prompt length=${prompt.length} chars`);
    // Explicit timeout — without this, a slow generation (max_tokens gives
    // the model room to run long) can hang the fetch indefinitely, which
    // hangs the ENTIRE cron request (the email never gets sent at all,
    // not even the fallback) rather than just this one section failing.
    // 55s gives real responses plenty of room (25s proved too tight for a
    // busy 60-trade week in testing) while still failing fast enough to
    // fall back and let the email go out on schedule.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    console.log(`[AI-ANALYSIS] Anthropic API responded with status ${res.status}`);

    if (!res.ok) {
      console.error("[AI-ANALYSIS] Anthropic API error:", res.status, await res.text());
      return analyzeGroup(group, blockedLogs, emoEntries);
    }

    const body = await res.json();
    const text = (body.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr: any) {
      console.error(`[AI-ANALYSIS] JSON parse failed (stop_reason=${body.stop_reason}, response length=${text.length} chars): ${parseErr.message}`);
      console.error(`[AI-ANALYSIS] raw response was: ${text.slice(0, 2000)}`);
      throw parseErr;
    }

    if (!Array.isArray(parsed.good) || !Array.isArray(parsed.watch)) {
      throw new Error("Unexpected response shape from Claude");
    }

    console.log(`[AI-ANALYSIS] success — good=${parsed.good.length} items, watch=${parsed.watch.length} items`);
    return { good: parsed.good, watch: parsed.watch };
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error("[AI-ANALYSIS] Anthropic API call timed out after 55s, falling back to deterministic.");
    } else {
      console.error("[AI-ANALYSIS] generation failed, falling back to deterministic:", err.message || err);
    }
    return analyzeGroup(group, blockedLogs, emoEntries);
  }
}
