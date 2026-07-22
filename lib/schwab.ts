import { prisma } from "@/lib/prisma";

// Server-side Schwab client. Credentials and tokens never reach the browser.
//
// Based on Schwab's published Trader API documentation and multiple
// independently-confirmed community implementations — the OAuth flow itself
// (authorize URL, token exchange format) is solid. The quote endpoint path
// is a best-effort match to Schwab's documented URL patterns, NOT verified
// against a live response from this environment (no network access to
// Schwab's servers here). If it 404s, that's the first thing to check.

const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const QUOTE_URL = "https://api.schwabapi.com/marketdata/v1/quotes";

function getCallbackUrl() {
  return process.env.SCHWAB_REDIRECT_URI || "";
}

function basicAuthHeader() {
  const id = process.env.SCHWAB_CLIENT_ID;
  const secret = process.env.SCHWAB_CLIENT_SECRET;
  if (!id || !secret) throw new Error("SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET not configured.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

export function getAuthorizationUrl(): string {
  const clientId = process.env.SCHWAB_CLIENT_ID;
  if (!clientId) throw new Error("SCHWAB_CLIENT_ID not configured.");
  return `${AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(getCallbackUrl())}`;
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getCallbackUrl(),
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Schwab token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }

  const now = Date.now();
  await prisma.schwabToken.upsert({
    where: { id: 1 },
    update: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: new Date(now + (body.expires_in ?? 1800) * 1000),
      refreshExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
    create: {
      id: 1,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: new Date(now + (body.expires_in ?? 1800) * 1000),
      refreshExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return body;
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Schwab token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

// Returns a valid access token, refreshing it if the 30-minute access token
// has expired but the 7-day refresh token is still valid. Throws a clear,
// specific error if the refresh token itself has expired — at that point
// there is no programmatic fix, only redoing the browser login flow.
export async function getValidAccessToken(): Promise<string> {
  const stored = await prisma.schwabToken.findUnique({ where: { id: 1 } });
  if (!stored) {
    throw new Error("Schwab is not connected yet. Visit /api/schwab/authorize to connect.");
  }

  if (stored.refreshExpiresAt.getTime() < Date.now()) {
    throw new Error(
      "Schwab's 7-day refresh token has expired. This requires redoing the browser login — visit /api/schwab/authorize again."
    );
  }

  if (stored.accessExpiresAt.getTime() > Date.now() + 60_000) {
    return stored.accessToken;
  }

  const refreshed = await refreshAccessToken(stored.refreshToken);
  const now = Date.now();
  await prisma.schwabToken.update({
    where: { id: 1 },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? stored.refreshToken,
      accessExpiresAt: new Date(now + (refreshed.expires_in ?? 1800) * 1000),
    },
  });
  return refreshed.access_token;
}

export async function getQuote(symbol: string) {
  const token = await getValidAccessToken();
  const res = await fetch(`${QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}
