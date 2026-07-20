import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/tradovate";

// Tests whether this Tradovate account actually has market data entitlement,
// without building the full live-pricing pipeline first. Based on
// Tradovate's public Partner API docs and community-confirmed wire format
// (frames prefixed 'o'/'h'/'a'/'c', request format "endpoint\nid\n\nbody").
// NOT tested by me against a live connection — this environment has no
// network access to Tradovate's servers. If the wire format below is
// slightly off, the timeout/error message should still tell us something
// useful (e.g. a connection-level rejection vs. an entitlement error).
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const symbol = req.nextUrl.searchParams.get("symbol") || "NQ";

  let token: string;
  try {
    token = await getAccessToken(env);
  } catch (err: any) {
    return NextResponse.json({ error: `Could not get access token: ${err.message || err}` }, { status: 500 });
  }

  const wsUrl = env === "live" ? "wss://md.tradovateapi.com/v1/websocket" : "wss://md-demo.tradovateapi.com/v1/websocket";

  const frames: string[] = [];
  let resolved = false;

  const result = await new Promise<{ success: boolean; message: string; frames: string[] }>((resolve) => {
    let ws: WebSocket;
    const finish = (success: boolean, message: string) => {
      if (resolved) return;
      resolved = true;
      try { ws?.close(); } catch {}
      resolve({ success, message, frames });
    };

    const timeout = setTimeout(() => finish(false, "Timed out after 8s with no clear response — see raw frames."), 8000);

    try {
      ws = new WebSocket(wsUrl);
    } catch (err: any) {
      clearTimeout(timeout);
      finish(false, `Could not open WebSocket: ${err.message || err}`);
      return;
    }

    ws.onopen = () => {
      // Tradovate's WS protocol: "endpoint\nrequestId\nqueryString\nbody"
      ws.send(`authorize\n0\n\n${token}`);
    };

    ws.onmessage = (event) => {
      const raw = String(event.data);
      frames.push(raw);

      // 'o' = socket opened, 'h' = heartbeat, 'a' = data array, 'c' = closed
      if (raw.startsWith("a")) {
        try {
          const parsed = JSON.parse(raw.slice(1));
          for (const msg of parsed) {
            if (msg.i === 0) {
              // authorize response came back — now try subscribing to a quote
              ws.send(`md/subscribeQuote\n1\n\n${JSON.stringify({ symbol })}`);
            } else if (msg.i === 1) {
              if (msg.d?.errorCode) {
                clearTimeout(timeout);
                finish(false, `Subscribe rejected: ${msg.d.errorCode} — "${msg.d.errorText}". This strongly suggests market data is NOT included/entitled.`);
              } else {
                clearTimeout(timeout);
                finish(true, "Received a real response to the quote subscription with no entitlement error — market data appears to be accessible.");
              }
            } else if (msg.e === "md") {
              clearTimeout(timeout);
              finish(true, "Received actual live market data. Market data is accessible.");
            }
          }
        } catch {
          // ignore parse errors on individual frames, keep listening
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      finish(false, "WebSocket connection-level error — could not connect at all.");
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      finish(false, "Connection closed before a clear answer was received — see raw frames.");
    };
  });

  return NextResponse.json(result);
}
