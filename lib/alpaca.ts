// Alpaca market data client. Much simpler than Schwab or Tradovate — no OAuth,
// just two static headers on every request. Note: market data lives on a
// DIFFERENT domain (data.alpaca.markets) than the trading API
// (paper-api.alpaca.markets) — we only need the data domain here.
//
// Endpoint shape below matches Alpaca's documented Market Data API pattern.
// Not tested against a live response from this environment — verify via
// the diagnostic test route before trusting it.

const DATA_URL = "https://data.alpaca.markets/v2/stocks/quotes/latest";

function headers() {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY not configured.");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

export async function getQuote(symbol: string) {
  const res = await fetch(`${DATA_URL}?symbols=${encodeURIComponent(symbol)}`, {
    headers: headers(),
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}
