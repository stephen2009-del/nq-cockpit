"use client";

import { useEffect, useState } from "react";
import jsPDF from "jspdf";
import { getTradingWindowStatus, tradingDayKey } from "@/lib/tradingWindow";
import { matchFillsToTrades, MatchedTrade, analyzeHoldTimes } from "@/lib/fifoMatch";

type Rule = { id: number; text: string; order: number };
type Trade = {
  id: number;
  date: string;
  symbol: string;
  dir: string;
  session: string;
  entry: number | null;
  exit: number | null;
  entryDate: string | null; // separate from `date` (exit time for synced trades) — null if unknown (manual entries, pre-existing synced trades)
  size: number | null;
  pnl: number;
  setup: string | null;
  emotion: string | null;
  notes: string | null;
  disciplined: boolean | null; // null = no self-reported checklist (e.g. broker-synced trades)
  source: string; // "manual" | "demo" | "live" — which Tradovate environment (if any) this came from
  checklistSnapshot: { rule: string; passed: boolean }[];
  plannedStop: number | null;
  plannedTarget: number | null;
};
type ChartSnapshot = {
  id: number;
  date: string;
  note: string | null;
  imageData: string;
};
type Settings = {
  id: number;
  dailyLossLimit: number;
  contract: string;
  multiplier: number;
  tradingWindowStart: string;
  tradingWindowEnd: string;
  cutoffMinutesBeforeClose: number;
  openingBufferMinutes: number;
  tradovateEnv: string;
  tradingWindowLocked: boolean;
  liveAccountId: string | null;
  demoAccountId: string | null;
};
type PreMarketPrep = { id: number; date: string; qqqPrice: number; multiplier: number; estimatedMove: number; nqPrice: number; openInterestNotes: string | null };
type OILevel = { id: number; date: string; strike: number; oi: number; note: string | null };
type IntradayCheckT = { id: number; date: string; qqqPrice: number; nqPrice: number };
type EmotionalEntry = { id: number; date: string; tag: string | null; note: string };

const CONTRACTS: Record<string, number | null> = { NQ: 20, MNQ: 2, ES: 50, MES: 5, CUSTOM: null };
// Minutes a losing position can sit open before Current Position starts
// warning you directly — tuned to catch "hoping it comes back" before it
// turns into a much bigger loss.
const HOLDING_LOSER_WARNING_MINUTES = 15;

function fmtMoney(n: number) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(2);
}

type DisciplineFlag = { type: "ran_loser" | "early_profit"; text: string };

// Compares what actually happened against the trader's OWN stated plan
// (planned stop / planned target logged at trade time) — never invents a
// plan they didn't declare, and says nothing if either wasn't provided.
function analyzeTradeDiscipline(t: Trade): DisciplineFlag[] {
  const flags: DisciplineFlag[] = [];
  if (t.entry === null || t.exit === null) return flags;

  const isLong = t.dir === "long";

  if (t.plannedStop !== null && t.pnl < 0) {
    const plannedRisk = Math.abs(t.entry - t.plannedStop);
    const actualLoss = Math.abs(t.entry - t.exit);
    if (plannedRisk > 0 && actualLoss > plannedRisk * 1.1) {
      const overBy = actualLoss - plannedRisk;
      flags.push({
        type: "ran_loser",
        text: `You let this loser run past your own planned stop. Planned risk was ${plannedRisk.toFixed(2)} pts, actual loss was ${actualLoss.toFixed(2)} pts — ${overBy.toFixed(2)} pts further than you said you would go.`,
      });
    }
  }

  if (t.plannedTarget !== null && t.pnl > 0) {
    const plannedReward = Math.abs(t.plannedTarget - t.entry);
    const actualGain = Math.abs(t.exit - t.entry);
    if (plannedReward > 0 && actualGain < plannedReward * 0.5) {
      const pctCaptured = Math.round((actualGain / plannedReward) * 100);
      flags.push({
        type: "early_profit",
        text: `You took profit early relative to your own plan. You captured ${actualGain.toFixed(2)} of your planned ${plannedReward.toFixed(2)}-pt target — only ${pctCaptured}% of the move you said you were aiming for.`,
      });
    }
  }

  return flags;
}

// NQ and MNQ both trade in quarter-point ticks (.00/.25/.50/.75). Any price
// derived from QQQ × multiplier lands on arbitrary decimals, so anything
// used as an actual limit price needs to snap to a real tradable tick first.
function roundToTick(price: number, tick: number = 0.25): number {
  return Math.round(price / tick) * tick;
}

function addMinutesLabel(hhmm: string, deltaMinutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + deltaMinutes;
  total = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
}
function escapeHtml(str: string | null | undefined) {
  return str || "";
}

function groupBy(trades: Trade[], keyFn: (t: Trade) => string) {
  const map = new Map<string, Trade[]>();
  trades.forEach((t) => {
    const k = keyFn(t) || "(none)";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  });
  return Array.from(map.entries())
    .map(([key, group]) => {
      const pnl = group.reduce((s, t) => s + t.pnl, 0);
      const wins = group.filter((t) => t.pnl > 0).length;
      return {
        key,
        count: group.length,
        pnl,
        avgPnl: pnl / group.length,
        winRate: Math.round((wins / group.length) * 100),
      };
    })
    .sort((a, b) => b.pnl - a.pnl);
}

