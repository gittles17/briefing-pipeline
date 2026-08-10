/**
 * reauth.ts — re-establish Microsoft Graph auth.
 *
 *   npm run reauth
 *
 * This does the RIGHT thing based on WHY auth is failing (the previous alert
 * blindly said "run reauth" even when reauth couldn't help):
 *
 *  - If the CLIENT SECRET is expired (AADSTS7000222): reauth CANNOT fix it.
 *    A new secret must be minted in the Entra portal. Prints exact steps and exits.
 *  - If the REFRESH TOKEN is dead/revoked (invalid_grant): runs the interactive
 *    browser sign-in (Reply repo's proven auth flow, which writes the SAME shared
 *    ~/briefing-data/graph-tokens.json) to obtain a fresh delegated token.
 *  - If auth is currently healthy: says so and exits.
 */

import { config } from 'dotenv';
config({ override: true });
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { classifyAuthError } from './sources/graph-client';

const TOKEN_PATH = join(homedir(), 'briefing-data', 'graph-tokens.json');
const REPLY_REPO = join(homedir(), 'Desktop', 'Create', 'Reply');

async function probeRefresh(): Promise<{ ok: boolean; status: number; body: string }> {
  const tenantId = process.env.AZURE_TENANT_ID!;
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;
  const tokens = JSON.parse(await readFile(TOKEN_PATH, 'utf-8'));
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    scope: 'offline_access Mail.Read',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  console.log('Graph reauth — diagnosing why auth is failing...\n');

  let probe;
  try {
    probe = await probeRefresh();
  } catch (err: any) {
    console.log(`Could not probe (token file unreadable?): ${err?.message?.slice(0, 120)}`);
    console.log('If the token file is missing, run the interactive sign-in below.');
    probe = { ok: false, status: 0, body: 'invalid_grant' };
  }

  if (probe.ok) {
    console.log('✅ Graph auth is already healthy — nothing to do. (Refresh succeeded.)');
    process.exit(0);
  }

  const { cause, banner } = classifyAuthError(probe.status, probe.body);
  console.log(banner + '\n');

  if (cause === 'secret-expired') {
    console.log('→ This is a CLIENT SECRET expiry. `reauth` cannot fix it — a new secret');
    console.log('  must be created in the Entra portal (see the steps above). After you set');
    console.log('  AZURE_CLIENT_SECRET in .env, the existing refresh token should work again');
    console.log('  immediately (run `npm run check-access` / the next brief to confirm).');
    process.exit(1);
  }

  // refresh-dead / consent / other → do the interactive sign-in via Reply's
  // proven auth flow, which writes the same shared token file.
  console.log('→ Launching interactive sign-in (browser) to mint a fresh delegated token...\n');
  try {
    execFileSync('npm', ['run', 'auth'], { cwd: REPLY_REPO, stdio: 'inherit' });
    console.log('\n✅ Reauth complete. Run `npm run check-access` or the next brief to confirm.');
    process.exit(0);
  } catch (err: any) {
    console.log(`\n✗ Interactive auth flow failed: ${err?.message?.slice(0, 160)}`);
    console.log(`  You can run it directly:  cd ${REPLY_REPO} && npm run auth`);
    process.exit(1);
  }
}

main().catch((err: any) => {
  console.log(`reauth error: ${err?.message?.slice(0, 160) || 'unknown'}`);
  process.exit(1);
});
