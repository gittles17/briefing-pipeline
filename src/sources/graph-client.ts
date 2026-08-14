/**
 * Lightweight MS Graph API client using direct HTTP.
 * Uses delegated OAuth2 with refresh tokens for user-scoped access.
 * Falls back to client credentials if no refresh token exists.
 */
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { withFileLock } from '../utils/atomic-fs';

const TOKEN_PATH = join(homedir(), 'briefing-data', 'graph-tokens.json');

// Records the most recent delegated-refresh failure so getGraphTokenHealth()
// can report the REAL cause (expired client secret vs dead refresh token vs
// transient) instead of blanket-blaming one thing. Extracted AADSTS code drives
// the remediation message. Reset to null on a successful refresh.
let _lastAuthError: { aadsts: string; status: number; raw: string } | null = null;

/**
 * Classify a Microsoft OAuth error body into a cause + the CORRECT remediation.
 * The AADSTS code is the ground truth — different codes need different human
 * actions, and conflating them (as the old code did) sends you chasing the
 * wrong fix.
 */
export function classifyAuthError(
  status: number,
  body: string,
): { cause: 'secret-expired' | 'refresh-dead' | 'consent' | 'other'; banner: string } {
  const code = (body.match(/AADSTS\d+/) || [])[0] || '';
  // Never reached the token endpoint (DNS/Wi-Fi/connection). NOT an auth problem
  // — nothing to rotate or re-consent; it is transient and retried in-run.
  if (status === 0 || /^network:/.test(body.trim())) {
    return {
      cause: 'other',
      banner:
        '⚠️ Graph could not reach Microsoft to refresh the token this run (network error, not an auth problem) — ' +
        'Mail/Calendar/Teams/Igor/collections fell back to cached data. Usually transient; ' +
        'if it repeats, check connectivity at run time (~00:06) in ~/briefing-data/briefing.log.',
    };
  }
  // Expired/invalid client secret — the app credential, NOT the user token.
  if (/AADSTS7000222|AADSTS7000215/.test(code) || /client secret.*expired|invalid_client/i.test(body)) {
    return {
      cause: 'secret-expired',
      banner:
        '🛑 Graph auth down: the Azure app CLIENT SECRET has expired (AADSTS7000222). ' +
        'Fix (~2 min, refresh token is still valid so no re-consent needed): Entra admin center → ' +
        'App registrations → app ca161605-5918-4fe4-93cf-808eaa05da5f → Certificates & secrets → ' +
        'New client secret → copy the VALUE → set AZURE_CLIENT_SECRET in ~/Desktop/Create/Brief/.env ' +
        '(and note the new expiry as AZURE_CLIENT_SECRET_EXPIRES=YYYY-MM-DD). ' +
        'This is NOT fixable by `npm run reauth`.',
    };
  }
  // Refresh token itself expired/revoked — needs interactive re-consent.
  if (/AADSTS70008|AADSTS700082|AADSTS50173|AADSTS700084/.test(code) || /invalid_grant|token is expired|revoked/i.test(body)) {
    return {
      cause: 'refresh-dead',
      banner: '🛑 Graph refresh token expired/revoked — run `npm run reauth` to sign in again (Mail/Calendar/Teams degraded).',
    };
  }
  // Consent / scope problem.
  if (/AADSTS65001|consent/i.test(body)) {
    return {
      cause: 'consent',
      banner: '🛑 Graph consent missing for a requested scope — run `npm run reauth` to re-grant (Mail/Calendar/Teams degraded).',
    };
  }
  return {
    cause: 'other',
    banner: `🛑 Graph auth failed (HTTP ${status}${code ? `, ${code}` : ''}) — Mail/Calendar/Teams degraded this run. Check ~/briefing-data/briefing.log.`,
  };
}

/**
 * Atomic token write: write to a unique temp file, then rename.
 * Rename is atomic on POSIX, so concurrent writers never see a half-written
 * file or two writers can't clobber each other's bytes mid-stream (which is
 * how `}}` corruption snuck in). The unique pid-suffix prevents two writers
 * from racing on the same temp path.
 */
