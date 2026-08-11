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

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

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
    return null as string | null;
  });

  if (locked) return locked;

  // Fall back to client credentials (app-only, needs Application permissions).
  // NOTE: this ALSO uses the client secret, so it does NOT rescue an expired
  // secret (AADSTS7000222) — it only helps when the delegated refresh token is
  // the problem and app-only scopes are configured.
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
