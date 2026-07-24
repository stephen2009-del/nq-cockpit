// Stateless, signed session tokens using HMAC-SHA256 via the Web Crypto
// API — deliberately NOT Node's `crypto` module and NOT Prisma-backed,
// since this needs to run in middleware.ts, which executes on Next.js's
// Edge runtime (no Node built-ins, no database connections there).
// `crypto.subtle` is a standard Web API available in both the Edge runtime
// and modern Node, so this same code works in both places unmodified.

const encoder = new TextEncoder();

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str: string): string {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

// Not cryptographically necessary against a remote attacker here (network
// jitter already dominates), but cheap to do correctly, so no reason not to.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function createSessionToken(secret: string, ttlMs: number = 90 * 24 * 60 * 60 * 1000): Promise<string> {
  const payload = b64url(JSON.stringify({ exp: Date.now() + ttlMs }));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null, secret: string): Promise<boolean> {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expectedSig = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expectedSig)) return false;
  try {
    const data = JSON.parse(fromB64url(payload));
    return typeof data.exp === "number" && Date.now() < data.exp;
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = "nq_session";