async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(obj, null, 2);
  // Sanity-check: must round-trip parse before we commit it
  try { JSON.parse(json); } catch { throw new Error('refusing to write malformed JSON to token file'); }
  await writeFile(tmp, json, 'utf-8');
  try {
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup; rethrow so caller knows
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Read tokens, recovering from common corruption patterns caused by races
 * between Brief's atomic write and the Reply repo's non-atomic writeFile to
 * the same path. Patterns observed in the wild:
 *   - `...}\n}`      (newline between extra closing braces)
 *   - `...}}`         (no newline)
 *   - `...}\n}\n`    (trailing whitespace)
 *   - `...}{...}`    (two concatenated JSON docs)
 */
async function loadTokens(): Promise<StoredTokens | null> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, 'utf-8');
  } catch {
    return null;
  }

  // Fast path: parses cleanly
  try { return JSON.parse(raw) as StoredTokens; } catch {}

  // Recovery pass 1: strip trailing whitespace then trailing extra braces
  // (handles `}}`, `}\n}`, `}\n}\n`, `}    }`, etc.)
  let candidate = raw.replace(/[\s}]+$/, ''); // strip trailing whitespace + braces
  candidate = candidate + '}'; // re-add exactly ONE closing brace
  try {
    const obj = JSON.parse(candidate) as StoredTokens;
    console.log('[graph] recovered from trailing-brace corruption — repairing file');
    await atomicWriteJson(TOKEN_PATH, obj);
    return obj;
  } catch {}

  // Recovery pass 2: file might be two concatenated JSON docs (`}{` boundary).
  // Take whichever has the more recent `updated` field.
  const splitMatch = raw.match(/^(.*?\})\s*(\{.+\})\s*$/s);
  if (splitMatch) {
    try {
      const a = JSON.parse(splitMatch[1]) as StoredTokens;
      const b = JSON.parse(splitMatch[2]) as StoredTokens;
      const winner = (b.updated || '') > (a.updated || '') ? b : a;
      console.log('[graph] recovered from concatenated-docs corruption — repairing file');
      await atomicWriteJson(TOKEN_PATH, winner);
      return winner;
    } catch {}
  }

  console.log('[graph] token file unreadable after all recovery passes — reauth needed');
  return null;
}

let _accessToken: { value: string; expiresAt: number } | null = null;

interface StoredTokens {
  refresh_token: string;
  access_token: string;
  expires_at: number;
  updated: string;
}

/**
 * Get an access token using the stored refresh token (delegated flow).
 * Automatically refreshes expired tokens and saves the new refresh token.
 */
// In-flight refresh promise. When multiple sources call getAccessToken()
// simultaneously and the access token is expired, all waiters await the SAME
// refresh request instead of firing N concurrent POSTs to the OAuth endpoint
// (which would produce racing writes to graph-tokens.json and dropped
// rotated refresh_tokens). Cleared once the refresh resolves.
let _inFlightRefresh: Promise<string | null> | null = null;

async function getAccessToken(): Promise<string | null> {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;

  // Use cached access token if still valid (5min buffer)
  if (_accessToken && Date.now() < _accessToken.expiresAt - 300_000) {
    return _accessToken.value;
  }

  // If a refresh is already in flight, await its result instead of starting a new one
  if (_inFlightRefresh) {
    return _inFlightRefresh;
  }

  _inFlightRefresh = doTokenRefresh(tenantId, clientId, clientSecret);
  try {
    return await _inFlightRefresh;
  } finally {
    _inFlightRefresh = null;
  }
}

/**
 * POST the token endpoint, retrying only THROWN (network-level) failures — DNS
 * not resolving yet, Wi-Fi still associating after wake, connection reset. An
 * HTTP error response is returned as-is so the caller can classify the AADSTS
 * code; we never retry a real auth rejection.
 */
