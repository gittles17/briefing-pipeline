/**
 * Lightweight MS Graph API client using direct HTTP (no Azure SDK dependency).
 * Uses OAuth2 client credentials flow to get an access token, then makes
 * simple fetch() calls to the Graph API.
 */

let _token: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;

  // Reuse cached token if still valid (with 5min buffer)
  if (_token && Date.now() < _token.expiresAt - 300_000) return _token.value;

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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token request failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return _token.value;
}

/** Get the user email for Graph API calls (app-only flow uses /users/{email}) */
export function getUserEmail(): string {
  return process.env.MS_USER_EMAIL || 'jonathan.gitlin@createadvertising.com';
}

/**
 * Make an authenticated GET request to the MS Graph API.
 * Returns the JSON response, or null if auth is not configured.
 */
export async function graphGet(path: string, params?: Record<string, string>): Promise<any | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API ${path} failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return res.json();
}

/** Check if Graph API credentials are configured */
export function isGraphConfigured(): boolean {
  return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);
}
