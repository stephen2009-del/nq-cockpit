// Server-side Tradovate client. Never import this from client components —
// credentials and access tokens must never reach the browser.
//
// IMPORTANT: This was written from Tradovate's published API documentation
// and community references, but has not been tested against a live Tradovate
// endpoint (this build environment has no network access to Tradovate's
// servers). Test thoroughly on the Demo environment before ever pointing
// this at Live. If field names below don't match what Tradovate actually
// returns/expects, the error responses from their API will say so — check
// server logs / the TradovateOrderLog table's rawResponse column.

type Env = "demo" | "live";

function baseUrl(env: Env) {
  return env === "live"
    ? "https://live.tradovateapi.com/v1"
    : "https://demo.tradovateapi.com/v1";
}

type TokenCacheEntry = { token: string; expiresAt: number };
const tokenCache: Partial<Record<Env, TokenCacheEntry>> = {};

function getCreds() {
  const {
    TRADOVATE_USERNAME,
    TRADOVATE_PASSWORD,
    TRADOVATE_APP_ID,
    TRADOVATE_APP_VERSION,
    TRADOVATE_CID,
    TRADOVATE_SEC,
    TRADOVATE_DEVICE_ID,
  } = process.env;

  if (
    !TRADOVATE_USERNAME ||
    !TRADOVATE_PASSWORD ||
    !TRADOVATE_APP_ID ||
    !TRADOVATE_APP_VERSION ||
    !TRADOVATE_CID ||
    !TRADOVATE_SEC ||
    !TRADOVATE_DEVICE_ID
  ) {
    throw new Error(
      "Tradovate credentials are not fully configured. Set TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_APP_ID, TRADOVATE_APP_VERSION, TRADOVATE_CID, TRADOVATE_SEC, TRADOVATE_DEVICE_ID in Railway."
    );
  }

  return {
    name: TRADOVATE_USERNAME,
    password: TRADOVATE_PASSWORD,
    appId: TRADOVATE_APP_ID,
    appVersion: TRADOVATE_APP_VERSION,
    cid: TRADOVATE_CID,
    sec: TRADOVATE_SEC,
    deviceId: TRADOVATE_DEVICE_ID,
  };
}

export async function getAccessToken(env: Env): Promise<string> {
  const cached = tokenCache[env];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const creds = getCreds();
  const res = await fetch(`${baseUrl(env)}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.accessToken) {
    throw new Error(
      `Tradovate auth failed (${env}): ${res.status} ${JSON.stringify(body)}`
    );
  }

  const expiresAt = body.expirationTime
    ? new Date(body.expirationTime).getTime()
    : Date.now() + 60 * 60 * 1000;

  tokenCache[env] = { token: body.accessToken, expiresAt };
  return body.accessToken;
}

async function tradovateFetch(env: Env, path: string, options: RequestInit = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function getAccounts(env: Env) {
  const result = await tradovateFetch(env, "/account/list");
  return result;
}

export async function getFills(env: Env, accountId: number) {
  const result = await tradovateFetch(env, `/fill/list?accountId=${accountId}`);
  return result;
}

export async function getPositions(env: Env, accountId: number) {
  const result = await tradovateFetch(env, `/position/list?accountId=${accountId}`);
  return result;
}

export async function getContractName(env: Env, contractId: number) {
  const result = await tradovateFetch(env, `/contract/item?id=${contractId}`);
  return result;
}

export async function getCashBalance(env: Env, accountId: number) {
  const result = await tradovateFetch(env, "/cashBalance/getcashbalancesnapshot", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });
  return result;
}

// Finds the open position (if any) matching a given symbol for an account.
// Tradovate's /position/list returns positions keyed by contractId, not the
// text symbol, so this resolves each position's contract name to compare.
// NOTE: not tested against a live response — if position matching seems to
// silently miss, check the contract name format Tradovate actually returns
// (e.g. "NQZ5" vs "NQZ2025" vs a root-only "NQ") and adjust the comparison.
export async function findOpenPosition(env: Env, accountId: number, symbol: string) {
  const positions = await getPositions(env, accountId);
  if (!positions.ok || !Array.isArray(positions.body)) return null;

  const openPositions = positions.body.filter((p: any) => p.netPos && p.netPos !== 0);
  for (const pos of openPositions) {
    const contract = await getContractName(env, pos.contractId);
    const name: string = contract.ok ? (contract.body.name || "") : "";
    if (name.toUpperCase() === symbol.toUpperCase() || name.toUpperCase().startsWith(symbol.toUpperCase())) {
      return { ...pos, contractName: name };
    }
  }
  return null;
}

export async function placeOrder(
  env: Env,
  params: {
    accountId: number;
    symbol: string;
    action: "Buy" | "Sell";
    orderQty: number;
    orderType: "Market" | "Limit";
    price?: number;
  }
) {
  const payload: Record<string, unknown> = {
    accountId: params.accountId,
    action: params.action,
    symbol: params.symbol,
    orderQty: params.orderQty,
    orderType: params.orderType,
    isAutomated: true,
  };
  if (params.orderType === "Limit" && params.price !== undefined) {
    payload.price = params.price;
  }

  const result = await tradovateFetch(env, "/order/placeorder", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result;
}