async function fetchTokenWithRetry(url: string, body: string, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err: any) {
      lastErr = err;
      if (i < attempts) {
        const delay = i * 3000;
        console.log(`[graph] token endpoint unreachable (${err?.message?.slice(0, 60)}) — retry ${i}/${attempts - 1} in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** The actual refresh logic, separated so it's protected by _inFlightRefresh. */
async function doTokenRefresh(tenantId: string, clientId: string, clientSecret: string): Promise<string | null> {
  // CROSS-PROCESS LOCK around the whole read-refresh-write. The token file is
  // shared with the Reply repo, and Azure AD ROTATES the refresh token on every
  // use with reuse-detection: if the second process presents a token the first
  // already rotated away, Azure revokes the ENTIRE token family (both apps die).
  // Serializing refreshes on a shared lock — and re-reading + re-checking
  // freshness AFTER acquiring it — guarantees only one process refreshes per
  // rotation; the other picks up the result. The lock dir path is identical in
  // both repos so they mutually exclude.
  const locked = await withFileLock(TOKEN_PATH, async (): Promise<string | null> => {
    // Re-read INSIDE the lock: another process may have just refreshed while we
    // waited, leaving a fresh access token we can use without refreshing at all.
    const tokens = await loadTokens();
    if (!tokens) return null;

    if (tokens.access_token && Date.now() < tokens.expires_at - 300_000) {
      _accessToken = { value: tokens.access_token, expiresAt: tokens.expires_at };
      return tokens.access_token;
    }
    if (!tokens.refresh_token) return null;

    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
      scope: 'offline_access Mail.Read Calendars.Read Chat.Read',
    });

    // Retry TRANSIENT NETWORK failures before giving up. A thrown fetch (DNS not
    // up yet, Wi-Fi still associating, connection reset) is not an auth problem,
    // but a single throw used to abandon the delegated refresh and drop straight
    // to the app-only fallback — where every `/me` endpoint returns 400, taking
    // out calendar, email, Teams, collections, Igor, Auris and feedback at once.
    // Observed 2026-08-14 ("token refresh threw: fetch failed"): one retry would
    // have saved the whole brief.
    const res = await fetchTokenWithRetry(url, body.toString());

    if (res.ok) {
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
      const expiresAt = Date.now() + data.expires_in * 1000;
      _accessToken = { value: data.access_token, expiresAt };
      _lastAuthError = null; // clear any prior failure
      if (!data.refresh_token) {
        console.log('[graph] WARNING: refresh response omitted new refresh_token — rotation disabled');
      }
      await atomicWriteJson(TOKEN_PATH, {
        refresh_token: data.refresh_token || tokens.refresh_token,
        access_token: data.access_token,
        expires_at: expiresAt,
        updated: new Date().toISOString(),
      });
      console.log('[graph] token refreshed successfully');
      return data.access_token;
    }

    // Capture the failure so getGraphTokenHealth() can classify the real cause.
    const errBody = await res.text();
    _lastAuthError = { aadsts: (errBody.match(/AADSTS\d+/) || [''])[0], status: res.status, raw: errBody.slice(0, 200) };
    const { cause } = classifyAuthError(res.status, errBody);
    console.log(`[graph] token refresh failed (${res.status}, ${_lastAuthError.aadsts || 'no-code'} → ${cause}): ${errBody.slice(0, 120)}`);
    return null;
  }).catch((err: any) => {
    console.log(`[graph] token refresh threw: ${err?.message?.slice(0, 120)}`);
    // Record it so getGraphTokenHealth() reports a real cause instead of staying
    // silent. Status 0 marks "never reached the endpoint" (network), which is a
    // different problem from an AADSTS rejection.
    _lastAuthError = { aadsts: '', status: 0, raw: `network: ${err?.message?.slice(0, 150) || 'unknown'}` };
    return null as string | null;
  });

  if (locked) return locked;

  // App-only (client-credentials) fallback — DISABLED BY DEFAULT, and that is
  // deliberate. Verified against this tenant 2026-08-14: the app registration has
  // NO Application permissions granted, so an app-only token authenticates but
  // cannot read anything the brief needs — mail/calendar return
  // 403 ErrorAccessDenied and chats report "Roles on the request ''". Worse, every
  // source calls `/me/...`, which app-only tokens reject outright with
  // 400 "only valid with delegated authentication flow".
  //
  // So this path did real harm: it handed out a token that guaranteed failure on
  // all eight Graph sources, and because it populated _accessToken it also made
  // getGraphTokenHealth() report "healthy" — which is why the 2026-08-14 outage
  // (delegated refresh lost to a transient network error) silently degraded the
  // whole brief to caches with no banner. Returning null instead lets sources fall
  // back to cache immediately AND lets the health check tell the truth.
  //
  // Kept (not removed) behind a flag: if IT ever grants Application permissions
  // with admin consent, set GRAPH_APP_ONLY_FALLBACK=1 — note the callers would
  // also need `/me/...` rewritten to `/users/{getUserEmail()}/...`.
  if (process.env.GRAPH_APP_ONLY_FALLBACK !== '1') {
    console.log('[graph] delegated refresh unavailable — skipping app-only fallback (no Application permissions in this tenant; it cannot serve /me endpoints)');
    return null;
  }

  try {
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (res.ok) {
      const data = await res.json() as { access_token: string; expires_in: number };
      _accessToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
      console.log('[graph] using client credentials fallback');
      return _accessToken.value;
    }
  } catch {}

  return null;
}

/**
 * Returns a health-state summary of the Graph auth — but ONLY when reauth is
 * actually required. Microsoft access tokens have a 1-hour lifespan, so they
 * are always "expiring soon" — that's normal and the refresh_token (90-day
 * lifespan) handles rotation transparently. We only surface a warning if:
 *   - the token file is missing/unrecoverable (need reauth)
 *   - the access token is expired AND this run's refresh attempt failed
 *   - the refresh_token itself looks stale (last `updated` > 60 days ago)
 *
 * Returns empty string when everything is fine, so no noise in the brief.
 */
export async function getGraphTokenHealth(): Promise<string> {
  if (!isGraphConfigured()) {
    return '';
  }
  // Ensure refresh has been attempted at least once this run (populates
  // _lastAuthError / _accessToken).
  await getAccessToken().catch(() => null);

  const now = Date.now();

  // PRE-EXPIRY WARNING for the client secret. Secrets expire on a KNOWN date;
  // record it as AZURE_CLIENT_SECRET_EXPIRES=YYYY-MM-DD in .env when you rotate.
  // Warn while there's still time to rotate calmly, turning a hard outage into a
  // 2-minute scheduled task. (Only warns when auth is otherwise healthy — a
  // hard failure banner below takes precedence.)
  const secretExpiryWarning = ((): string => {
    const raw = process.env.AZURE_CLIENT_SECRET_EXPIRES;
    if (!raw) return '';
    const exp = new Date(raw).getTime();
    if (isNaN(exp)) return '';
    const days = Math.floor((exp - now) / 86_400_000);
    if (days < 0) return ''; // already expired — the hard banner handles it
    if (days <= 21)
      return `⚠️ Azure client secret expires in ${days} day${days === 1 ? '' : 's'} (${raw}). Rotate it in Entra → App registrations → Certificates & secrets, then update AZURE_CLIENT_SECRET (+ AZURE_CLIENT_SECRET_EXPIRES) in .env — before it takes Mail/Calendar/Teams down.`;
    return '';
  })();

  // If this run's refresh FAILED, report the classified, cause-specific cause.
  // This is the fix for the recurring misdiagnosis: an expired client secret
  // (AADSTS7000222) no longer tells you to "run reauth" (which wouldn't help).
  if (_lastAuthError) {
    const { banner } = classifyAuthError(_lastAuthError.status, `${_lastAuthError.aadsts} ${_lastAuthError.raw}`);
    return banner;
  }

  const tokens = await loadTokens();
  if (!tokens) {
    return '⚠️ Graph token file missing or unrecoverable — run `npm run reauth` to re-grant access (Mail/Calendar/Teams degraded).';
  }

  // Access token expired AND no fresh one obtained this run, but no captured
  // error (e.g. offline). Generic degraded notice.
  const accessExpired = tokens.expires_at <= now;
  const refreshDidNotSucceed = !_accessToken || _accessToken.expiresAt <= now;
  if (accessExpired && refreshDidNotSucceed) {
    return '🛑 Graph access token expired and could not refresh this run — Mail/Calendar/Teams degraded. Check ~/briefing-data/briefing.log for the cause.';
  }

  // Healthy auth — surface the pre-expiry warning if one is pending.
  return secretExpiryWarning;
}

/** Get the user email for Graph API calls */
export function getUserEmail(): string {
  return process.env.MS_USER_EMAIL || 'jonathan.gitlin@createadvertising.com';
}

/**
 * Issue a Graph fetch with 429/503 backoff. Honors the `Retry-After` response
 * header (seconds) when present; otherwise uses exponential backoff capped at
 * 30s. Retries up to 3 times before returning the final response to the caller.
 *
 * 429 = MailboxConcurrency / ApplicationThrottled — Graph asks us to slow down.
 * 503 = transient service unavailable; same treatment.
 */
async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt === MAX_ATTEMPTS) return res;

    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = Number.isFinite(retryAfterSec)
      ? Math.min(retryAfterSec * 1000, 30_000)
      : Math.min(1000 * 2 ** attempt, 30_000); // 2s, 4s, 8s...
    console.log(`[graph] ${res.status} on ${url.split('?')[0]} — retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  // Unreachable but satisfies TS
  return fetch(url, init);
}

/**
 * Make an authenticated GET request to the MS Graph API.
 * For delegated flow, uses /me/ prefix. For app-only, uses /users/{email}/.
 *
 * Supports optional extra headers (e.g., `ConsistencyLevel: eventual` for $search).
 */
export async function graphGet(
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<any | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetchWithBackoff(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API ${path} failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Variant that returns the raw fetch Response so callers can inspect status,
 * headers, and body separately. Useful when callers need to log specific
 * error codes (e.g., 400 vs 401) before falling back. Returns null only when
 * no access token is available at all (i.e., reauth needed).
 */
export async function graphFetch(
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<Response | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetchWithBackoff(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
  });
}

/** Check if Graph API credentials are configured */
export function isGraphConfigured(): boolean {
  return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);
}
