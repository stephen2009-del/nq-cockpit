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

type FailureCacheEntry = { error: string; retryAfter: number };
const failureCache: Partial<Record<Env, FailureCacheEntry>> = {};
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // Tradovate's own rate limit is hourly and CAPTCHA-gated once tripped — back off hard

// De-dupes concurrent calls: if multiple parts of the page ask for a token
// at the same instant (e.g. several components mounting together), they all
// share the SAME in-flight request instead of each firing their own login
// attempt. This is what was actually causing the rate-limit hits — not
// repeated attempts over time, but several simultaneous ones on page load.
const pendingAuth: Partial<Record<Env, Promise<string>>> = {};

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

  const failure = failureCache[env];
  if (failure && failure.retryAfter > Date.now()) {
    const waitMin = Math.ceil((failure.retryAfter - Date.now()) / 60000);
    throw new Error(
      `Skipping Tradovate login retry (cooling down after a recent failure, ~${waitMin} min left): ${failure.error}`
    );
  }

  const existingRequest = pendingAuth[env];
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = (async () => {
    const creds = getCreds();
    const res = await fetch(`${baseUrl(env)}/auth/accesstokenrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creds),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok || !body.accessToken) {
      const errorMsg = `Tradovate auth failed (${env}): ${res.status} ${JSON.stringify(body)}`;
      failureCache[env] = { error: errorMsg, retryAfter: Date.now() + FAILURE_COOLDOWN_MS };
      throw new Error(errorMsg);
    }

    delete failureCache[env];
    const expiresAt = body.expirationTime
      ? new Date(body.expirationTime).getTime()
      : Date.now() + 60 * 60 * 1000;

    tokenCache[env] = { token: body.accessToken, expiresAt };
    return body.accessToken;
  })();

  pendingAuth[env] = requestPromise;
  try {
    return await requestPromise;
  } finally {
    delete pendingAuth[env];
  }
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

// Fills with contract IDs resolved to readable symbol names — shared by the
// analytics route and the order route's daily-loss-limit check.
export async function getEnrichedFills(env: Env, accountId: number) {
  const fillsResult = await getFills(env, accountId);
  const fills = fillsResult.ok && Array.isArray(fillsResult.body) ? fillsResult.body : [];
  const uniqueContractIds = Array.from(new Set(fills.map((f: any) => f.contractId).filter(Boolean)));
  const nameMap: Record<number, string> = {};
  for (const id of uniqueContractIds) {
    const contract = await getContractName(env, id as number);
    nameMap[id as number] = contract.ok ? contract.body.name || String(id) : String(id);
  }
  return fills.map((f: any) => ({ ...f, symbolName: nameMap[f.contractId] || String(f.contractId) }));
}

export async function getPositions(env: Env, accountId: number) {
  const result = await tradovateFetch(env, `/position/list?accountId=${accountId}`);
  return result;
}

// Finds the currently working (unfilled) Stop order for a given account +
// symbol — this is what a Trail rule needs to modify. Filters Tradovate's
// order list by status and contract name.
export async function findWorkingStopOrder(env: Env, accountId: number, symbol: string) {
  const result = await tradovateFetch(env, `/order/list?accountId=${accountId}`);
  if (!result.ok || !Array.isArray(result.body)) return null;

  const candidates = result.body.filter(
    (o: any) => o.ordStatus === "Working" && (o.orderType === "Stop" || o.orderType === "StopLimit")
  );
  for (const order of candidates) {
    const contract = await getContractName(env, order.contractId);
    const name: string = contract.ok ? (contract.body.name || "") : "";
    if (name.toUpperCase() === symbol.toUpperCase() || name.toUpperCase().startsWith(symbol.toUpperCase())) {
      return { ...order, contractName: name };
    }
  }
  return null;
}

// Modifies an existing stop order's trigger price.
// IMPORTANT: Tradovate's own community forum has multiple confirmed reports
// of this endpoint returning a success response (s:200) while the order's
// actual price does NOT change. Never trust the response alone — always
// re-fetch the order afterward to verify the price actually updated. That
// verification happens in the calling code, not here.
export async function modifyStopOrder(env: Env, orderId: number, orderQty: number, newStopPrice: number) {
  const result = await tradovateFetch(env, "/order/modifyorder", {
    method: "POST",
    body: JSON.stringify({
      orderId,
      orderQty,
      orderType: "Stop",
      stopPrice: newStopPrice,
      isAutomated: true,
    }),
  });
  return result;
}

// Re-fetches a single order by ID — used immediately after modifyStopOrder
// to confirm the price actually changed, given the documented unreliability
// of trusting the modify response alone.
export async function getOrderById(env: Env, orderId: number) {
  const result = await tradovateFetch(env, `/order/item?id=${orderId}`);
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

// Resolves a root symbol ("NQ", "MNQ") to the actual current front-month
// contract Tradovate is quoting (e.g. "NQZ5"). Tries their suggest endpoint
// first (used by their own UI's symbol search), falls back to filtering the
// full contract list by name prefix + nearest expiration.
// NOT tested against live data — if this picks the wrong contract, check the
// `candidates` field in the response for what it actually saw.
export async function findFrontMonthContract(env: Env, root: string) {
  const suggest = await tradovateFetch(env, `/contract/suggest?t=${encodeURIComponent(root)}&l=20`);
  let candidates: any[] = suggest.ok && Array.isArray(suggest.body) ? suggest.body : [];

  if (candidates.length === 0) {
    const list = await tradovateFetch(env, "/contract/list");
    if (list.ok && Array.isArray(list.body)) {
      candidates = list.body.filter((c: any) =>
        typeof c.name === "string" && c.name.toUpperCase().startsWith(root.toUpperCase())
      );
    }
  }

  // Exact-prefix match only (avoid "NQ" matching "MNQ" contracts, etc.)
  candidates = candidates.filter((c: any) => {
    const name = (c.name || "").toUpperCase();
    const r = root.toUpperCase();
    // strip trailing month-code + year digits (e.g. "NQZ5" -> "NQ")
    const base = name.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "");
    return base === r;
  });

  if (candidates.length === 0) {
    return { ok: false, symbol: null, candidates: [], error: `No contracts found matching root "${root}"` };
  }

  const withExpiry = await Promise.all(
    candidates.map(async (c: any) => {
      if (c.expirationDate) return { ...c, _expiry: new Date(c.expirationDate).getTime() };
      if (c.maturityId) {
        const maturity = await tradovateFetch(env, `/contractMaturity/item?id=${c.maturityId}`);
        const exp = maturity.ok ? maturity.body.expirationDate : null;
        return { ...c, _expiry: exp ? new Date(exp).getTime() : Infinity };
      }
      return { ...c, _expiry: Infinity };
    })
  );

  const now = Date.now();
  const future = withExpiry.filter((c) => c._expiry > now).sort((a, b) => a._expiry - b._expiry);
  const chosen = future[0] || withExpiry.sort((a, b) => a._expiry - b._expiry)[0];

  return {
    ok: true,
    symbol: chosen?.name || null,
    expiration: chosen?._expiry && chosen._expiry !== Infinity ? new Date(chosen._expiry).toISOString() : null,
    candidates: withExpiry.map((c) => c.name),
  };
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

// Tradovate's own risk engine already knows whether a position is winning or
// losing (that's what it uses for margin calculations) — no market data
// subscription needed for that, since it's their internal number, not a
// live quote feed to us. This tries several plausible field names for a
// per-position P&L figure. NOT verified against a real response — if this
// always returns null, check a real position's raw JSON (log it) and tell
// me what the actual field is called, and this gets a one-line fix.
export function extractPositionPnl(position: any): number | null {
  const candidates = ["openPL", "unrealizedPnl", "unrealizedPL", "pnl", "plValue", "profitLoss"];
  for (const key of candidates) {
    if (typeof position[key] === "number") return position[key];
  }
  return null;
}

// Same idea, at the account level (total open P&L across all positions) —
// used as a secondary fallback if the position itself doesn't expose one.
export function extractAccountOpenPnl(cashBalance: any): number | null {
  if (!cashBalance) return null;
  const candidates = ["openPL", "unrealizedPl", "dayPl", "pnl"];
  for (const key of candidates) {
    if (typeof cashBalance[key] === "number") return cashBalance[key];
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

// Bracket order: entry + stop-loss + target, submitted together. Tradovate
// auto-places the stop and target once the entry fills. Based on a payload
// shape confirmed working by a Tradovate API user (Tradovate community
// forum, "Place a TP + SL order via API" thread) — not tested by me against
// a live account. accountSpec is the account's name string (not its numeric
// ID) — Tradovate's OSO endpoint requires both.
export async function placeOSO(
  env: Env,
  params: {
    accountId: number;
    accountSpec: string;
    symbol: string;
    action: "Buy" | "Sell";
    orderType: "Market" | "Limit";
    orderQty: number;
    price?: number; // only for Limit entries
    stopLossPrice: number;
    targetPrice: number;
  }
) {
  const closingAction = params.action === "Buy" ? "Sell" : "Buy";
  const payload: Record<string, unknown> = {
    accountId: params.accountId,
    accountSpec: params.accountSpec,
    symbol: params.symbol,
    action: params.action,
    orderType: params.orderType,
    orderQty: params.orderQty,
    isAutomated: true,
    bracket1: { action: closingAction, orderType: "Stop", stopPrice: params.stopLossPrice },
    bracket2: { action: closingAction, orderType: "Limit", price: params.targetPrice },
  };
  if (params.orderType === "Limit" && params.price !== undefined) {
    payload.price = params.price;
  }

  const result = await tradovateFetch(env, "/order/placeOSO", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result;
}
