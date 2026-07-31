import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { etDateTime } from "@/lib/serverReports";

// Trigger this Sunday evening after Globex reopens (your own scheduler,
// same ?key=CRON_SECRET mechanism as the other cron routes) — built
// directly from journal entries naming the same trigger three separate
// times: a big Friday-close-to-Sunday-reopen gap, then getting punished
// for chasing it Monday morning. This can't stop that decision, but it
// can put your own past words about this exact setup in front of you
// again before Monday's session opens, rather than after.
export const dynamic = "force-dynamic";

// Loose, deliberately generous keyword match rather than anything
// fancier — this is meant to surface entries a human would recognize as
// "this same thing again," not to be a precise classifier.
const GAP_KEYWORDS = ["gap", "globex", "reopen", "punish", "expected move", "sunday"];

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const to = process.env.REPORT_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "REPORT_EMAIL is not set" }, { status: 500 });
  }

  const recentChecks = await prisma.intradayCheck.findMany({ orderBy: { date: "desc" }, take: 2 });
  const [latest, previous] = recentChecks;

  if (!latest) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no intraday checks logged at all yet" });
  }

  const latestIsFresh = Date.now() - new Date(latest.date).getTime() < 3 * 60 * 60 * 1000; // within 3h
  const fridayClose = latestIsFresh && previous ? previous : latest;
  const sundayOpen = latestIsFresh && previous ? latest : null;

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const mult = fridayClose.qqqPrice ? fridayClose.nqPrice / fridayClose.qqqPrice : (settings?.multiplier || 20);

  // Pull a handful of past journal entries mentioning this same pattern,
  // regardless of when they were logged — the whole point is "you've
  // named this exact trigger before," not just what's in this window.
  const allEntries = await prisma.emotionalLogEntry.findMany({ orderBy: { date: "desc" }, take: 200 });
  const matchingEntries = allEntries
    .filter((e) => GAP_KEYWORDS.some((k) => e.note.toLowerCase().includes(k)))
    .slice(0, 5);

  const historyHtml = matchingEntries.length
    ? `
      <div style="margin-top:16px;">
        <div style="color:#F5A623;font-weight:bold;margin-bottom:6px;">You've named this pattern before</div>
        <ul style="margin:0;padding-left:20px;color:#E8EDF5;font-size:13px;">
          ${matchingEntries.map((e) => `<li style="margin-bottom:6px;">${etDateTime(new Date(e.date))}${e.tag ? ` [${e.tag}]` : ""}: "${e.note}"</li>`).join("")}
        </ul>
      </div>`
    : "";

  let bodyHtml: string;
  let subject: string;

  if (sundayOpen) {
    const qqqGap = sundayOpen.qqqPrice - fridayClose.qqqPrice;
    const nqGap = qqqGap * mult;
    const direction = qqqGap >= 0 ? "up" : "down";
    subject = `NQ Cockpit — Weekend Gap: ${qqqGap >= 0 ? "+" : ""}${qqqGap.toFixed(2)} QQQ pts (${direction})`;
    bodyHtml = `
      <p style="font-size:16px;margin:0 0 10px;">Friday close <b>${fridayClose.qqqPrice.toFixed(2)}</b> (NQ ${fridayClose.nqPrice.toFixed(2)}) \u2192 Sunday reopen <b>${sundayOpen.qqqPrice.toFixed(2)}</b> (NQ ${sundayOpen.nqPrice.toFixed(2)}).</p>
      <p style="font-size:20px;margin:0 0 16px;color:${qqqGap >= 0 ? "#3FD0C9" : "#E5484D"};font-weight:bold;">Gap: ${qqqGap >= 0 ? "+" : ""}${qqqGap.toFixed(2)} QQQ pts (${nqGap >= 0 ? "+" : ""}${nqGap.toFixed(2)} NQ pts)</p>
    `;
  } else {
    subject = `NQ Cockpit — log tonight's Globex price to see your weekend gap`;
    bodyHtml = `
      <p style="font-size:15px;margin:0 0 10px;">Friday's last logged price was <b>${fridayClose.qqqPrice.toFixed(2)}</b> (NQ ${fridayClose.nqPrice.toFixed(2)}), on ${etDateTime(new Date(fridayClose.date))}.</p>
      <p style="color:#7F8CA6;font-size:13px;">No fresh price logged tonight yet. Log tonight's NQ price directly on the Intraday tab (the direct-NQ-entry field works well here, since QQQ itself isn't trading) to see the actual gap before Monday.</p>
    `;
  }

  const html = `
    <div style="font-family:'Courier New',monospace;background:#0B1220;color:#E8EDF5;padding:24px;border-radius:8px;">
      <h2 style="color:#F5A623;margin:0 0 10px;">Weekend Gap Check</h2>
      ${bodyHtml}
      ${historyHtml}
    </div>
  `;

  await sendEmail({ to, subject, html });

  return NextResponse.json({ ok: true, hasGap: !!sundayOpen });
}