function downloadTradesCSV(trades: Trade[]) {
  const headers = ["Date", "Symbol", "Direction", "Session", "Entry", "Exit", "Size", "PnL", "Setup", "Emotion", "Disciplined", "Notes"];
  const rows = trades.map((t) => [
    new Date(t.date).toISOString(),
    t.symbol,
    t.dir,
    t.session,
    t.entry ?? "",
    t.exit ?? "",
    t.size ?? "",
    t.pnl,
    t.setup ?? "",
    t.emotion ?? "",
    t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED",
    (t.notes ?? "").replace(/"/g, '""'),
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell)}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nq-cockpit-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Page() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings>({
    id: 1, dailyLossLimit: 500, contract: "NQ", multiplier: 20,
    tradingWindowStart: "09:30", tradingWindowEnd: "16:00", cutoffMinutesBeforeClose: 65, openingBufferMinutes: 10, tradovateEnv: "demo", tradingWindowLocked: false, liveAccountId: null, demoAccountId: null,
  });
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [tab, setTab] = useState<"premarket" | "intraday" | "emojournal" | "tradeticket" | "tvanalytics" | "checklist" | "journal" | "dashboard" | "reports" | "settings">("premarket");
  const [preMarketHistory, setPreMarketHistory] = useState<PreMarketPrep[]>([]);
  const [preMarketForm, setPreMarketForm] = useState({ qqqPrice: "", multiplier: "41.36", estimatedMove: "", openInterestNotes: "" });
  const [oiLevels, setOiLevels] = useState<OILevel[]>([]);
  const [oiForm, setOiForm] = useState({ strike: "", oi: "", note: "" });
  const [intradayChecks, setIntradayChecks] = useState<IntradayCheckT[]>([]);
  const [snapshots, setSnapshots] = useState<ChartSnapshot[]>([]);
  const [emoEntries, setEmoEntries] = useState<EmotionalEntry[]>([]);
  const [emoForm, setEmoForm] = useState({ tag: "", note: "" });
  const [intradayInput, setIntradayInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [viewTradeId, setViewTradeId] = useState<number | null>(null);
  const [newRuleText, setNewRuleText] = useState("");
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    symbol: "NQ", dir: "long", session: "NY Open", entry: "", exit: "", size: "1",
    entryTime: "", exitTime: "",
    pnl: "", setup: "", emotion: "Calm / neutral", notes: "", plannedStop: "", plannedTarget: "",
  });

  async function loadAll() {
    setLoading(true);
    const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
      fetch("/api/rules").then((r) => r.json()),
      fetch("/api/trades").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/premarket").then((r) => r.json()),
      fetch("/api/oi-levels").then((r) => r.json()),
      fetch("/api/intraday").then((r) => r.json()),
      fetch("/api/emotional-log").then((r) => r.json()),
      fetch("/api/snapshots").then((r) => r.json()),
    ]);
    setRules(r1);
    setTrades(r2);
    setSettings(r3);
    setForm((f) => ({ ...f, symbol: r3.contract }));
    const c: Record<number, boolean> = {};
    r1.forEach((rule: Rule) => (c[rule.id] = false));
    setChecked(c);
    setPreMarketHistory(r4);
    setOiLevels(r5);
    setIntradayChecks(r6);
    setEmoEntries(r7);
    setSnapshots(r8);
    const today = tradingDayKey(new Date());
    const todayEntry = r4.find((p: PreMarketPrep) => tradingDayKey(new Date(p.date)) === today);
    if (todayEntry) {
      setPreMarketForm({
        qqqPrice: String(todayEntry.qqqPrice),
        multiplier: String(todayEntry.multiplier),
        estimatedMove: String(todayEntry.estimatedMove),
        openInterestNotes: todayEntry.openInterestNotes || "",
      });
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (form.entry && form.exit) {
      const entry = parseFloat(form.entry), exit = parseFloat(form.exit), size = parseFloat(form.size) || 1;
      if (!isNaN(entry) && !isNaN(exit)) {
        const points = form.dir === "long" ? exit - entry : entry - exit;
        const mult = settings.multiplier || 20;
        setForm((f) => ({ ...f, pnl: (points * mult * size).toFixed(2) }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.entry, form.exit, form.size, form.dir]);

  if (loading) {
    return <div className="wrap"><p className="subhead">Loading cockpit...</p></div>;
  }

  // ---- derived stats ----
  // Trades synced from Tradovate carry which environment (demo/live) they
  // came from. Manually-logged trades aren't tied to either and are always
  // included. Without this filter, a demo test trade's P&L would silently
  // combine with real Live P&L in the exact numbers used for the Daily Loss
  // Limit guard's display and the Discipline Gauge — worth being strict here.
  const envFilteredTrades = trades.filter((t) => t.source === "manual" || t.source === settings.tradovateEnv);
  const ratedTrades = envFilteredTrades.filter((t) => t.disciplined !== null);
  const disciplineScore = ratedTrades.length ? Math.round((ratedTrades.filter((t) => t.disciplined).length / ratedTrades.length) * 100) : null;
  const today = tradingDayKey(new Date());
  const todaysTrades = envFilteredTrades.filter((t) => tradingDayKey(new Date(t.date)) === today);
  const todaysPnl = todaysTrades.reduce((s, t) => s + t.pnl, 0);
  let streak = 0;
  for (let i = envFilteredTrades.length - 1; i >= 0; i--) {
    if (envFilteredTrades[i].disciplined === null) continue; // unrated (synced) trades don't affect the streak
    if (envFilteredTrades[i].disciplined) streak++;
    else break;
  }
  const limit = settings.dailyLossLimit;
  const lossUsed = Math.min(Math.max(-todaysPnl, 0), limit);
  const lossPct = limit > 0 ? Math.min((lossUsed / limit) * 100, 100) : 0;
  const scoreColor = disciplineScore === null ? "var(--muted)" : disciplineScore >= 80 ? "var(--cyan)" : disciplineScore >= 50 ? "var(--amber)" : "var(--red)";

  // ---- actions ----
  async function toggleRule(id: number) {
    setChecked((c) => ({ ...c, [id]: !c[id] }));
  }
  async function addRule() {
    if (!newRuleText.trim()) return;
    const rule = await fetch("/api/rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newRuleText.trim() }),
    }).then((r) => r.json());
    setRules((r) => [...r, rule]);
    setChecked((c) => ({ ...c, [rule.id]: false }));
    setNewRuleText("");
  }
  async function deleteRule(id: number) {
    await fetch("/api/rules", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setRules((r) => r.filter((x) => x.id !== id));
  }
  async function logTrade() {
    const pnl = parseFloat(form.pnl);
    if (isNaN(pnl)) { alert("Enter a P&L amount (or fill entry/exit/contracts to auto-calc)."); return; }
    const disciplined = rules.every((r) => checked[r.id]);
    const checklistSnapshot = rules.map((r) => ({ rule: r.text, passed: !!checked[r.id] }));
    // Entry/Exit Time fields are just a time-of-day (HH:MM) — assumes the
    // trade happened today, since this form is for logging trades as you
    // take them, not backdating old ones. Left blank, entryDate stays null
    // (hold time won't be available for this trade) and date defaults to
    // "now" server-side, same as before these fields existed.
    const todayStr = new Date().toDateString();
    const entryDateIso = form.entryTime ? new Date(`${todayStr} ${form.entryTime}`).toISOString() : undefined;
    const exitDateIso = form.exitTime ? new Date(`${todayStr} ${form.exitTime}`).toISOString() : undefined;
    const trade = await fetch("/api/trades", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // Tags this entry with whichever Tradovate account (Demo/Live) is
      // currently selected in Settings — otherwise every manually-logged
      // trade defaulted to the generic "manual" tag regardless of account,
      // which made the Demo/Live filter on the top summary bar and
      // Dashboard a no-op for almost all real usage.
      body: JSON.stringify({
        ...form, pnl, disciplined, checklistSnapshot, source: settings.tradovateEnv,
        ...(entryDateIso ? { entryDate: entryDateIso } : {}),
        ...(exitDateIso ? { date: exitDateIso } : {}),
      }),
    }).then((r) => r.json());
    setTrades((t) => [...t, trade]);
    const c: Record<number, boolean> = {};
    rules.forEach((r) => (c[r.id] = false));
    setChecked(c);
    setForm((f) => ({ ...f, entry: "", exit: "", entryTime: "", exitTime: "", pnl: "", setup: "", notes: "", plannedStop: "", plannedTarget: "" }));
    setConfirmMsg("✓ Trade logged.");
    setTimeout(() => setConfirmMsg(null), 2500);
  }
  async function deleteTrade(id: number) {
    if (!confirm("Delete this trade entry?")) return;
    await fetch(`/api/trades/${id}`, { method: "DELETE" });
    setTrades((t) => t.filter((x) => x.id !== id));
  }
  async function saveSettings(next: Settings) {
    const updated = await fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((r) => r.json());
    setSettings(updated);
    alert("Settings saved.");
  }

  async function savePreMarket() {
    const qqqPrice = parseFloat(preMarketForm.qqqPrice);
    const multiplier = parseFloat(preMarketForm.multiplier);
    const estimatedMove = parseFloat(preMarketForm.estimatedMove);
    if (isNaN(qqqPrice) || isNaN(multiplier) || isNaN(estimatedMove)) {
      alert("Fill in QQQ price, multiplier, and estimated move.");
      return;
    }
    const saved = await fetch("/api/premarket", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qqqPrice, multiplier, estimatedMove, openInterestNotes: preMarketForm.openInterestNotes }),
    }).then((r) => r.json());
    setPreMarketHistory((h) => [saved, ...h.filter((p) => p.id !== saved.id)]);
  }

  async function addEmoEntry() {
    if (!emoForm.note.trim()) {
      alert("Write something first.");
      return;
    }
    const entry = await fetch("/api/emotional-log", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: emoForm.tag, note: emoForm.note }),
    }).then((r) => r.json());
    setEmoEntries((e) => [entry, ...e]);
    setEmoForm({ tag: "", note: "" });
  }

  async function addIntradayCheck() {
    const qqqPrice = parseFloat(intradayInput);
    if (isNaN(qqqPrice)) {
      alert("Enter a QQQ price.");
      return;
    }
    const multiplier = parseFloat(preMarketForm.multiplier);
    if (isNaN(multiplier)) {
      alert("Enter today's NQ/QQQ multiplier on the Pre-Market tab first.");
      return;
    }
    const check = await fetch("/api/intraday", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qqqPrice, multiplier }),
    }).then((r) => r.json());
    setIntradayChecks((c) => [...c, check]);
    setIntradayInput("");
  }

  // Resizes/compresses an uploaded image client-side before it ever reaches
  // the server — otherwise a full-res phone screenshot (often several MB)
  // would go straight into Postgres as base64, and that adds up fast over
  // daily use. Caps the longest side at 1000px and re-encodes as JPEG at
  // 80% quality, which is plenty to read a chart but a fraction of the size.
  function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1000;
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("Canvas not supported"));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addSnapshot(file: File, note: string) {
    const imageData = await compressImage(file);
    const snapshot = await fetch("/api/snapshots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData, note: note || null }),
    }).then((r) => r.json());
    setSnapshots((s) => [snapshot, ...s]);
  }

  async function deleteSnapshot(id: number) {
    if (!confirm("Delete this snapshot?")) return;
    await fetch(`/api/snapshots/${id}`, { method: "DELETE" });
    setSnapshots((s) => s.filter((x) => x.id !== id));
  }

  async function updateSnapshotNote(id: number, note: string) {
    const updated = await fetch(`/api/snapshots/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note || null }),
    }).then((r) => r.json());
    setSnapshots((s) => s.map((x) => (x.id === id ? updated : x)));
  }

  async function addOiLevel() {
    const strike = parseFloat(oiForm.strike);
    const oi = parseFloat(oiForm.oi);
    if (isNaN(strike) || isNaN(oi)) {
      alert("Enter a strike price and an OI amount.");
      return;
    }
    const level = await fetch("/api/oi-levels", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strike, oi, note: oiForm.note }),
    }).then((r) => r.json());
    setOiLevels((l) => [level, ...l]);
    setOiForm({ strike: "", oi: "", note: "" });
  }

  async function deleteOiLevel(id: number) {
    await fetch("/api/oi-levels", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setOiLevels((l) => l.filter((x) => x.id !== id));
  }

  const allChecked = rules.length > 0 && rules.every((r) => checked[r.id]);

  const todayStr = tradingDayKey(new Date());
  const latestIntradayToday = [...intradayChecks].reverse().find((c) => tradingDayKey(new Date(c.date)) === todayStr);
  const todayPrepForForm = preMarketHistory.find((p) => tradingDayKey(new Date(p.date)) === todayStr);
  const journalLastKnownPrice = latestIntradayToday?.nqPrice ?? todayPrepForForm?.nqPrice ?? null;

  const RISK_TAGS = ["FOMO", "Tilted / Revenge", "Overconfident", "Doubt"];
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentRiskyEntries = emoEntries.filter((e) => new Date(e.date) >= sevenDaysAgo && e.tag && RISK_TAGS.includes(e.tag));
  const riskyTagCounts: Record<string, number> = {};
  recentRiskyEntries.forEach((e) => { riskyTagCounts[e.tag!] = (riskyTagCounts[e.tag!] || 0) + 1; });
  const showRiskyBanner = recentRiskyEntries.length >= 3;

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <div className="brand">NQ <span>COCKPIT</span></div>
          <div className="subhead">Discipline Instrumentation // Personal Trading Log</div>
        </div>
        <div className="subhead">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>
      </div>

      {showRiskyBanner && (
        <div className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)", marginBottom: 16 }}>
          ⚠ {recentRiskyEntries.length} FOMO/Tilted/Overconfident/Doubt entries logged in the last 7 days
          ({Object.entries(riskyTagCounts).map(([tag, count]) => `${tag}: ${count}`).join(" · ")}).
          Check Dashboard → Emotional Patterns for how those days actually performed.
        </div>
      )}

      <div className="strip">
        <div className="gauge-card">
          <div className="card-label">Discipline Gauge — All-Time ({settings.tradovateEnv === "live" ? "LIVE" : "DEMO"} + manual)</div>
          <div className="dial-wrap">
            <Dial score={disciplineScore} color={scoreColor} />
            <div>
              <div className="dial-num" style={{ color: scoreColor }}>{disciplineScore === null ? "—" : disciplineScore + "%"}</div>
              <div className="card-sub">{ratedTrades.length} rated trade(s) ({envFilteredTrades.length} total)</div>
            </div>
          </div>
        </div>
        <div className="gauge-card">
          <div className="card-label">Today's P&amp;L ({settings.tradovateEnv === "live" ? "LIVE" : "DEMO"} + manual)</div>
          <div className={`card-value ${todaysPnl > 0 ? "pos" : todaysPnl < 0 ? "neg" : ""}`}>{fmtMoney(todaysPnl)}</div>
          <div className="card-sub">{todaysTrades.length} trade(s) today</div>
        </div>
        <div className="gauge-card">
          <div className="card-label">Discipline Streak — All-Time ({settings.tradovateEnv === "live" ? "LIVE" : "DEMO"} + manual)</div>
          <div className={`card-value ${streak > 0 ? "pos" : ""}`}>{streak}</div>
          <div className="card-sub">consecutive clean trades</div>
        </div>
        <div className="gauge-card">
          <div className="card-label">Daily Loss Limit — Today ({settings.tradovateEnv === "live" ? "LIVE" : "DEMO"} + manual)</div>
          <div className={`card-value ${lossPct >= 100 ? "neg" : lossPct >= 70 ? "warn" : ""}`}>{fmtMoney(-lossUsed)} / {fmtMoney(-limit)}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${lossPct}%`, background: lossPct >= 100 ? "var(--red)" : lossPct >= 70 ? "var(--amber)" : "var(--cyan)" }} /></div>
        </div>
      </div>

      <div className="tabs">
        {(["premarket", "intraday", "emojournal", "tradeticket", "tvanalytics", "checklist", "journal", "dashboard", "reports", "settings"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "checklist" ? "Pre-Trade" : t === "premarket" ? "Pre-Market" : t === "tradeticket" ? "Trade Ticket" : t === "tvanalytics" ? "TV Analytics" : t === "emojournal" ? "Emotional Journal" : t}
          </button>
        ))}
      </div>

      {confirmMsg && <div className="status-banner status-clear">{confirmMsg}</div>}

      {tab === "tradeticket" && <TradeTicketTab settings={settings} />}
      {tab === "tvanalytics" && <TVAnalyticsTab settings={settings} trades={trades} onTradeSynced={(t) => setTrades((prev) => [...prev, t])} onTradeUpdated={(t) => setTrades((prev) => prev.map((p) => (p.id === t.id ? t : p)))} />}
      {tab === "emojournal" && <EmotionalJournalTab form={emoForm} setForm={setEmoForm} onSave={addEmoEntry} entries={emoEntries} />}

      {tab === "intraday" && (
        <IntradayTab
          input={intradayInput}
          setInput={setIntradayInput}
          onCheck={addIntradayCheck}
          checks={intradayChecks}
          todayPrep={preMarketHistory.find((p) => tradingDayKey(new Date(p.date)) === tradingDayKey(new Date())) || null}
          oiLevels={oiLevels}
          snapshots={snapshots}
          addSnapshot={addSnapshot}
          deleteSnapshot={deleteSnapshot}
          updateSnapshotNote={updateSnapshotNote}
        />
      )}

      {tab === "premarket" && (
        <PreMarketTab
          form={preMarketForm}
          setForm={setPreMarketForm}
          onSave={savePreMarket}
          history={preMarketHistory}
          oiLevels={oiLevels}
          oiForm={oiForm}
          setOiForm={setOiForm}
          onAddOi={addOiLevel}
          onDeleteOi={deleteOiLevel}
        />
      )}

      {tab === "reports" && <ReportsTab trades={trades} snapshots={snapshots} settings={settings} />}

      {tab === "checklist" && (
        <>
          <div className="panel-box">
            <div className="panel-title">Pre-Trade Checklist</div>
            <div className="panel-desc">Run through this before you enter. Skipping a check doesn't block you — but it will show up in your stats.</div>
            {rules.map((rule) => (
              <div key={rule.id} className={`rule-row ${checked[rule.id] ? "checked" : ""}`} onClick={() => toggleRule(rule.id)}>
                <div className="rule-check">{checked[rule.id] ? "✓" : ""}</div>
                <div className="rule-text">{rule.text}</div>
                <button className="rule-del" onClick={(e) => { e.stopPropagation(); deleteRule(rule.id); }}>✕</button>
              </div>
            ))}
            <div className="add-rule">
              <input value={newRuleText} onChange={(e) => setNewRuleText(e.target.value)} placeholder="Add a rule..." />
              <button className="btn small" onClick={addRule}>Add</button>
            </div>
            <div className={`status-banner ${allChecked ? "status-clear" : "status-warn"}`}>
              {allChecked ? "✓ ALL CLEAR — cleared for entry." : `⚠ ${rules.filter((r) => !checked[r.id]).length} rule(s) not confirmed. You can still log the trade, but it will be flagged undisciplined.`}
            </div>
          </div>

          <div className="panel-box">
            <div className="panel-title">Log This Trade</div>
            <div className="panel-desc">Checklist state above will be attached to this trade automatically.</div>
            <div className="grid3">
              <div className="field"><label>Symbol</label>
                <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>
                  <option value="NQ">NQ</option>
                  <option value="MNQ">MNQ</option>
                  <option value="ES">ES</option>
                  <option value="MES">MES</option>
                </select>
              </div>
              <div className="field"><label>Direction</label>
                <select value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}>
                  <option value="long">Long</option><option value="short">Short</option>
                </select>
              </div>
              <div className="field"><label>Session</label>
                <select value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value })}>
                  <option>NY Open</option><option>NY AM</option><option>NY PM</option><option>London</option><option>Asia</option><option>Overnight</option>
                </select>
              </div>
            </div>
            <div className="grid3">
              <div className="field">
                <label>Entry Price</label>
                <input type="number" step="0.25" value={form.entry} onChange={(e) => setForm({ ...form, entry: e.target.value })} />
                {journalLastKnownPrice !== null && (
                  <button type="button" className="btn small ghost" style={{ marginTop: 6 }} onClick={() => setForm((f) => ({ ...f, entry: String(roundToTick(journalLastKnownPrice)) }))}>
                    Use last known price ({roundToTick(journalLastKnownPrice).toFixed(2)})
                  </button>
                )}
              </div>
              <div className="field">
                <label>Exit Price</label>
                <input type="number" step="0.25" value={form.exit} onChange={(e) => setForm({ ...form, exit: e.target.value })} />
                {journalLastKnownPrice !== null && (
                  <button type="button" className="btn small ghost" style={{ marginTop: 6 }} onClick={() => setForm((f) => ({ ...f, exit: String(roundToTick(journalLastKnownPrice)) }))}>
                    Use last known price ({roundToTick(journalLastKnownPrice).toFixed(2)})
                  </button>
                )}
              </div>
              <div className="field"><label>Contracts</label><input type="number" min="1" value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} /></div>
            </div>
            <div className="grid2">
              <div className="field">
                <label>Entry Time (optional)</label>
                <input type="time" value={form.entryTime} onChange={(e) => setForm({ ...form, entryTime: e.target.value })} />
              </div>
              <div className="field">
                <label>Exit Time (optional)</label>
                <input type="time" value={form.exitTime} onChange={(e) => setForm({ ...form, exitTime: e.target.value })} />
              </div>
            </div>
            <div className="panel-desc" style={{ marginTop: -8 }}>
              Both optional — fill them in and Hold Time will show correctly in Reports and the Journal. Leave blank and it'll show — same as before these fields existed. Assumes today's date (this form is for logging trades as you take them, not backdating old ones).
            </div>
            <div className="grid2">
              <div className="field"><label>P&amp;L ($) — auto or manual</label><input type="number" step="0.01" value={form.pnl} onChange={(e) => setForm({ ...form, pnl: e.target.value })} /></div>
              <div className="field"><label>Setup Tag</label><input value={form.setup} onChange={(e) => setForm({ ...form, setup: e.target.value })} placeholder="e.g. ORB, VWAP reclaim" /></div>
            </div>
            <div className="grid2">
              <div className="field"><label>Planned Stop (price)</label><input type="number" step="0.25" value={form.plannedStop} onChange={(e) => setForm({ ...form, plannedStop: e.target.value })} placeholder="Where you'd planned to cut it" /></div>
              <div className="field"><label>Planned Target (price)</label><input type="number" step="0.25" value={form.plannedTarget} onChange={(e) => setForm({ ...form, plannedTarget: e.target.value })} placeholder="Where you'd planned to take profit" /></div>
            </div>
            <div className="panel-desc" style={{ marginTop: -8 }}>
              Optional, but this is what lets the Journal and Dashboard tell you honestly whether you let a loser run past your own plan, or took profit early relative to your own target — not my opinion, your stated plan vs. what actually happened.
            </div>
            <div className="field">
              <label>Emotional State</label>
              <select value={form.emotion} onChange={(e) => setForm({ ...form, emotion: e.target.value })}>
                <option>Calm / neutral</option><option>Confident</option><option>Anxious</option><option>FOMO</option><option>Tilted / revenge</option><option>Bored / distracted</option>
              </select>
            </div>
            <div className="field"><label>Notes</label><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What did you see? What would you tell a friend about this trade?" /></div>
            <button className="btn primary" onClick={logTrade}>Log Trade</button>
          </div>
        </>
      )}

      {tab === "journal" && (
        <div className="panel-box">
          <div className="panel-title">Trade Journal</div>
          {trades.length === 0 ? (
            <div className="empty-state"><div className="big">📋</div>No trades logged yet.<br />Head to Pre-Trade to log your first one.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Time</th><th>Sym</th><th>Dir</th><th>Setup</th><th>P&amp;L</th><th>Discipline</th><th>Source</th><th>Emotion</th><th>Plan Check</th><th></th></tr></thead>
                <tbody>
                  {[...trades].reverse().map((t) => {
                    const d = new Date(t.date);
                    const flags = analyzeTradeDiscipline(t);
                    return (
                      <tr key={t.id}>
                        <td>{d.toLocaleDateString()} {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                        <td>{t.symbol}</td>
                        <td><span className={`tag ${t.dir}`}>{t.dir.toUpperCase()}</span></td>
                        <td>{t.setup || "—"}</td>
                        <td className={t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(t.pnl)}</td>
                        <td><span className={`tag ${t.disciplined === null ? "na" : t.disciplined ? "clean" : "flag"}`}>{t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</span></td>
                        <td><span className={`tag ${t.source === "live" ? "short" : t.source === "demo" ? "na" : "long"}`}>{t.source.toUpperCase()}</span></td>
                        <td>{t.emotion}</td>
                        <td>
                          {flags.length === 0 ? "—" : flags.map((f, i) => (
                            <span key={i} className="tag flag" style={{ display: "block", marginBottom: 2 }}>
                              {f.type === "ran_loser" ? "⚠ RAN LOSER" : "⚠ EARLY EXIT"}
                            </span>
                          ))}
                        </td>
                        <td>
                          <button className="btn small ghost" onClick={() => setViewTradeId(viewTradeId === t.id ? null : t.id)}>View</button>{" "}
                          <button className="btn small ghost" onClick={() => deleteTrade(t.id)}>Del</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {viewTradeId !== null && (() => {
            const t = trades.find((x) => x.id === viewTradeId);
            if (!t) return null;
            const flags = analyzeTradeDiscipline(t);
            return (
              <div className="panel-box" style={{ marginTop: 16 }}>
                <div className="panel-title">Trade Detail — {new Date(t.date).toLocaleString()}</div>
                {flags.length > 0 && (
                  <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    {flags.map((f, i) => (
                      <div key={i} className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" }}>
                        ⚠ {f.text}
                      </div>
                    ))}
                  </div>
                )}
                {t.plannedStop !== null || t.plannedTarget !== null ? (
                  <div className="card-sub" style={{ marginBottom: 10 }}>
                    Planned: {t.plannedStop !== null ? `stop ${t.plannedStop.toFixed(2)}` : "no stop declared"}
                    {" · "}
                    {t.plannedTarget !== null ? `target ${t.plannedTarget.toFixed(2)}` : "no target declared"}
                    {" · "}actual exit {t.exit?.toFixed(2) ?? "—"}
                  </div>
                ) : null}
                <p style={{ fontSize: 13, color: "var(--text)", whiteSpace: "pre-wrap" }}>{escapeHtml(t.notes) || "(no notes)"}</p>
                <div className="rule-toggle-list">
                  {t.checklistSnapshot.map((c, i) => (
                    <span key={i} className={`mini-tag ${c.passed ? "" : "on"}`}>{c.passed ? "✓" : "✕"} {c.rule}</span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === "dashboard" && <Dashboard trades={envFilteredTrades} allTrades={trades} emoEntries={emoEntries} envLabel={settings.tradovateEnv === "live" ? "LIVE" : "DEMO"} />}

      {tab === "settings" && <SettingsPanel settings={settings} onSave={saveSettings} />}

      <div className="footer-note">Data is stored in your own database — private to your account.</div>
    </div>
  );
}

function Dial({ score, color }: { score: number | null; color: string }) {
  const pct = score === null ? 0 : score;
  const r = 26, circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform="rotate(-90 32 32)" style={{ transition: "stroke-dashoffset .4s" }} />
    </svg>
  );
}

function PreMarketTab({
  form,
  setForm,
  onSave,
  history,
  oiLevels,
  oiForm,
  setOiForm,
  onAddOi,
  onDeleteOi,
}: {
  form: { qqqPrice: string; multiplier: string; estimatedMove: string; openInterestNotes: string };
  setForm: (f: { qqqPrice: string; multiplier: string; estimatedMove: string; openInterestNotes: string }) => void;
  onSave: () => void;
  history: PreMarketPrep[];
  oiLevels: OILevel[];
  oiForm: { strike: string; oi: string; note: string };
  setOiForm: (f: { strike: string; oi: string; note: string }) => void;
  onAddOi: () => void;
  onDeleteOi: (id: number) => void;
}) {
  const qqq = parseFloat(form.qqqPrice);
  const mult = parseFloat(form.multiplier);
  const move = parseFloat(form.estimatedMove);
  const valid = !isNaN(qqq) && !isNaN(mult) && !isNaN(move);
  const nqPrice = valid ? qqq * mult : null;
  const nqMove = valid ? move * mult : null;
  const nqHigh = valid ? nqPrice! + nqMove! : null;
  const nqLow = valid ? nqPrice! - nqMove! : null;
  const qqqHigh = valid ? qqq + move : null;
  const qqqLow = valid ? qqq - move : null;

  const [ladderRange, setLadderRange] = useState("20");
  const [ladderStep, setLadderStep] = useState("1");
  const rangeNum = parseFloat(ladderRange) || 20;
  const stepNum = parseFloat(ladderStep) || 1;

  const ladderRows: { qqq: number; nq: number; isAnchor: boolean }[] = [];
  if (valid && stepNum > 0) {
    const start = Math.ceil((qqq - rangeNum) / stepNum) * stepNum;
    const end = qqq + rangeNum;
    for (let level = end; level >= start - 0.0001; level -= stepNum) {
      const rounded = Math.round(level * 100) / 100;
      ladderRows.push({ qqq: rounded, nq: rounded * mult, isAnchor: Math.abs(rounded - qqq) < stepNum / 2 });
    }
  }

  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Pre-Market Prep</div>
        <div className="panel-desc">Enter today's QQQ price, the NQ/QQQ multiplier, and your estimated move. NQ price is calculated for you.</div>
        <div className="grid3">
          <div className="field"><label>QQQ Price</label>
            <input type="number" step="0.01" value={form.qqqPrice} onChange={(e) => setForm({ ...form, qqqPrice: e.target.value })} placeholder="e.g. 512.30" />
          </div>
          <div className="field"><label>NQ/QQQ Multiplier</label>
            <input type="number" step="0.01" value={form.multiplier} onChange={(e) => setForm({ ...form, multiplier: e.target.value })} placeholder="e.g. 41.36" />
          </div>
          <div className="field"><label>Estimated Move (QQQ points)</label>
            <input type="number" step="0.5" value={form.estimatedMove} onChange={(e) => setForm({ ...form, estimatedMove: e.target.value })} placeholder="e.g. 10" />
          </div>
        </div>
        <div className="field">
          <label>Open Interest Notes</label>
          <textarea value={form.openInterestNotes} onChange={(e) => setForm({ ...form, openInterestNotes: e.target.value })} placeholder="Anything notable pre-market — heavy call/put walls, gamma flip level, unusual OI shifts, etc." />
        </div>
        <button className="btn primary" onClick={onSave} disabled={!valid}>Save Today's Prep</button>

        {valid && (
          <div style={{ marginTop: 24 }}>
            <div className="card-label" style={{ marginBottom: 12 }}>CALCULATED NQ PRICE</div>
            <div className="dial-num" style={{ color: "var(--cyan)", marginBottom: 20 }}>{nqPrice!.toFixed(2)}</div>
            <RangeBar label="NQ" low={nqLow!} mid={nqPrice!} high={nqHigh!} />
            <div style={{ height: 16 }} />
            <RangeBar label="QQQ" low={qqqLow!} mid={qqq} high={qqqHigh!} />
          </div>
        )}
      </div>

      {valid && (
        <div className="panel-box">
          <div className="panel-title">QQQ / NQ Price Ladder</div>
          <div className="panel-desc">Every QQQ level around today's price, mapped to its NQ equivalent.</div>
          <div className="grid2" style={{ marginBottom: 16 }}>
            <div className="field"><label>Range (± QQQ points)</label>
              <input type="number" step="1" value={ladderRange} onChange={(e) => setLadderRange(e.target.value)} />
            </div>
            <div className="field"><label>Step (QQQ points)</label>
              <input type="number" step="0.5" value={ladderStep} onChange={(e) => setLadderStep(e.target.value)} />
            </div>
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto", overflowX: "auto" }}>
            <table>
              <thead style={{ position: "sticky", top: 0, background: "var(--panel)" }}>
                <tr><th>QQQ</th><th>NQ</th></tr>
              </thead>
              <tbody>
                {ladderRows.map((row) => (
                  <tr key={row.qqq} style={row.isAnchor ? { background: "rgba(245,166,35,0.12)" } : undefined}>
                    <td style={row.isAnchor ? { color: "var(--amber)", fontWeight: 600 } : undefined}>
                      {row.qqq.toFixed(2)}{row.isAnchor ? "  ← today" : ""}
                    </td>
                    <td style={row.isAnchor ? { color: "var(--amber)", fontWeight: 600 } : undefined}>
                      {row.nq.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel-box">
        <div className="panel-title">Recent Prep History</div>
        {history.length === 0 ? (
          <div className="empty-state">No prep logged yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Date</th><th>QQQ</th><th>Multiplier</th><th>NQ (calc)</th><th>Est. Move (QQQ)</th><th>OI Notes</th></tr></thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id}>
                    <td>{new Date(p.date).toLocaleDateString()}</td>
                    <td>{p.qqqPrice.toFixed(2)}</td>
                    <td>{p.multiplier}</td>
                    <td>{p.nqPrice.toFixed(2)}</td>
                    <td>±{p.estimatedMove}</td>
                    <td style={{ maxWidth: 240, whiteSpace: "normal" }}>{p.openInterestNotes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel-box">
        <div className="panel-title">Open Interest Levels</div>
        <div className="panel-desc">Log notable strikes and their OI before the open — useful support/resistance reference for the day.</div>
        <div className="grid3">
          <div className="field"><label>Strike</label>
            <input type="number" step="1" value={oiForm.strike} onChange={(e) => setOiForm({ ...oiForm, strike: e.target.value })} placeholder="e.g. 700" />
          </div>
          <div className="field"><label>Open Interest</label>
            <input type="number" step="1" value={oiForm.oi} onChange={(e) => setOiForm({ ...oiForm, oi: e.target.value })} placeholder="e.g. 45000" />
          </div>
          <div className="field"><label>Note</label>
            <input value={oiForm.note} onChange={(e) => setOiForm({ ...oiForm, note: e.target.value })} placeholder="e.g. call wall" />
          </div>
        </div>
        <button className="btn small" onClick={onAddOi}>Add Level</button>

        {oiLevels.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 16 }}>No levels logged yet.</div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <table>
              <thead><tr><th>Date</th><th>Strike</th><th>OI</th><th>Note</th><th></th></tr></thead>
              <tbody>
                {oiLevels.map((l) => (
                  <tr key={l.id}>
                    <td>{new Date(l.date).toLocaleDateString()}</td>
                    <td>{l.strike}</td>
                    <td>{l.oi.toLocaleString()}</td>
                    <td>{l.note || "—"}</td>
                    <td><button className="btn small ghost" onClick={() => onDeleteOi(l.id)}>Del</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function RangeBar({ label, low, mid, high }: { label: string; low: number; mid: number; high: number }) {
  const pct = ((mid - low) / (high - low)) * 100;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="card-label">{label} PROJECTED RANGE</span>
        <span className="card-sub">{low.toFixed(2)} — {high.toFixed(2)}</span>
      </div>
      <div style={{ position: "relative", height: 10, background: "var(--panel-2)", borderRadius: 5, border: "1px solid var(--line)" }}>
        <div
          style={{
            position: "absolute",
            left: `calc(${pct}% - 6px)`,
            top: -5,
            width: 12,
            height: 20,
            borderRadius: 3,
            background: "var(--amber)",
            border: "2px solid var(--bg)",
          }}
          title={`${label}: ${mid.toFixed(2)}`}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--muted)", fontFamily: "'IBM Plex Mono',monospace" }}>
        <span>LOW {low.toFixed(2)}</span>
        <span style={{ color: "var(--amber)" }}>ANCHOR {mid.toFixed(2)}</span>
        <span>HIGH {high.toFixed(2)}</span>
      </div>
    </div>
  );
}

type Observation = { level: "info" | "warning" | "critical"; text: string };

function buildObservations(
  currentQqq: number,
  prep: PreMarketPrep | null,
  oiLevels: OILevel[],
  checks: IntradayCheckT[]
): Observation[] {
  const obs: Observation[] = [];

  if (!prep) {
    obs.push({ level: "info", text: "No Pre-Market prep logged today — log QQQ price + estimated move on the Pre-Market tab for range context." });
  } else {
    const moveFromAnchor = currentQqq - prep.qqqPrice;
    const pct = (Math.abs(moveFromAnchor) / prep.estimatedMove) * 100;
    const dir = moveFromAnchor >= 0 ? "up" : "down";
    if (pct >= 100) {
      obs.push({
        level: "critical",
        text: `Price has moved ${Math.abs(moveFromAnchor).toFixed(2)} QQQ pts ${dir} from this morning's anchor (${prep.qqqPrice.toFixed(2)}) — ${pct.toFixed(0)}% of your estimated move, already exceeded. This is now outside your normal-day scenario.`,
      });
    } else if (pct >= 70) {
      obs.push({
        level: "warning",
        text: `Nearing your estimated move — ${pct.toFixed(0)}% used (${Math.abs(moveFromAnchor).toFixed(2)} of ${prep.estimatedMove} QQQ pts, moving ${dir}).`,
      });
    } else if (pct >= 30) {
      obs.push({ level: "info", text: `${pct.toFixed(0)}% of today's estimated move used so far (${dir}).` });
    } else {
      obs.push({ level: "info", text: `Within normal range — only ${pct.toFixed(0)}% of estimated move used.` });
    }
  }

  const todayLevels = oiLevels.filter((l) => tradingDayKey(new Date(l.date)) === tradingDayKey(new Date()));
  todayLevels.forEach((level) => {
    const distance = Math.abs(currentQqq - level.strike);
    if (distance <= 2) {
      obs.push({
        level: "warning",
        text: `Within ${distance.toFixed(2)} pts of logged OI level ${level.strike} (OI ${level.oi.toLocaleString()})${level.note ? " — " + level.note : ""}.`,
      });
    }
  });

  if (checks.length > 0) {
    const last = checks[checks.length - 1];
    const timeDiffMin = (Date.now() - new Date(last.date).getTime()) / 60000;
    if (timeDiffMin > 0 && timeDiffMin <= 60) {
      const nqDelta = (currentQqq - last.qqqPrice) * (last.nqPrice / last.qqqPrice);
      const rate = nqDelta / timeDiffMin;
      if (Math.abs(rate) >= 5) {
        obs.push({
          level: "warning",
          text: `Fast move detected: ${nqDelta >= 0 ? "+" : ""}${nqDelta.toFixed(1)} NQ pts in ${timeDiffMin.toFixed(0)} min since last check (~${rate.toFixed(1)} pts/min).`,
        });
      }
    }
  }

  return obs;
}

function computeIntradayChartData(checks: IntradayCheckT[], todayPrep: PreMarketPrep | null, w: number, h: number, pad: number) {
  const nqLow = todayPrep ? (todayPrep.qqqPrice - todayPrep.estimatedMove) * todayPrep.multiplier : null;
  const nqHigh = todayPrep ? (todayPrep.qqqPrice + todayPrep.estimatedMove) * todayPrep.multiplier : null;
  const nqAnchor = todayPrep ? todayPrep.nqPrice : null;

  const values = checks.map((c) => c.nqPrice);
  if (nqLow !== null) values.push(nqLow);
  if (nqHigh !== null) values.push(nqHigh);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;

  const times = checks.map((c) => new Date(c.date).getTime());
  const minT = times.length ? Math.min(...times) : 0;
  const maxT = times.length ? Math.max(...times) : 1;
  const tRange = maxT - minT || 1;

  const scaleX = (t: number) => pad + ((t - minT) / tRange) * (w - 2 * pad);
  const scaleY = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);

  const coords = checks.map((c) => `${scaleX(new Date(c.date).getTime())},${scaleY(c.nqPrice)}`).join(" ");

  return {
    coords,
    nqLowY: nqLow !== null ? scaleY(nqLow) : null,
    nqHighY: nqHigh !== null ? scaleY(nqHigh) : null,
    nqAnchorY: nqAnchor !== null ? scaleY(nqAnchor) : null,
    nqLow, nqHigh, nqAnchor,
    points: checks.map((c) => ({ x: scaleX(new Date(c.date).getTime()), y: scaleY(c.nqPrice), label: new Date(c.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), value: c.nqPrice })),
  };
}

function IntradayChart({ checks, todayPrep }: { checks: IntradayCheckT[]; todayPrep: PreMarketPrep | null }) {
  const w = 900, h = 220, pad = 30;
  if (checks.length === 0) {
    return <div className="empty-state">Log at least one Intraday check to see today's chart.</div>;
  }
  const data = computeIntradayChartData(checks, todayPrep, w, h, pad);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 220 }} preserveAspectRatio="none">
      {data.nqHighY !== null && (
        <>
          <line x1={pad} y1={data.nqHighY} x2={w - pad} y2={data.nqHighY} stroke="var(--red)" strokeDasharray="4 4" />
          <text x={w - pad} y={data.nqHighY - 4} fill="var(--red)" fontSize="10" textAnchor="end">Est. High {data.nqHigh?.toFixed(1)}</text>
        </>
      )}
      {data.nqLowY !== null && (
        <>
          <line x1={pad} y1={data.nqLowY} x2={w - pad} y2={data.nqLowY} stroke="var(--red)" strokeDasharray="4 4" />
          <text x={w - pad} y={data.nqLowY + 12} fill="var(--red)" fontSize="10" textAnchor="end">Est. Low {data.nqLow?.toFixed(1)}</text>
        </>
      )}
      {data.nqAnchorY !== null && (
        <line x1={pad} y1={data.nqAnchorY} x2={w - pad} y2={data.nqAnchorY} stroke="var(--amber)" strokeDasharray="2 3" />
      )}
      <polyline points={data.coords} fill="none" stroke="var(--cyan)" strokeWidth="2" />
      {data.points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--cyan)" />
      ))}
    </svg>
  );
}

function buildIntradayHtmlReport(checks: IntradayCheckT[], todayPrep: PreMarketPrep | null) {
  const w = 900, h = 220, pad = 30;
  const data = computeIntradayChartData(checks, todayPrep, w, h, pad);
  const svg = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:220px;background:#121B2E;border-radius:8px;" xmlns="http://www.w3.org/2000/svg">
      ${data.nqHighY !== null ? `<line x1="${pad}" y1="${data.nqHighY}" x2="${w - pad}" y2="${data.nqHighY}" stroke="#E5484D" stroke-dasharray="4 4"/><text x="${w - pad}" y="${data.nqHighY - 4}" fill="#E5484D" font-size="10" text-anchor="end">Est. High ${data.nqHigh?.toFixed(1)}</text>` : ""}
      ${data.nqLowY !== null ? `<line x1="${pad}" y1="${data.nqLowY}" x2="${w - pad}" y2="${data.nqLowY}" stroke="#E5484D" stroke-dasharray="4 4"/><text x="${w - pad}" y="${data.nqLowY + 12}" fill="#E5484D" font-size="10" text-anchor="end">Est. Low ${data.nqLow?.toFixed(1)}</text>` : ""}
      ${data.nqAnchorY !== null ? `<line x1="${pad}" y1="${data.nqAnchorY}" x2="${w - pad}" y2="${data.nqAnchorY}" stroke="#F5A623" stroke-dasharray="2 3"/>` : ""}
      <polyline points="${data.coords}" fill="none" stroke="#3FD0C9" stroke-width="2"/>
      ${data.points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#3FD0C9"/>`).join("")}
    </svg>`;

  const rows = checks.map((c) => `
    <tr><td>${new Date(c.date).toLocaleTimeString()}</td><td>${c.qqqPrice.toFixed(2)}</td><td>${c.nqPrice.toFixed(2)}</td></tr>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>NQ Cockpit — Intraday Chart</title>
<style>
body{font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:32px;}
h1{color:#F5A623;} table{border-collapse:collapse;width:100%;margin-top:16px;}
th,td{padding:8px 10px;border-bottom:1px solid #263654;text-align:left;font-size:13px;}
th{color:#7F8CA6;text-transform:uppercase;font-size:11px;}
</style></head>
<body>
<h1>NQ COCKPIT — Intraday Chart</h1>
<p>${new Date().toLocaleDateString()} · ${checks.length} check(s) logged</p>
${todayPrep ? `<p>Anchor: ${todayPrep.nqPrice.toFixed(2)} · Estimated move: ±${todayPrep.estimatedMove} QQQ pts</p>` : "<p>No Pre-Market prep logged today.</p>"}
${svg}
<table><thead><tr><th>Time</th><th>QQQ</th><th>NQ</th></tr></thead><tbody>${rows}</tbody></table>
<p style="color:#7F8CA6;font-size:11px;margin-top:20px;">Auto-logged from a live QQQ quote every minute during market hours, plus any manual checks you added.</p>
</body></html>`;

  return html;
}

function downloadIntradayHtmlReport(checks: IntradayCheckT[], todayPrep: PreMarketPrep | null) {
  downloadHtmlReport(buildIntradayHtmlReport(checks, todayPrep), `nq-cockpit-intraday-${new Date().toISOString().slice(0, 10)}.html`);
}

const EMO_TAGS = ["Calm", "Confident", "Anxious", "FOMO", "Doubt", "Overconfident", "Tilted / Revenge", "Fear of losing gains", "Impatient", "Bored"];

function EmotionalJournalTab({
  form,
  setForm,
  onSave,
  entries,
}: {
  form: { tag: string; note: string };
  setForm: (f: { tag: string; note: string }) => void;
  onSave: () => void;
  entries: EmotionalEntry[];
}) {
  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Log What's In Your Head</div>
        <div className="panel-desc">
          While you're in a trade, the thoughts racing through your head are the actual data. Tag it if one fits,
          then just write — this isn't for polished reflection, it's for catching yourself in the moment.
        </div>
        <div className="rule-toggle-list" style={{ marginBottom: 14 }}>
          {EMO_TAGS.map((t) => (
            <span
              key={t}
              className={`mini-tag ${form.tag === t ? "on" : ""}`}
              style={{ cursor: "pointer", ...(form.tag === t ? { borderColor: "var(--cyan)", color: "var(--cyan)", background: "rgba(63,208,201,0.1)" } : {}) }}
              onClick={() => setForm({ ...form, tag: form.tag === t ? "" : t })}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="field">
          <textarea
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="e.g. 'Down 2 points and already thinking about moving my stop. Feels like it's about to reverse but I have no real reason to think that.'"
            style={{ minHeight: 100 }}
          />
        </div>
        <button className="btn primary" onClick={onSave}>Log Entry</button>
      </div>

      <div className="panel-box">
        <div className="panel-title">Recent Entries</div>
        {entries.length === 0 ? (
          <div className="empty-state"><div className="big">🧠</div>Nothing logged yet. Next time you're mid-trade and your head is loud, write it down here.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {entries.map((e) => (
              <div key={e.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px", background: "var(--panel-2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="card-sub" style={{ marginTop: 0 }}>{new Date(e.date).toLocaleString()}</span>
                  {e.tag && <span className="mini-tag on" style={{ borderColor: "var(--cyan)", color: "var(--cyan)" }}>{e.tag}</span>}
                </div>
                <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{e.note}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function IntradayTab({
  input,
  setInput,
  onCheck,
  checks,
  todayPrep,
  oiLevels,
  snapshots,
  addSnapshot,
  deleteSnapshot,
  updateSnapshotNote,
}: {
  input: string;
  setInput: (v: string) => void;
  onCheck: () => void;
  checks: IntradayCheckT[];
  todayPrep: PreMarketPrep | null;
  oiLevels: OILevel[];
  snapshots: ChartSnapshot[];
  addSnapshot: (file: File, note: string) => Promise<void>;
  deleteSnapshot: (id: number) => Promise<void>;
  updateSnapshotNote: (id: number, note: string) => Promise<void>;
}) {
  const qqq = parseFloat(input);
  const validInput = !isNaN(qqq);
  const valid = validInput && !!todayPrep;
  const multiplier = todayPrep?.multiplier ?? null;
  const nqPrice = valid ? qqq * multiplier! : null;
  const observations = valid ? buildObservations(qqq, todayPrep, oiLevels, checks) : [];

  const anchorLow = todayPrep ? todayPrep.qqqPrice - todayPrep.estimatedMove : null;
  const anchorHigh = todayPrep ? todayPrep.qqqPrice + todayPrep.estimatedMove : null;

  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Intraday Check</div>
        <div className="panel-desc">Punch in QQQ's current price any time during the day — NQ and today's observations update instantly.</div>
        <div className="grid2">
          <div className="field"><label>Current QQQ Price</label>
            <input type="number" step="0.01" value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. 698.50" />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn primary" onClick={onCheck} disabled={!validInput} style={{ width: "100%" }}>Log Check</button>
          </div>
        </div>

        {validInput && !todayPrep && (
          <div className="status-banner status-warn" style={{ marginTop: 16 }}>
            ⚠ No Pre-Market prep logged today, so NQ can't be calculated yet. Go to the Pre-Market tab and log today's QQQ price + multiplier first.
          </div>
        )}

        {valid && (
          <div style={{ marginTop: 20 }}>
            <div className="card-label">CALCULATED NQ PRICE</div>
            <div className="dial-num" style={{ color: "var(--cyan)", marginBottom: 16 }}>{nqPrice!.toFixed(2)}</div>

            {anchorLow !== null && anchorHigh !== null && (
              <RangeBar label="QQQ vs. today's plan" low={anchorLow} mid={qqq} high={anchorHigh} />
            )}

            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {observations.map((o, i) => (
                <div
                  key={i}
                  className={`status-banner ${o.level === "critical" ? "status-warn" : o.level === "warning" ? "status-warn" : "status-clear"}`}
                  style={o.level === "critical" ? { borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" } : undefined}
                >
                  {o.level === "critical" ? "⚠ " : o.level === "warning" ? "⚠ " : "· "}{o.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="panel-box">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div className="panel-title" style={{ margin: 0 }}>Today's Chart</div>
          <button className="btn small ghost" onClick={() => viewHtmlReport(buildIntradayHtmlReport(checks, todayPrep))} disabled={checks.length === 0}>View HTML</button>
          <button className="btn small ghost" onClick={() => downloadIntradayHtmlReport(checks, todayPrep)} disabled={checks.length === 0}>Download HTML</button>
        </div>
        <div className="panel-desc">NQ price at each logged check, against today's estimated move band. Auto-updates from a live QQQ quote every minute during market hours (9:30am–4:00pm ET) — you can still add a manual check any time too.</div>
        <IntradayChart checks={checks} todayPrep={todayPrep} />
      </div>

      <ChartSnapshotPanel snapshots={snapshots} addSnapshot={addSnapshot} deleteSnapshot={deleteSnapshot} updateSnapshotNote={updateSnapshotNote} />

      <div className="panel-box">
        <div className="panel-title">Today's Checks</div>
        {checks.length === 0 ? (
          <div className="empty-state">No checks logged yet today.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Time</th><th>QQQ</th><th>NQ</th></tr></thead>
              <tbody>
                {[...checks].reverse().map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{c.qqqPrice.toFixed(2)}</td>
                    <td>{c.nqPrice.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function ChartSnapshotPanel({
  snapshots,
  addSnapshot,
  deleteSnapshot,
  updateSnapshotNote,
}: {
  snapshots: ChartSnapshot[];
  addSnapshot: (file: File, note: string) => Promise<void>;
  deleteSnapshot: (id: number) => Promise<void>;
  updateSnapshotNote: (id: number, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const todayStr = tradingDayKey(new Date());
  const todaysSnapshots = snapshots.filter((s) => tradingDayKey(new Date(s.date)) === todayStr);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await addSnapshot(file, note);
      setNote("");
    } catch (err: any) {
      alert("Upload failed: " + (err.message || String(err)));
    }
    setUploading(false);
    e.target.value = "";
  }

  return (
    <div className="panel-box">
      <div className="panel-title">Chart Snapshots</div>
      <div className="panel-desc">Upload a chart screenshot (e.g. from Thinkorswim) any time during the day as a reminder of a good or bad trade — shown in your daily reports. Note field is optional here and can also be added/edited on any snapshot afterward, in case you picked the image before typing a note.</div>
      <div className="grid2">
        <div className="field">
          <label>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Good — respected the trend, didn't chase" />
        </div>
        <div className="field">
          <label>Image</label>
          <input type="file" accept="image/*" onChange={handleFile} disabled={uploading} />
        </div>
      </div>
      {uploading && <div className="card-sub">Uploading…</div>}
      {todaysSnapshots.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
          {todaysSnapshots.map((s) => (
            <div key={s.id} style={{ width: 220 }}>
              <img src={s.imageData} alt={s.note || "snapshot"} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
              <div className="card-sub" style={{ marginTop: 4 }}>{new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              {editingId === s.id ? (
                <div style={{ marginTop: 4 }}>
                  <input
                    value={editingNote}
                    onChange={(e) => setEditingNote(e.target.value)}
                    placeholder="Add a note…"
                    autoFocus
                    style={{ marginBottom: 6 }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn small primary"
                      onClick={async () => {
                        await updateSnapshotNote(s.id, editingNote);
                        setEditingId(null);
                      }}
                    >
                      Save
                    </button>
                    <button className="btn small ghost" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                  <div className="card-sub" style={{ flex: 1 }}>{s.note || <em>No note</em>}</div>
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      setEditingId(s.id);
                      setEditingNote(s.note || "");
                    }}
                  >
                    Edit
                  </button>
                </div>
              )}
              <button className="btn small ghost" style={{ marginTop: 6 }} onClick={() => deleteSnapshot(s.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type StopRule = {
  id: number;
  createdAt: string;
  env: string;
  accountId: number;
  symbol: string;
  direction: string;
  entryPrice: number;
  qty: number;
  triggerOffset: number;
  newStopOffset: number;
  status: string;
  triggeredAt: string | null;
  newStopPrice: number | null;
  verified: boolean | null;
  detail: string | null;
};

type OrderLog = {
  id: number;
  date: string;
  env: string;
  symbol: string;
  side: string;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  status: string;
  blockedReason: string | null;
  tradovateOrderId: string | null;
};

function TradeTicketTab({ settings }: { settings: Settings }) {
  function computeWindowStatus() {
    const raw = getTradingWindowStatus(settings);
    if (settings.tradovateEnv !== "live") {
      return { allowed: true, reason: "Demo — Trading Window Guard not enforced (Live only).", etLabel: raw.etLabel };
    }
    return raw;
  }
  const [windowStatus, setWindowStatus] = useState(computeWindowStatus);

  const [connStatus, setConnStatus] = useState<{ connected: boolean; accounts: any[] | null; error: any } | null>(null);
  const [logs, setLogs] = useState<OrderLog[]>([]);
  const [form, setForm] = useState({ accountId: "", root: "NQ", action: "Buy", qty: "1", orderType: "Market", price: "", stopLoss: "", target: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ type: "blocked" | "error" | "success"; message: string } | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState<{ symbol: string | null; expiration: string | null; error?: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [lastKnownPrice, setLastKnownPrice] = useState<number | null>(null);
  const [lastKnownPriceAt, setLastKnownPriceAt] = useState<string | null>(null);

  // Matches lib/lastKnownPrice.ts's FRESHNESS_MINUTES (kept as a separate
  // constant here since that module also imports prisma, which shouldn't be
  // bundled into a client component). Anything older than this is NOT
  // reliable enough to silently hand you as if it's roughly current — QQQ
  // (the source of this number) doesn't trade outside 9:30am–4pm ET, so a
  // check logged before close can be many hours stale by the time you're
  // placing an overnight/Globex order.
  const LAST_KNOWN_PRICE_STALE_MINUTES = 10;
  const lastKnownPriceAgeMinutes = lastKnownPriceAt ? Math.round((Date.now() - new Date(lastKnownPriceAt).getTime()) / 60000) : null;
  const lastKnownPriceIsFresh = lastKnownPriceAgeMinutes !== null && lastKnownPriceAgeMinutes <= LAST_KNOWN_PRICE_STALE_MINUTES;
  const lastKnownPriceAgeLabel = lastKnownPriceAgeMinutes === null ? "" : lastKnownPriceAgeMinutes < 60
    ? `${lastKnownPriceAgeMinutes} min ago`
    : `${Math.floor(lastKnownPriceAgeMinutes / 60)}h ${lastKnownPriceAgeMinutes % 60}m ago`;
  const [lockout, setLockout] = useState<{ until: string; reason: string } | null>(null);
  const [currentPositions, setCurrentPositions] = useState<{ symbol: string; netPos: number; netPrice: number; pnl: number | null; pnlSource: "position" | "account" | "estimated" | null; loggedPrice: number | null; loggedPriceAgeMinutes: number | null; openSinceMinutes: number | null }[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [lockingOut, setLockingOut] = useState(false);
  const [stopRules, setStopRules] = useState<StopRule[]>([]);
  const [stopRuleForm, setStopRuleForm] = useState({ entryPrice: "", triggerOffset: "", newStopOffset: "" });

  function refreshStopRules() {
    fetch("/api/tradovate/stop-rules").then((r) => r.json()).then(setStopRules);
  }

  async function addStopRule() {
    if (!form.accountId || !resolvedSymbol?.symbol || !stopRuleForm.entryPrice || !stopRuleForm.triggerOffset || !stopRuleForm.newStopOffset) {
      alert("Fill in account, entry price, trigger offset, and new stop offset (contract must be resolved too).");
      return;
    }
    if (!confirm(`This will automatically move your stop once price moves ${stopRuleForm.triggerOffset} points in your favor — with NO manual confirmation. Tradovate's own API has documented cases of silently failing to actually move the order. Continue?`)) {
      return;
    }
    await fetch("/api/tradovate/stop-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        env: settings.tradovateEnv,
        accountId: form.accountId,
        symbol: resolvedSymbol.symbol,
        direction: form.action === "Buy" ? "long" : "short",
        entryPrice: stopRuleForm.entryPrice,
        qty: form.qty,
        triggerOffset: stopRuleForm.triggerOffset,
        newStopOffset: stopRuleForm.newStopOffset,
      }),
    });
    setStopRuleForm({ entryPrice: "", triggerOffset: "", newStopOffset: "" });
    refreshStopRules();
  }

  function refreshLockout() {
    fetch("/api/tradovate/lockout").then((r) => r.json()).then((d) => setLockout(d.active));
  }

  function refreshPositions() {
    if (!form.accountId) { setCurrentPositions([]); return; }
    setPositionsLoading(true);
    fetch(`/api/tradovate/positions?env=${settings.tradovateEnv}&accountId=${form.accountId}`)
      .then((r) => r.json())
      .then((d) => setCurrentPositions(d.positions || []))
      .catch(() => setCurrentPositions([]))
      .finally(() => setPositionsLoading(false));
  }

  async function triggerLockout(minutes?: number, restOfDay?: boolean) {
    const label = restOfDay ? "the rest of the trading day" : `${minutes} minutes`;
    if (!confirm(`Lock trading for ${label}? This cannot be undone or canceled early once set.`)) return;
    setLockingOut(true);
    const res = await fetch("/api/tradovate/lockout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restOfDay ? { restOfDay: true } : { minutes }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not create lockout.");
    }
    refreshLockout();
    setLockingOut(false);
  }

  useEffect(() => {
    refreshLockout();
    refreshStopRules();
    const interval = setInterval(() => { refreshLockout(); refreshStopRules(); refreshPositions(); }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    refreshPositions();
  }, [form.accountId, settings.tradovateEnv]);

  useEffect(() => {
    const interval = setInterval(() => setWindowStatus(computeWindowStatus()), 15000);
    return () => clearInterval(interval);
  }, [settings]);

  useEffect(() => {
    setWindowStatus(computeWindowStatus());
    fetch(`/api/tradovate/status?env=${settings.tradovateEnv}`)
      .then((r) => r.json())
      .then((d) => {
        setConnStatus({ connected: d.connected, accounts: d.accounts, error: d.error });
        // Prefers the account you've pinned in Settings for this
        // environment (needed once more than one account exists — auto-
        // selecting "the only one" doesn't work anymore). Falls back to
        // auto-selecting if there's genuinely just one account and nothing
        // configured, otherwise leaves it for manual selection.
        const preferredId = settings.tradovateEnv === "live" ? settings.liveAccountId : settings.demoAccountId;
        // Tradovate accounts have both an internal `id` and a separate
        // human-readable `name` (the account number, e.g. "1003033") — you
        // see `name` in the dropdown, so match against either rather than
        // assuming what got typed into Settings is specifically the id.
        const preferredMatch = preferredId
          ? d.accounts?.find((a: any) => String(a.id) === String(preferredId) || String(a.name) === String(preferredId))
          : null;
        if (preferredMatch) {
          setForm((f) => ({ ...f, accountId: String(preferredMatch.id) }));
        } else if (d.accounts?.length === 1) {
          setForm((f) => ({ ...f, accountId: String(d.accounts[0].id) }));
        }
      })
      .catch((e) => setConnStatus({ connected: false, accounts: null, error: String(e) }));
    fetch("/api/tradovate/order").then((r) => r.json()).then(setLogs);

    // pull the most recent known NQ price (Intraday check today, falling back
    // to today's Pre-Market prep) to prefill the limit price field — this is
    // NOT a live quote, just whatever you last logged in this app
    Promise.all([
      fetch("/api/intraday").then((r) => r.json()),
      fetch("/api/premarket").then((r) => r.json()),
    ]).then(([checks, prep]) => {
      const latestCheck = checks[checks.length - 1];
      const todayPrep = prep.find((p: PreMarketPrep) => tradingDayKey(new Date(p.date)) === tradingDayKey(new Date()));
      setLastKnownPrice(latestCheck?.nqPrice ?? todayPrep?.nqPrice ?? null);
      setLastKnownPriceAt(latestCheck?.date ?? todayPrep?.date ?? null);
    });
  }, [settings.tradovateEnv, settings.liveAccountId, settings.demoAccountId]);

  useEffect(() => {
    setResolvedSymbol(null);
    if (!form.root) return;
    setResolving(true);
    fetch(`/api/tradovate/resolve-symbol?env=${settings.tradovateEnv}&root=${form.root}`)
      .then((r) => r.json())
      .then((d) => setResolvedSymbol(d.ok ? { symbol: d.symbol, expiration: d.expiration } : { symbol: null, expiration: null, error: d.error }))
      .catch((e) => setResolvedSymbol({ symbol: null, expiration: null, error: String(e) }))
      .finally(() => setResolving(false));
  }, [form.root, settings.tradovateEnv]);

  function useLimitOrder() {
    setForm((f) => ({ ...f, orderType: "Limit", price: lastKnownPriceIsFresh && lastKnownPrice !== null ? String(roundToTick(lastKnownPrice)) : f.price }));
  }

  async function submitOrder() {
    if (!form.accountId || !resolvedSymbol?.symbol || !form.qty) {
      alert("Fill in account and quantity, and make sure a contract has resolved.");
      return;
    }
    if ((form.stopLoss && !form.target) || (!form.stopLoss && form.target)) {
      alert("Stop Loss and Target must both be filled in together, or both left blank.");
      return;
    }
    // FAT-FINGER CHECK — catches a typo'd extra digit (or a dropped one)
    // before it goes anywhere near Tradovate. This isn't a risk-management
    // guard like the ones below (a limit resting well away from market can
    // be entirely intentional) — it's specifically a "does this number look
    // like what you meant to type" sanity check, so it's a client-side
    // confirm rather than a hard server-side block. Uses whatever last
    // known price we have, even a stale one — a typo this size (10x, an
    // extra zero, etc.) shows up against an hours-old reference just as
    // clearly as a fresh one.
    if (form.orderType === "Limit" && form.price && lastKnownPrice !== null) {
      const enteredPrice = parseFloat(form.price);
      if (Number.isFinite(enteredPrice) && enteredPrice > 0) {
        const pctOff = Math.abs(enteredPrice - lastKnownPrice) / lastKnownPrice;
        if (pctOff > 0.03) {
          const proceed = window.confirm(
            `\u26a0 Limit price ${enteredPrice} is ${(pctOff * 100).toFixed(0)}% away from the last known price (${roundToTick(lastKnownPrice).toFixed(2)}).\n\n` +
            `This often means an extra or missing digit got typed in by mistake.\n\n` +
            `Click OK only if ${enteredPrice} is really the price you meant to enter.`
          );
          if (!proceed) return;
        }
      }
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/tradovate/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: settings.tradovateEnv,
          accountId: form.accountId,
          symbol: resolvedSymbol.symbol,
          action: form.action,
          orderQty: form.qty,
          orderType: form.orderType,
          price: form.orderType === "Limit" ? String(roundToTick(parseFloat(form.price))) : undefined,
          stopLoss: form.stopLoss ? String(roundToTick(parseFloat(form.stopLoss))) : undefined,
          target: form.target ? String(roundToTick(parseFloat(form.target))) : undefined,
        }),
      });
      const data = await res.json();
      if (res.status === 403 && data.blocked) {
        setResult({ type: "blocked", message: data.reason });
      } else if (!res.ok) {
        setResult({ type: "error", message: JSON.stringify(data.error) });
      } else {
        setResult({ type: "success", message: `Order submitted (${settings.tradovateEnv}). Tradovate order ID: ${data.result?.orderId ?? "pending"}` });
      }
      fetch("/api/tradovate/order").then((r) => r.json()).then(setLogs);
      setTimeout(refreshPositions, 2000);
    } catch (err: any) {
      setResult({ type: "error", message: err.message || String(err) });
    }
    setSubmitting(false);
  }

  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Trade Ticket — {settings.tradovateEnv.toUpperCase()}</div>
        <div className="panel-desc">
          Orders placed here go through Tradovate's API and are blocked if they'd add to an open losing position — checked using Tradovate's own P&L data when available, otherwise requiring an Intraday check logged within the last 10 minutes. No fresh check, no Tradovate data — the add is blocked outright. The Trading Window Guard (time-of-day/weekday restriction) only applies to your Live account — Demo is unrestricted by time, for free testing.
          {settings.tradovateEnv === "live" && (
            <span style={{ color: "var(--red)", fontWeight: 600 }}> LIVE environment — real orders, real money.</span>
          )}
        </div>

        <div className={`status-banner ${windowStatus.allowed ? "status-clear" : "status-warn"}`} style={!windowStatus.allowed ? { borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" } : undefined}>
          {windowStatus.allowed ? "✓ " : "⛔ "}{windowStatus.reason} (Current ET time: {windowStatus.etLabel})
        </div>

        {lockout && (
          <div className="status-banner" style={{ marginTop: 8, borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" }}>
            ⛔ LOCKED — {lockout.reason}. Unlocks at {new Date(lockout.until).toLocaleString()}. Cannot be overridden or canceled early.
          </div>
        )}

        <div className="status-banner" style={{ marginTop: 8, background: connStatus?.connected ? "rgba(63,208,201,0.1)" : "rgba(245,166,35,0.1)", borderColor: connStatus?.connected ? "var(--cyan-dim)" : "var(--amber-dim)", color: connStatus?.connected ? "var(--cyan)" : "var(--amber)" }}>
          {connStatus === null ? "Checking Tradovate connection…" : connStatus.connected ? `✓ Connected to Tradovate (${settings.tradovateEnv})` : `⚠ Not connected: ${JSON.stringify(connStatus.error)}`}
        </div>

        <div className="grid3" style={{ marginTop: 16 }}>
          <div className="field"><label>Account</label>
            <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">Select account…</option>
              {(connStatus?.accounts || []).map((a: any) => (
                <option key={a.id} value={a.id}>{a.name || a.id}</option>
              ))}
            </select>
          </div>
          <div className="field"><label>Symbol (root)</label>
            <select value={form.root} onChange={(e) => setForm({ ...form, root: e.target.value })}>
              <option value="NQ">NQ</option>
              <option value="MNQ">MNQ</option>
            </select>
          </div>
          <div className="field"><label>Side</label>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              <option value="Buy">Buy</option>
              <option value="Sell">Sell</option>
            </select>
          </div>
        </div>

        <div className="status-banner" style={{ marginTop: 4, marginBottom: 12, background: resolvedSymbol?.symbol ? "rgba(63,208,201,0.1)" : "rgba(245,166,35,0.1)", borderColor: resolvedSymbol?.symbol ? "var(--cyan-dim)" : "var(--amber-dim)", color: resolvedSymbol?.symbol ? "var(--cyan)" : "var(--amber)" }}>
          {resolving
            ? "Resolving front-month contract…"
            : resolvedSymbol?.symbol
            ? `✓ Resolved to ${resolvedSymbol.symbol}${resolvedSymbol.expiration ? ` (expires ${new Date(resolvedSymbol.expiration).toLocaleDateString()})` : ""}`
            : `⚠ Could not resolve a contract for ${form.root}: ${resolvedSymbol?.error || "unknown error"}`}
        </div>

        <div className="grid3">
          <div className="field"><label>Quantity</label>
            <input type="number" min="1" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div className="field"><label>Order Type</label>
            <select
              value={form.orderType}
              onChange={(e) => {
                const newType = e.target.value;
                setForm((f) => ({
                  ...f,
                  orderType: newType,
                  price: newType === "Limit" && !f.price && lastKnownPriceIsFresh && lastKnownPrice !== null ? String(roundToTick(lastKnownPrice)) : f.price,
                }));
              }}
            >
              <option value="Market">Market</option>
              <option value="Limit">Limit</option>
            </select>
          </div>
          {form.orderType === "Limit" && (
            <div className="field"><label>Limit Price</label>
              <input
                type="number" step="0.25" value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) setForm((f) => ({ ...f, price: String(roundToTick(v)) }));
                }}
              />
              <div className="card-sub" style={{ marginTop: 4 }}>
                {!form.price && lastKnownPrice !== null && lastKnownPriceIsFresh
                  ? `Not filled in yet. Your last logged price was ${roundToTick(lastKnownPrice).toFixed(2)} (${lastKnownPriceAgeLabel}) \u2014 still not a live quote. Enter a price or clear/reselect Order Type to prefill it.`
                  : !form.price && lastKnownPrice !== null && !lastKnownPriceIsFresh
                  ? `\u26a0 No recent price available. The last logged price (${roundToTick(lastKnownPrice).toFixed(2)}) is ${lastKnownPriceAgeLabel} old \u2014 QQQ doesn't trade outside 9:30am\u20134pm ET, so this is NOT a reasonable stand-in for the current NQ price. Check your own live chart and enter the current price manually.`
                  : !form.price
                  ? "No recent price logged in Pre-Market/Intraday \u2014 enter manually from your own live chart."
                  : "Not a live quote \u2014 double check this price before submitting."}
              </div>
            </div>
          )}
        </div>
        {form.orderType === "Market" && lastKnownPrice !== null && lastKnownPriceIsFresh && (
          <button className="btn small ghost" onClick={useLimitOrder} style={{ marginBottom: 12 }}>
            Switch to Limit @ last known price ({roundToTick(lastKnownPrice).toFixed(2)})
          </button>
        )}
        {form.orderType === "Market" && lastKnownPrice !== null && !lastKnownPriceIsFresh && (
          <div className="card-sub" style={{ marginBottom: 12, color: "var(--amber)" }}>
            ⚠ No fresh price to offer here — last logged price is {lastKnownPriceAgeLabel} old (QQQ-derived, doesn't update outside 9:30am–4pm ET). Check your own live chart if you want to switch to a Limit order.
          </div>
        )}

        <div style={{ marginTop: 8, marginBottom: 4 }}>
          <div className="card-label">STOP LOSS / TARGET (OPTIONAL)</div>
          <div className="panel-desc" style={{ marginTop: 4 }}>
            Fill in both to submit as a bracket order — Tradovate attaches the stop and target automatically once your entry fills. Leave both blank for a plain order with no attached exit.
          </div>
        </div>
        <div className="grid2">
          <div className="field"><label>Stop Loss (price)</label>
            <input
              type="number" step="0.25" value={form.stopLoss}
              onChange={(e) => setForm({ ...form, stopLoss: e.target.value })}
              onBlur={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setForm((f) => ({ ...f, stopLoss: String(roundToTick(v)) })); }}
              placeholder="e.g. 28700.00"
            />
          </div>
          <div className="field"><label>Target (price)</label>
            <input
              type="number" step="0.25" value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
              onBlur={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setForm((f) => ({ ...f, target: String(roundToTick(v)) })); }}
              placeholder="e.g. 28800.00"
            />
          </div>
        </div>

        <button className="btn primary" onClick={submitOrder} disabled={submitting || !!lockout || !windowStatus.allowed || resolving || !resolvedSymbol?.symbol}>
          {submitting ? "Submitting…" : lockout ? "Locked" : !windowStatus.allowed ? "Blocked — outside trading window" : resolving ? "Resolving contract…" : !resolvedSymbol?.symbol ? "No contract resolved" : (form.stopLoss && form.target) ? "Submit Bracket Order" : "Submit Order"}
        </button>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div className="card-label" style={{ marginBottom: 8 }}>MANUAL LOCKOUT</div>
          <div className="panel-desc" style={{ marginTop: 0 }}>
            Lock yourself out of Trade Ticket for a set period — same idea as Tradovate's own lockout feature,
            since it isn't available on your account type. Once set, it cannot be canceled early, by design.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn small ghost" disabled={!!lockout || lockingOut} onClick={() => triggerLockout(30)}>Lock 30 min</button>
            <button className="btn small ghost" disabled={!!lockout || lockingOut} onClick={() => triggerLockout(60)}>Lock 1 hour</button>
            <button className="btn small ghost" disabled={!!lockout || lockingOut} onClick={() => triggerLockout(120)}>Lock 2 hours</button>
            <button className="btn small ghost" disabled={!!lockout || lockingOut} onClick={() => triggerLockout(undefined, true)}>Lock rest of day</button>
          </div>
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div className="card-label" style={{ marginBottom: 8 }}>AUTOMATIC STOP MANAGEMENT</div>
          <div className="panel-desc" style={{ marginTop: 0 }}>
            Once price moves a set number of points in your favor, this automatically moves your stop to lock in profit —
            no manual click, no confirmation.
          </div>
          <div className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)", marginBottom: 12 }}>
            ⚠ Tradovate's own API has documented, unresolved cases of reporting a successful modification when the stop
            did not actually move. This app verifies afterward and will flag it loudly if that happens — but the
            modification itself runs with no human confirmation. Checked on a schedule (however often your cron job
            pings), not instantly.
          </div>
          <div className="grid3">
            <div className="field"><label>Entry Price</label>
              <input type="number" step="0.25" value={stopRuleForm.entryPrice} onChange={(e) => setStopRuleForm({ ...stopRuleForm, entryPrice: e.target.value })} placeholder="e.g. 28777" />
            </div>
            <div className="field"><label>Trigger (pts in your favor)</label>
              <input type="number" step="0.25" value={stopRuleForm.triggerOffset} onChange={(e) => setStopRuleForm({ ...stopRuleForm, triggerOffset: e.target.value })} placeholder="e.g. 11" />
            </div>
            <div className="field"><label>New Stop (pts from entry)</label>
              <input type="number" step="0.25" value={stopRuleForm.newStopOffset} onChange={(e) => setStopRuleForm({ ...stopRuleForm, newStopOffset: e.target.value })} placeholder="e.g. 4" />
            </div>
          </div>
          <button className="btn small ghost" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={addStopRule}>Create Auto-Stop Rule</button>

          {stopRules.length > 0 && (
            <div style={{ marginTop: 14, overflowX: "auto" }}>
              <table>
                <thead><tr><th>Symbol</th><th>Dir</th><th>Entry</th><th>Trigger</th><th>New Stop</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>
                  {stopRules.map((r) => (
                    <tr key={r.id}>
                      <td>{r.symbol}</td>
                      <td>{r.direction.toUpperCase()}</td>
                      <td>{r.entryPrice.toFixed(2)}</td>
                      <td>+{r.triggerOffset}</td>
                      <td>{r.newStopPrice !== null ? r.newStopPrice.toFixed(2) : `entry+${r.newStopOffset}`}</td>
                      <td>
                        <span className={`tag ${r.status === "triggered" && r.verified ? "clean" : r.status === "active" ? "long" : "flag"}`}>
                          {r.status === "triggered" ? (r.verified ? "MOVED ✓" : "UNVERIFIED ⚠") : r.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ maxWidth: 240, whiteSpace: "normal" }}>{r.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {result && (
          <div
            className="status-banner"
            style={{
              marginTop: 12,
              borderColor: result.type === "success" ? "var(--cyan-dim)" : "var(--red)",
              color: result.type === "success" ? "var(--cyan)" : "var(--red)",
              background: result.type === "success" ? "rgba(63,208,201,0.1)" : "rgba(229,72,77,0.1)",
            }}
          >
            {result.message}
          </div>
        )}
      </div>

      <div className="panel-box">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div className="panel-title" style={{ margin: 0 }}>Current Position — {settings.tradovateEnv.toUpperCase()}</div>
          <button className="btn small ghost" onClick={refreshPositions} disabled={positionsLoading || !form.accountId}>{positionsLoading ? "Refreshing…" : "Refresh"}</button>
        </div>
        <div className="panel-desc">Pulled directly from Tradovate — this is what's actually open, not just what you submitted. Tradovate doesn't expose live P&amp;L without a market data subscription (confirmed — not available on this account), so P&amp;L here is estimated from your last logged price where a direct figure isn't available.</div>
        {!form.accountId ? (
          <div className="empty-state">Select an account above to see open positions.</div>
        ) : currentPositions.length === 0 ? (
          <div className="empty-state">No open positions on this account right now.</div>
        ) : (
          <>
            {currentPositions.filter((p) => p.pnl !== null && Number.isFinite(p.pnl) && p.pnl < 0 && p.openSinceMinutes !== null && p.openSinceMinutes > HOLDING_LOSER_WARNING_MINUTES).map((p, i) => (
              <div key={i} className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.15)", marginBottom: 10, fontWeight: 600 }}>
                🔴 You've been holding {p.symbol} at a loss for {p.openSinceMinutes!.toFixed(0)} minutes. This is the exact pattern you said you have — letting a loser run hoping it comes back. It came back today. What's your actual plan right now if it doesn't?
              </div>
            ))}
            <table>
              <thead><tr><th>Symbol</th><th>Net Pos</th><th>Avg Price</th><th>P&amp;L</th><th>Time in Trade</th><th>Source</th></tr></thead>
              <tbody>
                {currentPositions.map((p, i) => {
                  const isStale = p.pnlSource === "estimated" && p.loggedPriceAgeMinutes !== null && p.loggedPriceAgeMinutes > 10;
                  const isLongHeldLoser = p.pnl !== null && Number.isFinite(p.pnl) && p.pnl < 0 && p.openSinceMinutes !== null && p.openSinceMinutes > HOLDING_LOSER_WARNING_MINUTES;
                  return (
                    <tr key={i}>
                      <td>{p.symbol}</td>
                      <td><span className={`tag ${p.netPos > 0 ? "long" : "short"}`}>{p.netPos > 0 ? "LONG" : "SHORT"} {Math.abs(p.netPos)}</span></td>
                      <td>{p.netPrice?.toFixed(2)}</td>
                      <td className={p.pnl !== null && Number.isFinite(p.pnl) ? (p.pnl >= 0 ? "pnl-pos" : "pnl-neg") : undefined}>
                        {p.pnl !== null && Number.isFinite(p.pnl) ? fmtMoney(p.pnl) : "— (no data available)"}
                        {isStale && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 2 }}>⚠ STALE — {p.loggedPriceAgeMinutes!.toFixed(0)} min old, do not trust this number</div>}
                      </td>
                      <td style={isLongHeldLoser ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                        {p.openSinceMinutes !== null ? `${p.openSinceMinutes.toFixed(0)} min` : "—"}
                        {isLongHeldLoser && " ⚠"}
                      </td>
                      <td className="card-sub" style={{ marginTop: 0 }}>
                        {p.pnlSource === "position" ? "Tradovate (position)" :
                         p.pnlSource === "account" ? "Tradovate (account)" :
                         p.pnlSource === "estimated" ? `Estimated @ ${p.loggedPrice?.toFixed(2)} (${p.loggedPriceAgeMinutes!.toFixed(0)} min ago)` :
                         "No price logged"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="panel-box">
        <div className="panel-title">Order Log</div>
        {logs.length === 0 ? (
          <div className="empty-state">No orders submitted yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Time</th><th>Env</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>SL / Target</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td>{new Date(l.date).toLocaleString()}</td>
                    <td>{l.env}</td>
                    <td>{l.symbol}</td>
                    <td><span className={`tag ${l.side === "Buy" ? "long" : "short"}`}>{l.side.toUpperCase()}</span></td>
                    <td>{l.qty}</td>
                    <td>{l.orderType}{l.limitPrice ? ` @ ${l.limitPrice}` : ""}</td>
                    <td>{l.stopLossPrice && l.targetPrice ? `${l.stopLossPrice} / ${l.targetPrice}` : "—"}</td>
                    <td><span className={`tag ${l.status === "SUBMITTED" ? "clean" : l.status === "ALLOWED" ? "na" : "flag"}`}>{l.status}</span></td>
                    <td style={{ maxWidth: 260, whiteSpace: "normal" }}>{l.blockedReason || l.tradovateOrderId || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function equityCurvePoints(trades: MatchedTrade[], w: number, h: number, pad: number) {
  let cum = 0;
  const points = trades.map((t) => (cum += t.pnl));
  const min = Math.min(0, ...points, 0);
  const max = Math.max(0, ...points, 0);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (w - 2 * pad) / (points.length - 1) : 0;
  const coords = points.map((p, i) => `${pad + i * stepX},${h - pad - ((p - min) / range) * (h - 2 * pad)}`).join(" ");
  const zeroY = h - pad - ((0 - min) / range) * (h - 2 * pad);
  return { coords, zeroY, points };
}

// Builds the Chart.js <canvas> + <script> block for the exported HTML
// report. Loaded from a CDN (cdnjs) since this is a standalone downloaded
// file with no bundler/build step — needs internet access when opened to
// actually render, same as any report that embeds a hosted chart library.
// Zoom/pan isn't included here (would mean a second CDN plugin + version
// matching to get right) — flag if that's still wanted after seeing these.
async function buildChartsHtml(items: { label: string; pnl: number; entryDate?: string | null; date?: string | null }[]): Promise<string> {
  if (items.length === 0) {
    return `<p style="color:#7F8CA6;font-size:13px;">No closed trades yet — charts will appear here once you have some.</p>`;
  }

  // Chart.js is embedded directly (fetched from this app's own /public folder,
  // not a CDN) so the exported report is fully self-contained and doesn't
  // depend on cdnjs being reachable when someone actually opens the file —
  // that CDN load silently failed in testing (blocked by something in the
  // viewer's browser/network), leaving the canvases blank with no visible
  // error in the report itself.
  let chartJsSource = "";
  try {
    const res = await fetch("/vendor/chart.umd.min.js");
    if (res.ok) chartJsSource = await res.text();
  } catch {
    // handled below via the empty-string fallback
  }
  if (!chartJsSource) {
    return `<p style="color:#E5484D;font-size:13px;">Charts unavailable — couldn't load the charting library from this app. The rest of the report (stats and trade table) is unaffected.</p>`;
  }

  let cum = 0;
  const equityLabels = items.map((t) => t.label);
  const equityData = items.map((t) => (cum += t.pnl));
  const perTradePnl = items.map((t) => t.pnl);
  const perTradeColors = perTradePnl.map((p) => (p >= 0 ? "#3FD0C9" : "#E5484D"));
  const wins = items.filter((t) => t.pnl > 0).length;
  const losses = items.filter((t) => t.pnl <= 0).length;

  // How many TRADE RECORDS were open at the same time as this one — a count
  // of overlapping trades, not total contracts. If any of those trades were
  // logged with size > 1, actual contract exposure at that moment was
  // higher than this number. Counts itself, so 1 means it was never
  // stacked with anything else. Only computable when both this trade and the one it's being compared against
  // have a recorded entry time (real synced fills going forward, or manual
  // entries with Entry Time filled in) — null otherwise rather than
  // guessing. Two trades "overlap" if either one's entry happened before
  // the other's exit, in both directions — the standard interval-overlap
  // check, not just a same-symbol/same-direction one, since holding e.g. an
  // NQ long and an MNQ short at once is still two concurrent positions.
  const concurrentCounts: (number | null)[] = items.map((it) => {
    if (!it.entryDate || !it.date) return null;
    const entryI = new Date(it.entryDate).getTime();
    const exitI = new Date(it.date).getTime();
    let count = 0;
    for (const other of items) {
      if (!other.entryDate || !other.date) continue;
      const entryJ = new Date(other.entryDate).getTime();
      const exitJ = new Date(other.date).getTime();
      if (entryI < exitJ && entryJ < exitI) count++;
    }
    return count;
  });

  // Same overlap check as above, but keeping the actual entry timestamps of
  // every trade that counted toward that number — so the tooltip can name
  // them instead of just giving a bare count. Includes seconds since this
  // app frequently logs several trades within the same minute.
  const concurrentEntryLabels: string[][] = items.map((it) => {
    if (!it.entryDate || !it.date) return [];
    const entryI = new Date(it.entryDate).getTime();
    const exitI = new Date(it.date).getTime();
    const times: number[] = [];
    for (const other of items) {
      if (!other.entryDate || !other.date) continue;
      const entryJ = new Date(other.entryDate).getTime();
      const exitJ = new Date(other.date).getTime();
      if (entryI < exitJ && entryJ < exitI) times.push(entryJ);
    }
    return times
      .sort((a, b) => a - b)
      .map((t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  });

  const dataJson = JSON.stringify({ equityLabels, equityData, perTradePnl, perTradeColors, wins, losses, concurrentCounts, concurrentEntryLabels }).replace(/</g, "\\u003c");

  return `
<canvas id="equityChart" height="90"></canvas>
<h2>P&amp;L Per Trade</h2>
<canvas id="pnlBarChart" height="90"></canvas>
<h2>Win / Loss</h2>
<div style="width:220px;height:220px;"><canvas id="winLossChart"></canvas></div>
<script>${chartJsSource}</script>
<script>
(function() {
  var d = ${dataJson};
  var axisColor = "#7F8CA6";
  var gridColor = "#263654";
  Chart.defaults.color = axisColor;
  Chart.defaults.font.family = "'Courier New', monospace";

  new Chart(document.getElementById('equityChart'), {
    type: 'line',
    data: {
      labels: d.equityLabels,
      datasets: [{
        label: 'Cumulative Realized P&L',
        data: d.equityData,
        borderColor: d.equityData[d.equityData.length - 1] >= 0 ? '#3FD0C9' : '#E5484D',
        backgroundColor: 'rgba(63,208,201,0.08)',
        fill: true,
        tension: 0.15,
        pointRadius: 3,
        pointBackgroundColor: d.perTradePnl.map(function(p) { return p >= 0 ? '#3FD0C9' : '#E5484D'; }),
      }]
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) {
        var tradePnl = d.perTradePnl[ctx.dataIndex];
        var concurrent = d.concurrentCounts[ctx.dataIndex];
        var lines = ['This trade: ' + (tradePnl >= 0 ? '+' : '') + tradePnl.toFixed(2), 'Cumulative: ' + ctx.parsed.y.toFixed(2)];
        lines.push(concurrent === null ? 'Concurrent trades: unknown (no entry time)' : 'Concurrent trades: ' + concurrent);
        if (concurrent !== null && concurrent > 1) {
          lines.push('Entered at: ' + d.concurrentEntryLabels[ctx.dataIndex].join(', '));
        }
        return lines;
      } } } },
      scales: {
        x: { ticks: { maxRotation: 60, minRotation: 60 }, grid: { color: gridColor } },
        y: { grid: { color: gridColor } }
      }
    }
  });

  new Chart(document.getElementById('pnlBarChart'), {
    type: 'bar',
    data: {
      labels: d.equityLabels,
      datasets: [{ label: 'P&L per trade', data: d.perTradePnl, backgroundColor: d.perTradeColors }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 60, minRotation: 60 }, grid: { color: gridColor } },
        y: { grid: { color: gridColor } }
      }
    }
  });

  new Chart(document.getElementById('winLossChart'), {
    type: 'doughnut',
    data: {
      labels: ['Wins (' + d.wins + ')', 'Losses (' + d.losses + ')'],
      datasets: [{ data: [d.wins, d.losses], backgroundColor: ['#3FD0C9', '#E5484D'] }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
})();
</script>`;
}

// Same logic as findAddedToLoserInstances, but for MatchedTrade (TV
// Analytics' Tradovate FIFO data) instead of Journal Trade records. This
// data always has real entry/exit times, so detection works on every trade
// here — no entryDate-missing gap like the Journal has for older entries.
type AddedToLoserMatchedInstance = { earlier: MatchedTrade; later: MatchedTrade };
function findAddedToLoserInstancesMatched(matchedTrades: MatchedTrade[]): AddedToLoserMatchedInstance[] {
  const results: AddedToLoserMatchedInstance[] = [];
  for (const later of matchedTrades) {
    let best: MatchedTrade | null = null;
    let bestEntryTime = -Infinity;
    for (const earlier of matchedTrades) {
      if (earlier === later) continue;
      if (earlier.symbol !== later.symbol || earlier.side !== later.side) continue;
      const earlierEntry = new Date(earlier.entryTime).getTime();
      const earlierExit = new Date(earlier.exitTime).getTime();
      const laterEntry = new Date(later.entryTime).getTime();
      if (!(laterEntry > earlierEntry && laterEntry < earlierExit)) continue;
      const adverse = earlier.side === "long" ? later.entryPrice < earlier.entryPrice : later.entryPrice > earlier.entryPrice;
      if (!adverse) continue;
      if (earlierEntry > bestEntryTime) {
        bestEntryTime = earlierEntry;
        best = earlier;
      }
    }
    if (best) results.push({ earlier: best, later });
  }
  return results;
}

async function buildAnalyticsHtmlReport(
  accountLabel: string,
  cashBalance: any,
  matchedTrades: MatchedTrade[],
  totalPnl: number,
  winRate: number
) {
  const addedToLoser = findAddedToLoserInstancesMatched(matchedTrades);
  const laterKeys = new Set(addedToLoser.map((i) => i.later.entryTime + i.later.exitTime));
  const rows = matchedTrades
    .map(
      (t) => `
    <tr${laterKeys.has(t.entryTime + t.exitTime) ? ' style="background:rgba(229,72,77,0.15);"' : ""}>
      <td>${laterKeys.has(t.entryTime + t.exitTime) ? "\u26a0 " : ""}${new Date(t.exitTime).toLocaleString()}</td>
      <td>${t.symbol}</td>
      <td>${t.side.toUpperCase()}</td>
      <td>${t.qty}</td>
      <td>${t.entryPrice.toFixed(2)}</td>
      <td>${t.exitPrice.toFixed(2)}</td>
      <td style="color:${t.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${fmtMoney(t.pnl)}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>NQ Cockpit — Tradovate Analytics Report</title>
<style>
body{font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:32px;}
h1{color:#F5A623;} h2{color:#3FD0C9;margin-top:32px;}
table{border-collapse:collapse;width:100%;margin-top:12px;}
th,td{padding:8px 10px;border-bottom:1px solid #263654;text-align:left;font-size:13px;}
th{color:#7F8CA6;text-transform:uppercase;font-size:11px;}
.stat{display:inline-block;margin-right:32px;font-size:14px;}
.stat b{display:block;font-size:20px;color:#3FD0C9;}
</style></head>
<body>
<h1>NQ COCKPIT — Tradovate Analytics Report</h1>
<p>${accountLabel} · Generated ${new Date().toLocaleString()}</p>
<div class="stat"><b>${fmtMoney(totalPnl)}</b>Realized P&amp;L (matched trades)</div>
<div class="stat"><b>${matchedTrades.length}</b>Closed Trades</div>
<div class="stat"><b>${winRate}%</b>Win Rate</div>
<div class="stat"><b>${cashBalance?.netLiq !== undefined ? fmtMoney(cashBalance.netLiq) : "—"}</b>Net Liquidity (live)</div>
${addedToLoser.length > 0 ? `
<div style="border:1px solid #E5484D;border-radius:6px;padding:12px 14px;background:rgba(229,72,77,0.08);margin:16px 0;">
  <div style="font-weight:bold;margin-bottom:6px;">\u26a0 Added to a losing position \u2014 ${addedToLoser.length} instance${addedToLoser.length === 1 ? "" : "s"}</div>
  ${addedToLoser.map((inst) => `<div style="color:#7F8CA6;font-size:13px;margin-top:4px;">${inst.earlier.symbol} ${inst.earlier.side.toUpperCase()}: entered ${inst.earlier.entryPrice.toFixed(2)} at ${new Date(inst.earlier.entryTime).toLocaleString()}, then added at ${inst.later.entryPrice.toFixed(2)} at ${new Date(inst.later.entryTime).toLocaleString()} while the first was still open and underwater.</div>`).join("")}
</div>` : ""}
<h2>Equity Curve (Realized, FIFO-matched)</h2>
${await buildChartsHtml(matchedTrades.map((t) => ({ label: new Date(t.exitTime).toLocaleString(), pnl: t.pnl, entryDate: t.entryTime, date: t.exitTime })))}
<h2>Closed Trades (FIFO matched)</h2>
<table><thead><tr><th>Exit Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No closed trades yet.</td></tr>'}</tbody></table>
<p style="color:#7F8CA6;font-size:11px;margin-top:24px;">Realized P&amp;L is calculated by this app via FIFO matching of Tradovate fills — cross-check against Tradovate's own statements before relying on it for tax or accounting purposes.</p>
</body></html>`;
}

function downloadHtmlReport(html: string, filename: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Opens the report in a new tab instead of forcing a download — the object
// URL is revoked after a delay rather than immediately, since the new tab
// needs time to actually load the blob before it disappears.
function viewHtmlReport(html: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadAnalyticsPdf(
  accountLabel: string,
  cashBalance: any,
  matchedTrades: MatchedTrade[],
  totalPnl: number,
  winRate: number
) {
  const doc = new jsPDF();
  let y = 20;
  doc.setFont("courier", "bold");
  doc.setFontSize(16);
  doc.text("NQ COCKPIT — Tradovate Analytics Report", 14, y);
  y += 7;
  doc.setFontSize(10);
  doc.setFont("courier", "normal");
  doc.text(`${accountLabel} · ${new Date().toLocaleString()}`, 14, y);
  y += 10;

  doc.setFontSize(11);
  doc.text(`Realized P&L: ${fmtMoney(totalPnl)}`, 14, y);
  doc.text(`Closed Trades: ${matchedTrades.length}`, 90, y);
  doc.text(`Win Rate: ${winRate}%`, 150, y);
  y += 12;

  // Equity curve, drawn as vector lines directly (no canvas needed)
  if (matchedTrades.length > 1) {
    const chartW = 180, chartH = 50, chartX = 14, chartY = y;
    const { points } = equityCurvePoints(matchedTrades, chartW, chartH, 0);
    const min = Math.min(0, ...points);
    const max = Math.max(0, ...points);
    const range = max - min || 1;
    doc.setDrawColor(63, 208, 201);
    doc.rect(chartX, chartY, chartW, chartH);
    for (let i = 0; i < points.length - 1; i++) {
      const x1 = chartX + (i / (points.length - 1)) * chartW;
      const x2 = chartX + ((i + 1) / (points.length - 1)) * chartW;
      const y1 = chartY + chartH - ((points[i] - min) / range) * chartH;
      const y2 = chartY + chartH - ((points[i + 1] - min) / range) * chartH;
      doc.line(x1, y1, x2, y2);
    }
    y += chartH + 12;
    doc.setFont("courier", "normal");
    doc.setFontSize(9);
    doc.text("Equity curve (realized P&L, FIFO-matched)", chartX, y);
    y += 10;
  }

  doc.setFont("courier", "bold");
  doc.setFontSize(10);
  doc.text("Time", 14, y);
  doc.text("Symbol", 55, y);
  doc.text("Side", 85, y);
  doc.text("Entry", 105, y);
  doc.text("Exit", 130, y);
  doc.text("P&L", 160, y);
  y += 6;
  doc.setFont("courier", "normal");

  matchedTrades.forEach((t) => {
    if (y > 280) {
      doc.addPage();
      y = 20;
    }
    doc.text(new Date(t.exitTime).toLocaleDateString(), 14, y);
    doc.text(t.symbol, 55, y);
    doc.text(t.side.toUpperCase(), 85, y);
    doc.text(t.entryPrice.toFixed(2), 105, y);
    doc.text(t.exitPrice.toFixed(2), 130, y);
    doc.text(fmtMoney(t.pnl), 160, y);
    y += 6;
  });

  doc.save(`nq-cockpit-tradovate-analytics-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// Best-effort session label from the exit timestamp's local hour, since
// Tradovate fills don't carry a session tag of their own — used only to
// pre-fill the Journal entry, same buckets as the manual Trade Journal form.
function sessionFromDate(iso: string): string {
  const h = new Date(iso).getHours() + new Date(iso).getMinutes() / 60;
  if (h >= 9.5 && h < 10.5) return "NY Open";
  if (h >= 10.5 && h < 14) return "NY AM";
  if (h >= 14 && h < 16) return "NY PM";
  if (h >= 3 && h < 8) return "London";
  if (h >= 20 || h < 3) return "Asia";
  return "Overnight";
}

// A matched trade is treated as already synced if a journal entry exists
// with the same symbol, side, entry/exit price, and a date within a minute
// of the fill's exit time — avoids duplicate journal rows on repeat pulls.
function findSyncedTrade(mt: MatchedTrade, trades: Trade[]): Trade | undefined {
  const exitMs = new Date(mt.exitTime).getTime();
  return trades.find((t) => {
    if (t.symbol !== mt.symbol) return false;
    if (t.dir !== mt.side) return false;
    if (t.entry === null || t.exit === null) return false;
    if (Math.abs(t.entry - mt.entryPrice) > 0.01) return false;
    if (Math.abs(t.exit - mt.exitPrice) > 0.01) return false;
    return Math.abs(new Date(t.date).getTime() - exitMs) < 60000;
  });
}

function TVAnalyticsTab({ settings, trades, onTradeSynced, onTradeUpdated }: { settings: Settings; trades: Trade[]; onTradeSynced: (t: Trade) => void; onTradeUpdated: (t: Trade) => void }) {
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ fills: any[]; positions: any[]; cashBalance: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tradovate/status?env=${settings.tradovateEnv}`)
      .then((r) => r.json())
      .then((d) => {
        setAccounts(d.accounts || []);
        // Prefers the account pinned in Settings for this environment,
        // falling back to auto-select only when there's genuinely just one
        // account and nothing configured.
        const preferredId = settings.tradovateEnv === "live" ? settings.liveAccountId : settings.demoAccountId;
        const preferredMatch = preferredId
          ? d.accounts?.find((a: any) => String(a.id) === String(preferredId) || String(a.name) === String(preferredId))
          : null;
        if (preferredMatch) {
          setAccountId(String(preferredMatch.id));
        } else if (d.accounts?.length === 1) {
          setAccountId(String(d.accounts[0].id));
        }
      });
  }, [settings.tradovateEnv, settings.liveAccountId, settings.demoAccountId]);

  async function sync() {
    if (!accountId) {
      alert("Select an account first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tradovate/analytics?env=${settings.tradovateEnv}&accountId=${accountId}`);
      const d = await res.json();
      if (d.error) {
        setError(d.error);
      } else {
        setData(d);
      }
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setLoading(false);
  }

  const matchedTrades = data ? matchFillsToTrades(data.fills, settings.multiplier) : [];
  const totalPnl = matchedTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = matchedTrades.filter((t) => t.pnl > 0).length;
  const winRate = matchedTrades.length ? Math.round((wins / matchedTrades.length) * 100) : 0;
  const accountLabel = `${settings.tradovateEnv.toUpperCase()} account ${accounts.find((a) => String(a.id) === accountId)?.name || accountId}`;
  const holdAnalysis = analyzeHoldTimes(matchedTrades);
  const unsyncedTrades = matchedTrades.filter((t) => !findSyncedTrade(t, trades));

  async function syncTradeToJournal(t: MatchedTrade) {
    const trade = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: t.symbol,
        dir: t.side,
        session: sessionFromDate(t.exitTime),
        entry: String(t.entryPrice),
        exit: String(t.exitPrice),
        size: String(t.qty),
        pnl: t.pnl,
        setup: null,
        emotion: null,
        notes: "Synced from Tradovate \u2014 auto-imported from real fills, not self-reported.",
        disciplined: null, // no checklist exists for a broker fill; leave unrated rather than assuming clean
        source: settings.tradovateEnv === "live" ? "live" : "demo",
        checklistSnapshot: [],
        plannedStop: null,
        plannedTarget: null,
        date: t.exitTime,
        entryDate: t.entryTime,
      }),
    }).then((r) => r.json());
    onTradeSynced(trade);
  }

  async function syncAllToJournal() {
    if (unsyncedTrades.length === 0) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      for (const t of unsyncedTrades) {
        await syncTradeToJournal(t);
      }
      setSyncMsg(`\u2713 Synced ${unsyncedTrades.length} trade${unsyncedTrades.length === 1 ? "" : "s"} to the Journal.`);
    } catch (err: any) {
      setSyncMsg(`\u26a0 Sync failed: ${err.message || String(err)}`);
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(null), 4000);
  }

  // Backfills entryDate on existing Journal trades that were synced before
  // that field existed. Matches each pulled Tradovate fill against an
  // existing Journal entry using the exact same criteria as
  // findSyncedTrade (symbol/side/entry/exit price + exit time within a
  // minute) — only updates trades that are a confident match and currently
  // missing entryDate; never touches anything else.
  async function backfillEntryDates() {
    const candidates = matchedTrades
      .map((mt) => ({ mt, existing: findSyncedTrade(mt, trades) }))
      .filter((x): x is { mt: MatchedTrade; existing: Trade } => !!x.existing && x.existing.entryDate === null);
    if (candidates.length === 0) {
      setSyncMsg("No trades needed backfilling \u2014 either already have entry times, or aren't matched to a pulled fill.");
      setTimeout(() => setSyncMsg(null), 4000);
      return;
    }
    setSyncing(true);
    setSyncMsg(null);
    try {
      for (const { mt, existing } of candidates) {
        const updated = await fetch(`/api/trades/${existing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryDate: mt.entryTime }),
        }).then((r) => r.json());
        onTradeUpdated(updated);
      }
      setSyncMsg(`\u2713 Backfilled entry times on ${candidates.length} trade${candidates.length === 1 ? "" : "s"}.`);
    } catch (err: any) {
      setSyncMsg(`\u26a0 Backfill failed: ${err.message || String(err)}`);
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(null), 4000);
  }

  const chart = matchedTrades.length > 1 ? equityCurvePoints(matchedTrades, 900, 180, 10) : null;

  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Tradovate Analytics</div>
        <div className="panel-desc">Pulls your real fills, positions, and account balance directly from Tradovate — {settings.tradovateEnv.toUpperCase()} environment. Read-only, no orders placed.</div>
        <div className="grid2">
          <div className="field"><label>Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Select account…</option>
              {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn primary" onClick={sync} disabled={loading} style={{ width: "100%" }}>
              {loading ? "Syncing…" : "Pull Analytics"}
            </button>
          </div>
        </div>
        {error && <div className="status-banner status-warn" style={{ marginTop: 12 }}>⚠ {JSON.stringify(error)}</div>}
      </div>

      {data && (
        <>
          <div className="panel-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div className="panel-title" style={{ margin: 0 }}>Account Summary</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {syncMsg && <span style={{ fontSize: 12 }}>{syncMsg}</span>}
                <button
                  className="btn small primary"
                  onClick={syncAllToJournal}
                  disabled={syncing || matchedTrades.length === 0 || unsyncedTrades.length === 0}
                  title={matchedTrades.length === 0 ? "No closed trades to sync yet" : unsyncedTrades.length === 0 ? "All closed trades are already in the Journal" : undefined}
                >
                  {syncing ? "Syncing…" : unsyncedTrades.length === 0 && matchedTrades.length > 0 ? "All Synced" : `Sync to Journal${unsyncedTrades.length ? ` (${unsyncedTrades.length})` : ""}`}
                </button>
                <button
                  className="btn small ghost"
                  onClick={backfillEntryDates}
                  disabled={syncing || matchedTrades.length === 0}
                  title="Fills in missing entry times on already-synced Journal trades, matched against pulled Tradovate fills — needed for Hold Time and the 'added to a losing position' detection to work on older trades."
                >
                  {syncing ? "Working…" : "Backfill Entry Times"}
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => {
                    const win = window.open("", "_blank");
                    buildAnalyticsHtmlReport(accountLabel, data.cashBalance, matchedTrades, totalPnl, winRate).then((html) => {
                      if (!win) return; // popup was blocked despite opening synchronously — nothing more we can do
                      const blob = new Blob([html], { type: "text/html" });
                      win.location.href = URL.createObjectURL(blob);
                    });
                  }}
                >
                  View HTML
                </button>
                <button className="btn small ghost" onClick={async () => downloadHtmlReport(await buildAnalyticsHtmlReport(accountLabel, data.cashBalance, matchedTrades, totalPnl, winRate), `nq-cockpit-analytics-${new Date().toISOString().slice(0, 10)}.html`)}>Download HTML</button>
                <button className="btn small ghost" onClick={() => downloadAnalyticsPdf(accountLabel, data.cashBalance, matchedTrades, totalPnl, winRate)}>Download PDF</button>
              </div>
            </div>
            <div className="stat-grid">
              <div className="stat-box"><div className={`stat-num ${totalPnl >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtMoney(totalPnl)}</div><div className="stat-lbl">Realized P&amp;L</div></div>
              <div className="stat-box"><div className="stat-num">{matchedTrades.length}</div><div className="stat-lbl">Closed Trades</div></div>
              <div className="stat-box"><div className="stat-num">{winRate}%</div><div className="stat-lbl">Win Rate</div></div>
              <div className="stat-box"><div className="stat-num">{data.cashBalance?.netLiq !== undefined ? fmtMoney(data.cashBalance.netLiq) : "—"}</div><div className="stat-lbl">Net Liquidity (live)</div></div>
            </div>
          </div>

          {matchedTrades.length >= 4 && (
            <div className="panel-box">
              <div className="panel-title">Discipline Callouts</div>
              <div className="panel-desc">Based on real fill timestamps from Tradovate — how long you actually held winners vs. losers, not self-reported.</div>
              {holdAnalysis.patternFlag && (
                <div className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)", marginBottom: 10 }}>
                  ⚠ {holdAnalysis.patternFlag}
                </div>
              )}
              {(holdAnalysis.avgWinnerHoldMinutes !== null || holdAnalysis.avgLoserHoldMinutes !== null) && (
                <div className="stat-grid" style={{ marginBottom: holdAnalysis.flaggedTrades.length ? 14 : 0 }}>
                  <div className="stat-box"><div className="stat-num pnl-pos">{holdAnalysis.avgWinnerHoldMinutes !== null ? `${holdAnalysis.avgWinnerHoldMinutes.toFixed(1)} min` : "—"}</div><div className="stat-lbl">Avg time in winners</div></div>
                  <div className="stat-box"><div className="stat-num pnl-neg">{holdAnalysis.avgLoserHoldMinutes !== null ? `${holdAnalysis.avgLoserHoldMinutes.toFixed(1)} min` : "—"}</div><div className="stat-lbl">Avg time in losers</div></div>
                </div>
              )}
              {holdAnalysis.flaggedTrades.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {holdAnalysis.flaggedTrades.map((f, i) => (
                    <div key={i} className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" }}>
                      {new Date(f.trade.exitTime).toLocaleString()} — {f.trade.symbol} {f.trade.side.toUpperCase()} — {f.text}
                    </div>
                  ))}
                </div>
              ) : !holdAnalysis.patternFlag ? (
                <div className="empty-state">
                  {holdAnalysis.avgLoserHoldMinutes === null
                    ? "No losing trades in this data yet — nothing to compare hold times against. This section activates once you have at least one loser."
                    : "No individual trades held unusually long relative to your winners yet."}
                </div>
              ) : null}
            </div>
          )}

          {chart && (
            <div className="panel-box">
              <div className="panel-title">Equity Curve (Realized, FIFO-matched)</div>
              <svg viewBox="0 0 900 180" style={{ width: "100%", height: 180 }} preserveAspectRatio="none">
                <line x1="0" y1={chart.zeroY} x2="900" y2={chart.zeroY} stroke="var(--line)" strokeDasharray="4 4" />
                <polyline points={chart.coords} fill="none" stroke={totalPnl >= 0 ? "var(--cyan)" : "var(--red)"} strokeWidth="2" />
              </svg>
            </div>
          )}

          <div className="panel-box">
            <div className="panel-title">Open Positions</div>
            {data.positions.length === 0 ? (
              <div className="empty-state">No open positions.</div>
            ) : (
              <table>
                <thead><tr><th>Symbol</th><th>Net Pos</th><th>Avg Price</th></tr></thead>
                <tbody>
                  {data.positions.map((p: any) => (
                    <tr key={p.id}><td>{p.symbolName}</td><td>{p.netPos}</td><td>{p.netPrice?.toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel-box">
            <div className="panel-title">Closed Trades (FIFO Matched)</div>
            {matchedTrades.length === 0 ? (
              <div className="empty-state">No closed round-trip trades found yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead><tr><th>Exit</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Journal</th></tr></thead>
                  <tbody>
                    {[...matchedTrades].reverse().map((t, i) => {
                      const synced = findSyncedTrade(t, trades);
                      return (
                        <tr key={i}>
                          <td>{new Date(t.exitTime).toLocaleString()}</td>
                          <td>{t.symbol}</td>
                          <td><span className={`tag ${t.side === "long" ? "long" : "short"}`}>{t.side.toUpperCase()}</span></td>
                          <td>{t.qty}</td>
                          <td>{t.entryPrice.toFixed(2)}</td>
                          <td>{t.exitPrice.toFixed(2)}</td>
                          <td className={t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(t.pnl)}</td>
                          <td>
                            {synced ? (
                              <span style={{ fontSize: 12, opacity: 0.7 }}>✓ Synced</span>
                            ) : (
                              <button className="btn small ghost" onClick={() => syncTradeToJournal(t)} disabled={syncing}>Sync</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel-box">
            <div className="panel-title">Raw Fills</div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th></tr></thead>
                <tbody>
                  {[...data.fills].reverse().map((f: any) => (
                    <tr key={f.id}>
                      <td>{new Date(f.timestamp).toLocaleString()}</td>
                      <td>{f.symbolName}</td>
                      <td><span className={`tag ${f.action === "Buy" ? "long" : "short"}`}>{f.action.toUpperCase()}</span></td>
                      <td>{f.qty}</td>
                      <td>{f.price?.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Dashboard({ trades, allTrades, emoEntries, envLabel }: { trades: Trade[]; allTrades: Trade[]; emoEntries: EmotionalEntry[]; envLabel: string }) {
  if (allTrades.length === 0) {
    return (
      <>
        <div className="panel-box"><div className="empty-state"><div className="big">📊</div>No data yet. Your stats will appear here once you start logging trades.</div></div>
        <EmotionalPatternsPanel trades={trades} emoEntries={emoEntries} />
      </>
    );
  }
  // Was previously all-time, which meant these three numbers could never
  // reconcile against the top bar's "Today's P&L" — the whole reason this
  // panel exists is to answer "does today's P&L mix Demo and Live," so it
  // needs to use the same "today" scope as that card, not every trade ever.
  const todayStr = tradingDayKey(new Date());
  const todaysAllTrades = allTrades.filter((t) => tradingDayKey(new Date(t.date)) === todayStr);
  const envBuckets: { label: string; trades: Trade[] }[] = [
    { label: "Live", trades: todaysAllTrades.filter((t) => t.source === "live") },
    { label: "Demo", trades: todaysAllTrades.filter((t) => t.source === "demo") },
    { label: "Manual (legacy, env unknown)", trades: todaysAllTrades.filter((t) => t.source === "manual") },
  ];
  const allTimeEnvBuckets: { label: string; trades: Trade[] }[] = [
    { label: "Live", trades: allTrades.filter((t) => t.source === "live") },
    { label: "Demo", trades: allTrades.filter((t) => t.source === "demo") },
    { label: "Manual (legacy, env unknown)", trades: allTrades.filter((t) => t.source === "manual") },
  ];

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins ? trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses ? Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / losses) : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const clean = trades.filter((t) => t.disciplined === true);
  const flagged = trades.filter((t) => t.disciplined === false);
  const cleanAvg = clean.length ? clean.reduce((s, t) => s + t.pnl, 0) / clean.length : 0;
  const flagAvg = flagged.length ? flagged.reduce((s, t) => s + t.pnl, 0) / flagged.length : 0;
  const cleanWinRate = clean.length ? Math.round((clean.filter((t) => t.pnl > 0).length / clean.length) * 100) : 0;
  const flagWinRate = flagged.length ? Math.round((flagged.filter((t) => t.pnl > 0).length / flagged.length) * 100) : 0;
  const maxAbs = Math.max(Math.abs(cleanAvg), Math.abs(flagAvg), 1);

  const w = 900, h = 180, pad = 10;
  let cum = 0;
  const points = trades.map((t) => (cum += t.pnl));
  const min = Math.min(0, ...points), max = Math.max(0, ...points);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (w - 2 * pad) / (points.length - 1) : 0;
  const coords = points.map((p, i) => `${pad + i * stepX},${h - pad - ((p - min) / range) * (h - 2 * pad)}`).join(" ");
  const zeroY = h - pad - ((0 - min) / range) * (h - 2 * pad);
  const last = points[points.length - 1];
  const curveColor = last >= 0 ? "var(--cyan)" : "var(--red)";

  const sessionStats = groupBy(trades, (t) => t.session);
  const setupStats = groupBy(trades, (t) => t.setup || "(none)");
  const emotionStats = groupBy(trades, (t) => t.emotion || "(none)");

  const tradesWithFlags = trades.map((t) => ({ trade: t, flags: analyzeTradeDiscipline(t) }));
  const ranLoserTrades = tradesWithFlags.filter((x) => x.flags.some((f) => f.type === "ran_loser"));
  const earlyProfitTrades = tradesWithFlags.filter((x) => x.flags.some((f) => f.type === "early_profit"));
  const tradesWithAPlan = trades.filter((t) => t.plannedStop !== null || t.plannedTarget !== null).length;

  return (
    <>
      <div className="panel-box">
        <div className="panel-title">P&amp;L by Account — Today (Live vs. Demo)</div>
        <div className="panel-desc">Matches the scope of the "Today's P&amp;L" card at the top of the app — these three numbers should sum to that figure.</div>
        <div className="stat-grid">
          {envBuckets.map((b) => {
            const total = b.trades.reduce((s, t) => s + t.pnl, 0);
            return (
              <div className="stat-box" key={b.label}>
                <div className={`stat-num ${b.trades.length === 0 ? "" : total >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                  {b.trades.length === 0 ? "—" : fmtMoney(total)}
                </div>
                <div className="stat-lbl">{b.label} ({b.trades.length})</div>
              </div>
            );
          })}
        </div>
        <div className="panel-title" style={{ marginTop: 18, fontSize: 13, opacity: 0.75 }}>All-Time (for reference, not scoped to today)</div>
        <div className="stat-grid">
          {allTimeEnvBuckets.map((b) => {
            const total = b.trades.reduce((s, t) => s + t.pnl, 0);
            return (
              <div className="stat-box" key={b.label}>
                <div className={`stat-num ${b.trades.length === 0 ? "" : total >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                  {b.trades.length === 0 ? "—" : fmtMoney(total)}
                </div>
                <div className="stat-lbl">{b.label} ({b.trades.length})</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel-box">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div className="panel-title" style={{ margin: 0 }}>Performance Summary — All-Time ({envLabel} + manual)</div>
          <button className="btn small ghost" onClick={() => downloadTradesCSV(trades)}>Export CSV</button>
        </div>
        <div className="stat-grid">
          <div className="stat-box"><div className={`stat-num ${totalPnl >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtMoney(totalPnl)}</div><div className="stat-lbl">Total P&amp;L</div></div>
          <div className="stat-box"><div className="stat-num">{winRate}%</div><div className="stat-lbl">Win Rate</div></div>
          <div className="stat-box"><div className="stat-num pnl-pos">{fmtMoney(avgWin)}</div><div className="stat-lbl">Avg Win</div></div>
          <div className="stat-box"><div className="stat-num pnl-neg">-{fmtMoney(avgLoss)}</div><div className="stat-lbl">Avg Loss</div></div>
        </div>
        <div className="stat-grid">
          <div className="stat-box"><div className={`stat-num ${expectancy >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtMoney(expectancy)}</div><div className="stat-lbl">Expectancy / Trade</div></div>
          <div className="stat-box"><div className="stat-num">{trades.length}</div><div className="stat-lbl">Total Trades</div></div>
          <div className="stat-box"><div className="stat-num">{clean.length}</div><div className="stat-lbl">Clean Trades</div></div>
          <div className="stat-box"><div className="stat-num" style={{ color: "var(--amber)" }}>{flagged.length}</div><div className="stat-lbl">Flagged Trades</div></div>
        </div>
      </div>

      <div className="panel-box">
        <div className="panel-title">Plan Discipline — All-Time ({envLabel} + manual)</div>
        <div className="panel-desc">
          Compares what actually happened to your own stated plan (planned stop / target, logged with the trade) —
          not a judgment call, just your plan vs. your execution. {tradesWithAPlan} of {trades.length} trades had a plan declared.
        </div>
        {tradesWithAPlan === 0 ? (
          <div className="empty-state">No trades with a planned stop or target yet — log one on Pre-Trade to start tracking this.</div>
        ) : (
          <>
            <div className="stat-grid">
              <div className="stat-box"><div className="stat-num" style={{ color: ranLoserTrades.length > 0 ? "var(--red)" : undefined }}>{ranLoserTrades.length}</div><div className="stat-lbl">Times you let a loser run</div></div>
              <div className="stat-box"><div className="stat-num" style={{ color: earlyProfitTrades.length > 0 ? "var(--amber)" : undefined }}>{earlyProfitTrades.length}</div><div className="stat-lbl">Times you took profit early</div></div>
            </div>
            {(ranLoserTrades.length > 0 || earlyProfitTrades.length > 0) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                {[...ranLoserTrades, ...earlyProfitTrades].slice(0, 5).map(({ trade, flags }) => (
                  <div key={trade.id} className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)" }}>
                    {new Date(trade.date).toLocaleDateString()} — {flags[0].text}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel-box">
        <div className="panel-title">Equity Curve — All-Time ({envLabel} + manual)</div>
        <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 180 }} preserveAspectRatio="none">
          <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--line)" strokeDasharray="4 4" />
          <polyline points={coords} fill="none" stroke={curveColor} strokeWidth="2" />
        </svg>
      </div>
      <div className="panel-box">
        <div className="panel-title">Disciplined vs. Undisciplined — All-Time ({envLabel} + manual)</div>
        <div className="panel-desc">Does following your rules actually pay?</div>
        <div className="compare-bars">
          <CompareRow label="Clean avg P&L" value={cleanAvg} max={maxAbs} display={fmtMoney(cleanAvg)} />
          <CompareRow label="Flagged avg P&L" value={flagAvg} max={maxAbs} display={fmtMoney(flagAvg)} />
          <CompareRow label="Clean win rate" value={cleanWinRate} max={100} color="var(--cyan)" display={`${cleanWinRate}%`} />
          <CompareRow label="Flagged win rate" value={flagWinRate} max={100} color="var(--amber)" display={`${flagWinRate}%`} />
        </div>
      </div>

      <div className="panel-box">
        <div className="panel-title">Calendar</div>
        <div className="panel-desc">Daily P&amp;L over the last 5 weeks.</div>
        <CalendarHeatmap trades={trades} />
      </div>

      <div className="panel-box">
        <div className="panel-title">By Session</div>
        <BreakdownTable stats={sessionStats} />
      </div>

      <div className="panel-box">
        <div className="panel-title">By Setup</div>
        <BreakdownTable stats={setupStats} />
      </div>

      <div className="panel-box">
        <div className="panel-title">By Emotional State</div>
        <BreakdownTable stats={emotionStats} />
      </div>

      <EmotionalPatternsPanel trades={trades} emoEntries={emoEntries} />
    </>
  );
}

function EmotionalPatternsPanel({ trades, emoEntries }: { trades: Trade[]; emoEntries: EmotionalEntry[] }) {
  if (emoEntries.length === 0) {
    return (
      <div className="panel-box">
        <div className="panel-title">Emotional Patterns</div>
        <div className="empty-state"><div className="big">🧠</div>No Emotional Journal entries yet. Log a few on the Emotional Journal tab to see your patterns here.</div>
      </div>
    );
  }

  const tagCounts: Record<string, number> = {};
  emoEntries.forEach((e) => { if (e.tag) tagCounts[e.tag] = (tagCounts[e.tag] || 0) + 1; });
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(...sortedTags.map(([, c]) => c), 1);

  const tradeDays = groupTradesByDay(trades);
  const tradeDayMap = new Map(tradeDays.map((d) => [d.dateStr, d]));

  const entryDays = new Map<string, EmotionalEntry[]>();
  emoEntries.forEach((e) => {
    const key = tradingDayKey(new Date(e.date));
    if (!entryDays.has(key)) entryDays.set(key, []);
    entryDays.get(key)!.push(e);
  });

  const RISK_TAGS = ["FOMO", "Tilted / Revenge", "Overconfident", "Doubt"];
  const riskyDayPnls: number[] = [];
  const calmDayPnls: number[] = [];
  tradeDays.forEach((day) => {
    const dayEntries = entryDays.get(day.dateStr) || [];
    const hasRisky = dayEntries.some((e) => e.tag && RISK_TAGS.includes(e.tag));
    if (hasRisky) riskyDayPnls.push(day.pnl);
    else calmDayPnls.push(day.pnl);
  });
  const avgRisky = riskyDayPnls.length ? riskyDayPnls.reduce((a, b) => a + b, 0) / riskyDayPnls.length : null;
  const avgCalm = calmDayPnls.length ? calmDayPnls.reduce((a, b) => a + b, 0) / calmDayPnls.length : null;

  const dayRows = Array.from(entryDays.entries())
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .slice(0, 14);

  return (
    <div className="panel-box">
      <div className="panel-title">Emotional Patterns</div>
      <div className="panel-desc">From your Emotional Journal — what you're actually feeling, cross-referenced with what actually happened that day.</div>

      <div className="card-label" style={{ marginTop: 8, marginBottom: 8 }}>TAG FREQUENCY (LAST 14 DAYS)</div>
      <div className="compare-bars" style={{ marginBottom: 20 }}>
        {sortedTags.map(([tag, count]) => (
          <div className="compare-row" key={tag}>
            <div className="compare-lbl">{tag}</div>
            <div className="compare-track"><div className="compare-fill" style={{ width: `${(count / maxCount) * 100}%`, background: RISK_TAGS.includes(tag) ? "var(--red)" : "var(--cyan)" }} /></div>
            <div className="compare-val">{count}</div>
          </div>
        ))}
      </div>

      {avgRisky !== null && avgCalm !== null && (
        <>
          <div className="card-label" style={{ marginBottom: 8 }}>DAYS WITH FOMO / TILTED / OVERCONFIDENT / DOUBT VS. OTHER DAYS</div>
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <div className="stat-box"><div className={`stat-num ${avgRisky >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtMoney(avgRisky)}</div><div className="stat-lbl">Avg P&amp;L, risky-tag days ({riskyDayPnls.length})</div></div>
            <div className="stat-box"><div className={`stat-num ${avgCalm >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtMoney(avgCalm)}</div><div className="stat-lbl">Avg P&amp;L, other trading days ({calmDayPnls.length})</div></div>
          </div>
        </>
      )}

      <div className="card-label" style={{ marginBottom: 8 }}>RECENT DAYS</div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Date</th><th>Tags Logged</th><th>That Day's P&amp;L</th><th>Trades</th></tr></thead>
          <tbody>
            {dayRows.map(([dateStr, entries]) => {
              const tradeDay = tradeDayMap.get(dateStr);
              const uniqueTags = Array.from(new Set(entries.map((e) => e.tag).filter(Boolean))) as string[];
              return (
                <tr key={dateStr}>
                  <td>{dateStr}</td>
                  <td>{uniqueTags.length ? uniqueTags.map((t) => (
                    <span key={t} className="mini-tag" style={RISK_TAGS.includes(t) ? { borderColor: "var(--red)", color: "var(--red)" } : { borderColor: "var(--cyan)", color: "var(--cyan)" }}>{t}</span>
                  )) : "—"}</td>
                  <td className={tradeDay ? (tradeDay.pnl >= 0 ? "pnl-pos" : "pnl-neg") : undefined}>{tradeDay ? fmtMoney(tradeDay.pnl) : "no trades"}</td>
                  <td>{tradeDay ? tradeDay.trades.length : 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownTable({ stats }: { stats: { key: string; count: number; pnl: number; avgPnl: number; winRate: number }[] }) {
  if (stats.length === 0) return <div className="empty-state">No data yet.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr><th>Name</th><th>Trades</th><th>Total P&amp;L</th><th>Avg P&amp;L</th><th>Win Rate</th></tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.key}>
              <td>{s.key}</td>
              <td>{s.count}</td>
              <td className={s.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(s.pnl)}</td>
              <td className={s.avgPnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(s.avgPnl)}</td>
              <td>{s.winRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarHeatmap({ trades }: { trades: Trade[] }) {
  const days = 35;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cells: { date: Date; pnl: number; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dayTrades = trades.filter((t) => {
      const td = new Date(t.date);
      return td.toDateString() === d.toDateString();
    });
    cells.push({ date: d, pnl: dayTrades.reduce((s, t) => s + t.pnl, 0), count: dayTrades.length });
  }
  const maxAbsPnl = Math.max(...cells.map((c) => Math.abs(c.pnl)), 1);

  function cellColor(pnl: number, count: number) {
    if (count === 0) return "var(--panel-2)";
    const intensity = Math.min(Math.abs(pnl) / maxAbsPnl, 1);
    if (pnl > 0) return `rgba(63,208,201,${0.15 + intensity * 0.6})`;
    if (pnl < 0) return `rgba(229,72,77,${0.15 + intensity * 0.6})`;
    return "var(--panel-2)";
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
      {cells.map((c, i) => (
        <div
          key={i}
          title={`${c.date.toLocaleDateString()} — ${c.count} trade(s), ${fmtMoney(c.pnl)}`}
          style={{
            aspectRatio: "1",
            borderRadius: 4,
            background: cellColor(c.pnl, c.count),
            border: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontFamily: "'IBM Plex Mono',monospace",
            color: "var(--muted)",
          }}
        >
          {c.date.getDate()}
        </div>
      ))}
    </div>
  );
}

function CompareRow({ label, value, max, display, color }: { label: string; value: number; max: number; display: string; color?: string }) {
  const pct = Math.abs(value) / max * 100;
  const barColor = color || (value >= 0 ? "var(--cyan)" : "var(--red)");
  return (
    <div className="compare-row">
      <div className="compare-lbl">{label}</div>
      <div className="compare-track"><div className="compare-fill" style={{ width: `${pct}%`, background: barColor }} /></div>
      <div className="compare-val">{display}</div>
    </div>
  );
}

function SettingsPanel({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [local, setLocal] = useState(settings);
  return (
    <>
      <div className="panel-box">
        <div className="panel-title">Account Settings</div>
        <div className="grid3">
          <div className="field">
            <label>Contract</label>
            <select value={local.contract} onChange={(e) => {
              const contract = e.target.value;
              const mult = CONTRACTS[contract];
              setLocal((l) => ({ ...l, contract, multiplier: mult ?? l.multiplier }));
            }}>
              {Object.keys(CONTRACTS).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field"><label>Point Multiplier ($/pt)</label><input type="number" value={local.multiplier} onChange={(e) => setLocal({ ...local, multiplier: parseFloat(e.target.value) })} /></div>
          <div className="field"><label>Daily Loss Limit ($)</label><input type="number" value={local.dailyLossLimit} onChange={(e) => setLocal({ ...local, dailyLossLimit: parseFloat(e.target.value) })} /></div>
        </div>
        <button className="btn primary" onClick={() => onSave(local)}>Save Settings</button>
      </div>

      <div className="panel-box">
        <div className="panel-title">Trading Window Guard</div>
        <div className="panel-desc">Orders placed through the Trade Ticket tab are blocked outside this window — <b>Live account only</b>. Demo is unrestricted by time. All times are Eastern (ET), matching CME hours.</div>
        {local.tradingWindowLocked && (
          <div className="status-banner status-warn" style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(229,72,77,0.1)", marginBottom: 12 }}>
            🔒 These settings are locked and cannot be changed. There is no unlock option — this was a deliberate choice when you locked them.
          </div>
        )}
        <div className="grid3">
          <div className="field"><label>Window Start (ET)</label>
            <input type="time" value={local.tradingWindowStart} disabled={local.tradingWindowLocked} onChange={(e) => setLocal({ ...local, tradingWindowStart: e.target.value })} />
          </div>
          <div className="field"><label>Window End (ET)</label>
            <input type="time" value={local.tradingWindowEnd} disabled={local.tradingWindowLocked} onChange={(e) => setLocal({ ...local, tradingWindowEnd: e.target.value })} />
          </div>
          <div className="field"><label>Cutoff Before Close (minutes)</label>
            <input type="number" value={local.cutoffMinutesBeforeClose} disabled={local.tradingWindowLocked} onChange={(e) => setLocal({ ...local, cutoffMinutesBeforeClose: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="field"><label>Block First N Minutes After Open</label>
            <input type="number" value={local.openingBufferMinutes} disabled={local.tradingWindowLocked} onChange={(e) => setLocal({ ...local, openingBufferMinutes: parseInt(e.target.value) || 0 })} />
          </div>
        </div>
        <div className="card-sub" style={{ marginBottom: 12 }}>
          Effective allowed window: {addMinutesLabel(local.tradingWindowStart, local.openingBufferMinutes)} – {addMinutesLabel(local.tradingWindowEnd, -local.cutoffMinutesBeforeClose)} ET
        </div>
        {local.tradingWindowLocked ? (
          <button className="btn primary" onClick={() => onSave(local)}>Save Settings</button>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => onSave(local)}>Save Settings</button>
            <button
              className="btn small ghost"
              style={{ borderColor: "var(--red)", color: "var(--red)" }}
              onClick={() => {
                if (confirm("Lock the Trading Window Guard permanently? You will NOT be able to change the start time, end time, cutoff, or opening buffer ever again through this app. This cannot be undone.")) {
                  const updated = { ...local, tradingWindowLocked: true };
                  setLocal(updated);
                  onSave(updated);
                }
              }}
            >
              🔒 Lock These Settings Permanently
            </button>
          </div>
        )}
      </div>

      <div className="panel-box">
        <div className="panel-title">Tradovate Environment</div>
        <div className="panel-desc">Which Tradovate environment the Trade Ticket tab connects to. Keep this on Demo until you've fully verified the integration.</div>
        <div className="field" style={{ maxWidth: 240 }}>
          <label>Environment</label>
          <select value={local.tradovateEnv} onChange={(e) => setLocal({ ...local, tradovateEnv: e.target.value })}>
            <option value="demo">Demo</option>
            <option value="live">Live</option>
          </select>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Preferred Live Account ID (optional)</label>
            <input
              value={local.liveAccountId ?? ""}
              onChange={(e) => setLocal({ ...local, liveAccountId: e.target.value || null })}
              placeholder="e.g. 1003033"
            />
          </div>
          <div className="field">
            <label>Preferred Demo Account ID (optional)</label>
            <input
              value={local.demoAccountId ?? ""}
              onChange={(e) => setLocal({ ...local, demoAccountId: e.target.value || null })}
              placeholder="e.g. 1234567"
            />
          </div>
        </div>
        <div className="panel-desc" style={{ marginTop: -8 }}>
          If more than one account shows up for an environment, this one gets auto-selected on Trade Ticket and TV Analytics instead of asking you to pick every time. Leave blank if there's only ever one account — it'll auto-select on its own.
        </div>
        <button className="btn primary" onClick={() => onSave(local)}>Save Settings</button>
      </div>

      <div className="panel-box">
        <div className="panel-title">Session</div>
        <div className="panel-desc">Log out of this device — you'll need your username and password to log back in.</div>
        <button
          className="btn small ghost"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          Log Out
        </button>
      </div>
    </>
  );
}

// Only computable when entryDate is actually known (real synced Tradovate
// fills going forward) — returns null rather than guessing for manual
// entries or trades synced before entryDate existed.
// Finds instances where a trade's entry happened while an earlier,
// same-symbol, same-direction trade's position was still open, at a price
// that made the earlier position worse (further underwater) rather than
// better. Only works for trades with entryDate populated — for anything
// missing it (older manual entries, trades synced before entryDate
// existed), there's no way to know if positions overlapped in time at all,
// so those are silently excluded rather than guessed.
type AddedToLoserInstance = { earlier: Trade; later: Trade };
function findAddedToLoserInstances(trades: Trade[]): AddedToLoserInstance[] {
  const withEntry = trades.filter((t) => t.entryDate && t.entry !== null);
  const results: AddedToLoserInstance[] = [];
  for (const later of withEntry) {
    // Picks only the single most recent qualifying prior position, rather
    // than every earlier position this trade happened to overlap with —
    // otherwise a chain of 5 sequential adds reports as 10 combinatorial
    // pairs instead of the 4 actual add-on decisions that happened.
    let best: Trade | null = null;
    let bestEntryTime = -Infinity;
    for (const earlier of withEntry) {
      if (earlier.id === later.id) continue;
      if (earlier.symbol !== later.symbol || earlier.dir !== later.dir) continue;
      const earlierEntry = new Date(earlier.entryDate!).getTime();
      const earlierExit = new Date(earlier.date).getTime();
      const laterEntry = new Date(later.entryDate!).getTime();
      // "later" must have entered while "earlier" was still open.
      if (!(laterEntry > earlierEntry && laterEntry < earlierExit)) continue;
      const adverse = earlier.dir === "long" ? later.entry! < earlier.entry! : later.entry! > earlier.entry!;
      if (!adverse) continue;
      if (earlierEntry > bestEntryTime) {
        bestEntryTime = earlierEntry;
        best = earlier;
      }
    }
    if (best) results.push({ earlier: best, later });
  }
  return results;
}

// Mirror of findAddedToLoserInstances — same overlap logic, but flagging the
// opposite (and desirable) pattern: adding to an already-open position at a
// price that's moving further in your favor, i.e. pyramiding a winner rather
// than averaging down a loser. Kept as a fully separate function (rather
// than a shared helper with a flag) to match the existing style here, and
// because a tie (later.entry === earlier.entry) should count as neither —
// that's handled by simply inverting the adverse check's strict inequality,
// not by "not adverse".
type AddedToWinnerInstance = { earlier: Trade; later: Trade };
function findAddedToWinnerInstances(trades: Trade[]): AddedToWinnerInstance[] {
  const withEntry = trades.filter((t) => t.entryDate && t.entry !== null);
  const results: AddedToWinnerInstance[] = [];
  for (const later of withEntry) {
    let best: Trade | null = null;
    let bestEntryTime = -Infinity;
    for (const earlier of withEntry) {
      if (earlier.id === later.id) continue;
      if (earlier.symbol !== later.symbol || earlier.dir !== later.dir) continue;
      const earlierEntry = new Date(earlier.entryDate!).getTime();
      const earlierExit = new Date(earlier.date).getTime();
      const laterEntry = new Date(later.entryDate!).getTime();
      if (!(laterEntry > earlierEntry && laterEntry < earlierExit)) continue;
      const favorable = earlier.dir === "long" ? later.entry! > earlier.entry! : later.entry! < earlier.entry!;
      if (!favorable) continue;
      if (earlierEntry > bestEntryTime) {
        bestEntryTime = earlierEntry;
        best = earlier;
      }
    }
    if (best) results.push({ earlier: best, later });
  }
  return results;
}

function holdTimeLabel(t: Trade): string | null {
  if (!t.entryDate) return null;
  const ms = new Date(t.date).getTime() - new Date(t.entryDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function groupTradesByDay(trades: Trade[]) {
  const map = new Map<string, Trade[]>();
  trades.forEach((t) => {
    const key = tradingDayKey(new Date(t.date));
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  });
  return Array.from(map.entries())
    .map(([dateStr, dayTrades]) => {
      const pnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const wins = dayTrades.filter((t) => t.pnl > 0).length;
      const clean = dayTrades.filter((t) => t.disciplined === true).length;
      const flagged = dayTrades.filter((t) => t.disciplined === false).length;
      const unrated = dayTrades.filter((t) => t.disciplined === null).length;
      // dateStr is "YYYY-MM-DD" (a stable grouping/sort key); displayLabel
      // is the friendly version shown in the UI — parsed at noon to avoid
      // timezone edge cases when turning the bare date back into a Date.
      const displayLabel = new Date(`${dateStr}T12:00:00`).toDateString();
      return {
        dateStr,
        displayLabel,
        trades: dayTrades,
        pnl,
        winRate: Math.round((wins / dayTrades.length) * 100),
        clean,
        flagged,
        unrated,
      };
    })
    .sort((a, b) => new Date(b.dateStr).getTime() - new Date(a.dateStr).getTime());
}

async function buildDayReportHtml(day: ReturnType<typeof groupTradesByDay>[number], daySnapshots: ChartSnapshot[] = []): Promise<string> {
  const addedToLoser = findAddedToLoserInstances(day.trades);
  const laterIds = new Set(addedToLoser.map((i) => i.later.id));
  const addedToWinner = findAddedToWinnerInstances(day.trades);
  const winnerIds = new Set(addedToWinner.map((i) => i.later.id));
  const rows = day.trades
    .map(
      (t) => `
    <tr${laterIds.has(t.id) ? ' style="background:rgba(229,72,77,0.15);"' : winnerIds.has(t.id) ? ' style="background:rgba(63,208,201,0.15);"' : ""}>
      <td>${laterIds.has(t.id) ? "\u26a0" : winnerIds.has(t.id) ? "\u2605" : ""}</td>
      <td>${new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${t.symbol}</td>
      <td>${t.source.toUpperCase()}</td>
      <td>${t.dir.toUpperCase()}</td>
      <td>${t.entry ?? "-"}</td>
      <td>${t.exit ?? "-"}</td>
      <td>${holdTimeLabel(t) ?? "-"}</td>
      <td style="color:${t.pnl >= 0 ? "#3FD0C9" : "#E5484D"}">${fmtMoney(t.pnl)}</td>
      <td>${t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</td>
      <td>${t.emotion || "-"}</td>
    </tr>`
    )
    .join("");

  const chartsHtml = await buildChartsHtml(
    day.trades.map((t) => ({ label: new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), pnl: t.pnl, entryDate: t.entryDate, date: t.date }))
  );

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body{background:#0B1220;color:#E8EDF5;font-family:'Courier New',monospace;padding:24px;}
  h1{color:#F5A623;margin:0 0 4px;font-size:22px;}
  h2{color:#3FD0C9;font-size:15px;margin:22px 0 8px;}
  .sub{color:#7F8CA6;margin:0 0 16px;}
  .stats{display:flex;gap:24px;margin-bottom:16px;font-size:14px;flex-wrap:wrap;}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px;}
  th{text-align:left;padding:6px 10px;color:#7F8CA6;border-bottom:1px solid #263654;}
  td{padding:6px 10px;border-bottom:1px solid #263654;}
</style></head>
<body>
  <h1>NQ COCKPIT — Daily Report</h1>
  <p class="sub">${day.displayLabel}</p>
  <div class="stats">
    <div><strong>P&amp;L:</strong> ${fmtMoney(day.pnl)}</div>
    <div><strong>Trades:</strong> ${day.trades.length}</div>
    <div><strong>Win rate:</strong> ${day.winRate}%</div>
    <div><strong>Clean/Flagged${day.unrated ? "/Unrated" : ""}:</strong> ${day.clean}/${day.flagged}${day.unrated ? "/" + day.unrated : ""}</div>
  </div>
  ${addedToLoser.length > 0 ? `
  <div style="border:1px solid #E5484D;border-radius:6px;padding:12px 14px;background:rgba(229,72,77,0.08);margin-bottom:16px;">
    <div style="font-weight:bold;margin-bottom:6px;">\u26a0 Added to a losing position \u2014 ${addedToLoser.length} instance${addedToLoser.length === 1 ? "" : "s"}</div>
    ${addedToLoser.map((inst) => `<div style="color:#7F8CA6;font-size:13px;margin-top:4px;">${inst.earlier.symbol} ${inst.earlier.dir.toUpperCase()}: entered ${inst.earlier.entry} at ${new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, then added at ${inst.later.entry} at ${new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and underwater.</div>`).join("")}
  </div>` : ""}
  ${addedToWinner.length > 0 ? `
  <div style="border:1px solid #3FD0C9;border-radius:6px;padding:12px 14px;background:rgba(63,208,201,0.08);margin-bottom:16px;">
    <div style="font-weight:bold;margin-bottom:6px;">\u2605 Added to a winning position \u2014 ${addedToWinner.length} instance${addedToWinner.length === 1 ? "" : "s"}</div>
    ${addedToWinner.map((inst) => `<div style="color:#7F8CA6;font-size:13px;margin-top:4px;">${inst.earlier.symbol} ${inst.earlier.dir.toUpperCase()}: entered ${inst.earlier.entry} at ${new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, then added at ${inst.later.entry} at ${new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and in profit.</div>`).join("")}
  </div>` : ""}
  <h2>Equity Curve</h2>
  ${chartsHtml}
  <h2>Trades</h2>
  <table>
    <thead><tr><th></th><th>Time</th><th>Symbol</th><th>Account</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Hold</th><th>P&amp;L</th><th>Discipline</th><th>Emotion</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${daySnapshots.length > 0 ? `
  <h2>Chart Snapshots</h2>
  <div style="display:flex;flex-wrap:wrap;gap:16px;">
    ${daySnapshots.map((s) => `
    <div style="width:320px;">
      <img src="${s.imageData}" style="width:100%;border-radius:6px;border:1px solid #263654;" />
      <div style="color:#7F8CA6;font-size:12px;margin-top:4px;">${new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${s.note ? ` \u2014 ${s.note}` : ""}</div>
    </div>`).join("")}
  </div>` : ""}
</body></html>`;
}

async function downloadDayReportPDF(day: ReturnType<typeof groupTradesByDay>[number], daySnapshots: ChartSnapshot[] = [], envLabel: "all" | "live" | "demo" = "all") {
  const doc = new jsPDF({ orientation: "landscape" });
  const addedToLoser = findAddedToLoserInstances(day.trades);
  const laterIds = new Set(addedToLoser.map((i) => i.later.id));
  const addedToWinner = findAddedToWinnerInstances(day.trades);
  const winnerIds = new Set(addedToWinner.map((i) => i.later.id));
  let y = 20;
  doc.setFont("courier", "bold");
  doc.setFontSize(16);
  doc.text("NQ COCKPIT — Daily Report", 14, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont("courier", "normal");
  doc.text(day.displayLabel, 14, y);
  y += 10;

  doc.setFontSize(11);
  doc.text(`P&L: ${fmtMoney(day.pnl)}`, 14, y);
  doc.text(`Trades: ${day.trades.length}`, 70, y);
  doc.text(`Win rate: ${day.winRate}%`, 120, y);
  doc.text(`Clean/Flagged${day.unrated ? "/Unrated" : ""}: ${day.clean}/${day.flagged}${day.unrated ? "/" + day.unrated : ""}`, 160, y);
  y += 8;

  if (addedToLoser.length > 0) {
    doc.setTextColor(229, 72, 77);
    doc.text(`! Added to a losing position \u00d7 ${addedToLoser.length} (marked with ! below)`, 14, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }
  if (addedToWinner.length > 0) {
    doc.setTextColor(63, 208, 201);
    doc.text(`+ Added to a winning position \u00d7 ${addedToWinner.length} (marked with + below)`, 14, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }
  if (addedToLoser.length === 0 && addedToWinner.length === 0) {
    y += 2;
  }

  const cols = [
    { label: "", x: 14 },
    { label: "Time", x: 20 },
    { label: "Symbol", x: 40 },
    { label: "Account", x: 58 },
    { label: "Dir", x: 80 },
    { label: "Entry", x: 98 },
    { label: "Exit", x: 120 },
    { label: "Hold", x: 142 },
    { label: "P&L", x: 164 },
    { label: "Discipline", x: 190 },
    { label: "Emotion", x: 222 },
  ];
  doc.setFont("courier", "bold");
  cols.forEach((c) => doc.text(c.label, c.x, y));
  y += 6;
  doc.setFont("courier", "normal");

  day.trades.forEach((t) => {
    if (y > 195) {
      doc.addPage();
      y = 20;
    }
    const time = new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (laterIds.has(t.id)) {
      doc.setTextColor(229, 72, 77);
      doc.text("!", cols[0].x, y);
    } else if (winnerIds.has(t.id)) {
      doc.setTextColor(63, 208, 201);
      doc.text("+", cols[0].x, y);
    }
    doc.text(time, cols[1].x, y);
    doc.text(t.symbol, cols[2].x, y);
    doc.text(t.source.toUpperCase(), cols[3].x, y);
    doc.text(t.dir.toUpperCase(), cols[4].x, y);
    doc.text(t.entry !== null ? String(t.entry) : "-", cols[5].x, y);
    doc.text(t.exit !== null ? String(t.exit) : "-", cols[6].x, y);
    doc.text(holdTimeLabel(t) ?? "-", cols[7].x, y);
    doc.text(fmtMoney(t.pnl), cols[8].x, y);
    doc.text(t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED", cols[9].x, y);
    doc.text((t.emotion || "-").slice(0, 14), cols[10].x, y);
    if (laterIds.has(t.id) || winnerIds.has(t.id)) doc.setTextColor(0, 0, 0);
    y += 6;
  });

  if (daySnapshots.length > 0) {
    doc.addPage();
    y = 20;
    doc.setFont("courier", "bold");
    doc.setFontSize(14);
    doc.text("Chart Snapshots", 14, y);
    y += 10;
    doc.setFont("courier", "normal");
    doc.setFontSize(10);

    const maxWidth = 260; // landscape page is ~297mm wide, leaving margins
    const maxHeight = 140;
    for (const s of daySnapshots) {
      // Reads the image's real dimensions so it's embedded at the correct
      // aspect ratio (contain-fit within a max box) instead of stretched.
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: maxWidth, h: maxHeight });
        img.src = s.imageData;
      });
      const scale = Math.min(maxWidth / dims.w, maxHeight / dims.h);
      const w = dims.w * scale;
      const h = dims.h * scale;
      if (y + h + 12 > 200) {
        doc.addPage();
        y = 20;
      }
      const label = `${new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${s.note ? " \u2014 " + s.note : ""}`;
      doc.text(label, 14, y);
      y += 6;
      doc.addImage(s.imageData, "JPEG", 14, y, w, h);
      y += h + 12;
    }
  }

  doc.save(`nq-cockpit-report-${envLabel}-${day.dateStr.replace(/\s+/g, "-")}.pdf`);
}

function ReportsTab({ trades, snapshots, settings }: { trades: Trade[]; snapshots: ChartSnapshot[]; settings: Settings }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [envFilter, setEnvFilter] = useState<"all" | "live" | "demo">(settings.tradovateEnv === "live" ? "live" : "demo");
  // Settings is the single source of truth for which environment you're
  // looking at — whenever it changes elsewhere in the app, this follows
  // automatically instead of silently staying on whatever was last picked
  // here. "All accounts" is still available as a manual override below,
  // it just won't persist across a Settings change.
  useEffect(() => {
    setEnvFilter(settings.tradovateEnv === "live" ? "live" : "demo");
  }, [settings.tradovateEnv]);
  const filteredTrades = envFilter === "all" ? trades : trades.filter((t) => t.source === envFilter);
  const days = groupTradesByDay(filteredTrades);

  return (
    <div className="panel-box">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="panel-title" style={{ marginBottom: 2 }}>Daily Reports</div>
          <div className="panel-desc" style={{ marginBottom: 0 }}>Same numbers as your daily email, browsable here — plus a PDF download for any day.</div>
        </div>
        <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value as "all" | "live" | "demo")}>
          <option value="all">All accounts</option>
          <option value="live">Live only</option>
          <option value="demo">Demo only</option>
        </select>
      </div>
      {days.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 12 }}><div className="big">🗒️</div>No trades logged for this filter yet.</div>
      ) : (
        days.map((day) => {
        const addedToLoser = findAddedToLoserInstances(day.trades);
        const laterIds = new Set(addedToLoser.map((i) => i.later.id));
        const addedToWinner = findAddedToWinnerInstances(day.trades);
        const winnerIds = new Set(addedToWinner.map((i) => i.later.id));
        const daySnapshots = snapshots.filter((s) => tradingDayKey(new Date(s.date)) === day.dateStr);
        return (
        <div key={day.dateStr} style={{ border: "1px solid var(--line)", borderRadius: 8, marginBottom: 10, overflow: "hidden", marginTop: 12 }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", cursor: "pointer", background: "var(--panel-2)" }}
            onClick={() => setExpanded(expanded === day.dateStr ? null : day.dateStr)}
          >
            <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
              <span className="card-label" style={{ marginBottom: 0 }}>{day.displayLabel}</span>
              <span className={day.pnl >= 0 ? "pnl-pos" : "pnl-neg"} style={{ fontFamily: "'IBM Plex Mono',monospace" }}>{fmtMoney(day.pnl)}</span>
              <span className="card-sub" style={{ marginTop: 0 }}>{day.trades.length} trade(s) · {day.winRate}% win · {day.clean} clean / {day.flagged} flagged{day.unrated ? ` / ${day.unrated} unrated` : ""}</span>
              {addedToLoser.length > 0 && (
                <span className="tag flag">⚠ Added to loser × {addedToLoser.length}</span>
              )}
              {addedToWinner.length > 0 && (
                <span className="tag clean">★ Added to winner × {addedToWinner.length}</span>
              )}
            </div>
            <button
              className="btn small ghost"
              onClick={(e) => {
                e.stopPropagation();
                const win = window.open("", "_blank");
                buildDayReportHtml(day, daySnapshots).then((html) => {
                  if (!win) return;
                  const blob = new Blob([html], { type: "text/html" });
                  win.location.href = URL.createObjectURL(blob);
                });
              }}
            >
              View HTML
            </button>
            <button
              className="btn small ghost"
              onClick={(e) => {
                e.stopPropagation();
                buildDayReportHtml(day, daySnapshots).then((html) => {
                  const blob = new Blob([html], { type: "text/html" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `nq-cockpit-report-${envFilter}-${day.dateStr.replace(/\s+/g, "-")}.html`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                });
              }}
            >
              Download HTML
            </button>
            <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); downloadDayReportPDF(day, daySnapshots, envFilter); }}>Download PDF</button>
          </div>
          {expanded === day.dateStr && (
            <div style={{ padding: "12px 16px", overflowX: "auto" }}>
              {addedToLoser.length > 0 && (
                <div style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid var(--red)", borderRadius: 6, background: "rgba(229,72,77,0.08)" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>⚠ Added to a losing position — {addedToLoser.length} instance{addedToLoser.length === 1 ? "" : "s"}</div>
                  {addedToLoser.map((inst, i) => (
                    <div key={i} className="card-sub" style={{ marginTop: i === 0 ? 0 : 4 }}>
                      {inst.earlier.symbol} {inst.earlier.dir.toUpperCase()}: entered {inst.earlier.entry} at {new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })},
                      then added at {inst.later.entry} at {new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and underwater.
                    </div>
                  ))}
                  <div className="card-sub" style={{ marginTop: 6, opacity: 0.7 }}>Only detects this for trades with a recorded entry time (Sync to Journal, or manually logged with Entry Time filled in) — older entries without one aren't included.</div>
                </div>
              )}
              {addedToWinner.length > 0 && (
                <div style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid var(--cyan)", borderRadius: 6, background: "rgba(63,208,201,0.08)" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>★ Added to a winning position — {addedToWinner.length} instance{addedToWinner.length === 1 ? "" : "s"}</div>
                  {addedToWinner.map((inst, i) => (
                    <div key={i} className="card-sub" style={{ marginTop: i === 0 ? 0 : 4 }}>
                      {inst.earlier.symbol} {inst.earlier.dir.toUpperCase()}: entered {inst.earlier.entry} at {new Date(inst.earlier.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })},
                      then added at {inst.later.entry} at {new Date(inst.later.entryDate!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} while the first was still open and in profit.
                    </div>
                  ))}
                  <div className="card-sub" style={{ marginTop: 6, opacity: 0.7 }}>Same entry-time requirement as the losing-position detector above.</div>
                </div>
              )}
              <table>
                <thead><tr><th></th><th>Time</th><th>Symbol</th><th>Account</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Hold</th><th>P&amp;L</th><th>Discipline</th><th>Emotion</th></tr></thead>
                <tbody>
                  {day.trades.map((t) => (
                    <tr key={t.id} style={laterIds.has(t.id) ? { background: "rgba(229,72,77,0.12)" } : winnerIds.has(t.id) ? { background: "rgba(63,208,201,0.12)" } : undefined}>
                      <td>{laterIds.has(t.id) ? "⚠" : winnerIds.has(t.id) ? "★" : ""}</td>
                      <td>{new Date(t.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                      <td>{t.symbol}</td>
                      <td><span className={`tag ${t.source === "live" ? "flag" : t.source === "demo" ? "clean" : "na"}`}>{t.source.toUpperCase()}</span></td>
                      <td><span className={`tag ${t.dir}`}>{t.dir.toUpperCase()}</span></td>
                      <td>{t.entry ?? "—"}</td>
                      <td>{t.exit ?? "—"}</td>
                      <td>{holdTimeLabel(t) ?? "—"}</td>
                      <td className={t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(t.pnl)}</td>
                      <td><span className={`tag ${t.disciplined === null ? "na" : t.disciplined ? "clean" : "flag"}`}>{t.disciplined === null ? "N/A" : t.disciplined ? "CLEAN" : "FLAGGED"}</span></td>
                      <td>{t.emotion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {daySnapshots.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="card-label">Chart Snapshots</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
                    {daySnapshots.map((s) => (
                      <div key={s.id} style={{ width: 200 }}>
                        <img src={s.imageData} alt={s.note || "snapshot"} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
                        <div className="card-sub" style={{ marginTop: 4 }}>{new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{s.note ? ` — ${s.note}` : ""}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        );
        })
      )}
    </div>
  );
}
