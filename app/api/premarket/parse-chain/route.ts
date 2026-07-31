import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tradingDayStart } from "@/lib/tradingWindow";

// Reads either a pasted screenshot of an options chain (image) or raw
// pasted chain text, and asks Claude to extract strike/call-OI/put-OI for
// every visible row — the "you do all the maths for me" evening workflow.
// Built for the specific case named directly: upload after 8pm ET for the
// next day's expiry, once a night, and this replaces (not appends to)
// whatever was logged earlier today, so re-uploading a corrected
// screenshot doesn't create duplicates.
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server." }, { status: 500 });
  }

  const body = await req.json();
  const { imageBase64, mediaType, text } = body;
  if (!imageBase64 && !text) {
    return NextResponse.json({ error: "Provide either imageBase64 (+ mediaType) or text." }, { status: 400 });
  }

  const instructions = `You are reading an options chain (calls on one side, strikes in the middle, puts on the other — or a similarly laid-out table). Extract EVERY visible strike price along with its call open interest and put open interest. Read the actual numbers precisely — do not estimate, round, or invent values. If a side's OI isn't visible or legible for a given strike, use null for that side rather than guessing. If the chain is very wide (many dozens of strikes, or more than one expiry visible at once), it's fine to run long, but the response MUST be complete, valid JSON — never stop partway through a strike entry or leave the array unterminated.

Respond with ONLY valid JSON, no markdown fences, no preamble, no text before or after, in exactly this shape:
{"strikes": [{"strike": 683, "callOI": 1384, "putOI": 1257}, {"strike": 700, "callOI": 38894, "putOI": 38617}]}`;

  const content: any[] = [];
  if (imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: imageBase64 } });
    content.push({ type: "text", text: instructions });
  } else {
    content.push({ type: "text", text: `${instructions}\n\nCHAIN TEXT:\n${text}` });
  }

  let parsed: { strikes: { strike: number; callOI: number | null; putOI: number | null }[] };
  try {
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
          max_tokens: 8192,
          messages: [{ role: "user", content }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const errText = await res.text();
      console.error("[PARSE-CHAIN] Anthropic API error:", res.status, errText);
      return NextResponse.json({ error: `Anthropic API error ${res.status}` }, { status: 502 });
    }
    const apiBody = await res.json();
    const responseText = (apiBody.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const cleaned = responseText.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr: any) {
      console.error(`[PARSE-CHAIN] JSON parse failed (stop_reason=${apiBody.stop_reason}, response length=${responseText.length} chars): ${parseErr.message}`);
      console.error(`[PARSE-CHAIN] raw response was: ${responseText.slice(0, 2000)}`);
      throw parseErr;
    }
  } catch (err: any) {
    console.error("[PARSE-CHAIN] failed:", err.message || err);
    return NextResponse.json({ error: `Couldn't parse the chain: ${err.message || err}` }, { status: 502 });
  }

  if (!Array.isArray(parsed.strikes) || parsed.strikes.length === 0) {
    return NextResponse.json({ error: "No strikes were extracted — try a clearer screenshot or a larger crop." }, { status: 422 });
  }

  // Replace, don't append — a re-upload of a corrected/clearer screenshot
  // for the same evening shouldn't pile duplicate rows on top of the
  // first attempt.
  const startOfDay = tradingDayStart(new Date());
  await prisma.openInterestLevel.deleteMany({ where: { date: { gte: startOfDay } } });

  const created = [];
  for (const s of parsed.strikes) {
    if (typeof s.strike !== "number") continue;
    const callOI = typeof s.callOI === "number" ? s.callOI : 0;
    const putOI = typeof s.putOI === "number" ? s.putOI : 0;
    const level = await prisma.openInterestLevel.create({
      data: {
        strike: s.strike,
        oi: callOI + putOI,
        note: `Call OI ${callOI.toLocaleString()} / Put OI ${putOI.toLocaleString()}`,
      },
    });
    created.push(level);
  }

  return NextResponse.json({ ok: true, count: created.length, levels: created });
}
