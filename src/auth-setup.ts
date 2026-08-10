/**
 * One-time OAuth2 authorization code flow to get a refresh token.
 * Run: npx tsx src/auth-setup.ts
 * Opens a browser, you sign in, and the refresh token is saved.
 */
import { config } from 'dotenv';
config({ override: true });
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const PORT = 3939;
const TOKEN_PATH = join(homedir(), 'briefing-data', 'graph-tokens.json');

const tenantId = process.env.AZURE_TENANT_ID!;
const clientId = process.env.AZURE_CLIENT_ID!;
const clientSecret = process.env.AZURE_CLIENT_SECRET!;
const redirectUri = `http://localhost:${PORT}/callback`;
const scopes = 'offline_access Mail.Read Calendars.Read Chat.Read';

async function run() {
  if (!tenantId || !clientId || !clientSecret) {
    console.log('Missing AZURE_TENANT_ID, AZURE_CLIENT_ID, or AZURE_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_mode=query`;

  console.log('\n=== MS Graph OAuth Setup ===\n');
  console.log('Opening your browser to sign in...\n');
  console.log('If it doesn\'t open, go to:\n');
  console.log(authUrl);
  console.log('');

  // Open browser
  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  // Start local server to catch the callback
  return new Promise<void>((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${error}: ${url.searchParams.get('error_description')}</p>`);
        console.log(`\nAuth failed: ${error}`);
        server.close();
        process.exit(1);
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('No code received');
        return;
      }

      // Exchange code for tokens
      try {
        const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: scopes,
        });

        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          throw new Error(`Token exchange failed: ${err}`);
        }

        const tokens = await tokenRes.json() as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };

        // Save tokens
        await writeFile(TOKEN_PATH, JSON.stringify({
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          expires_at: Date.now() + tokens.expires_in * 1000,
          updated: new Date().toISOString(),
        }, null, 2), 'utf-8');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; max-width: 500px; margin: 80px auto; text-align: center;">
            <h1 style="color: #22c55e;">Done!</h1>
            <p>Refresh token saved. Your briefing pipeline can now access M365 data autonomously.</p>
            <p style="color: #888;">You can close this tab.</p>
          </body></html>
        `);

        console.log('\nRefresh token saved to ~/briefing-data/graph-tokens.json');
        console.log('The briefing pipeline will now use this for automated M365 access.\n');

        server.close();
        resolve();
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        console.log(`\nToken exchange failed: ${err.message}`);
        server.close();
        process.exit(1);
      }
    });

    server.listen(PORT, () => {
      console.log(`Waiting for sign-in callback on http://localhost:${PORT}...\n`);
    });
  });
}

run();
