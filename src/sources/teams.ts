import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CACHE_PATH = join(homedir(), 'briefing-data', 'teams-messages.txt');
const M365_CACHE_PATH = join(homedir(), 'briefing-data', 'm365-teams.txt');

/** Check if a file was modified within the last N hours */
async function isFresh(path: string, maxAgeHours: number): Promise<boolean> {
  try {
    const s = await stat(path);
    const ageMs = Date.now() - s.mtimeMs;
    return ageMs < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}

/**
 * Fetch recent Teams messages/chats.
 * Uses MS Graph API if credentials are available, otherwise falls back to cache.
 */
export async function fetchTeamsMessages(): Promise<string> {
  // Prefer M365 MCP cache (richer, pre-summarized data) — only if fresh
  const m365Fresh = await isFresh(M365_CACHE_PATH, 2);
  if (m365Fresh) {
    try {
      const m365 = await readFile(M365_CACHE_PATH, 'utf-8');
      if (m365.trim()) {
        console.log('[teams] using fresh M365 cache (< 2h old)');
        return m365.trim();
      }
    } catch {}
  } else {
    console.log('[teams] M365 cache is stale or missing — falling through');
  }

  const clientId = process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;

  if (clientId && tenantId && clientSecret) {
    try {
      const { ClientSecretCredential } = await import('@azure/identity');
      const { Client } = await import('@microsoft/microsoft-graph-client');
      const { TokenCredentialAuthenticationProvider } = await import('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

      const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default'],
      });

      const graphClient = Client.initWithMiddleware({ authProvider });

      // Get recent chat messages (last 18 hours)
      const cutoff = new Date(Date.now() - 18 * 3600 * 1000).toISOString();

      const chats = await graphClient.api('/me/chats')
        .top(20)
        .get();

      const messages: string[] = [];

      for (const chat of chats.value || []) {
        try {
          const chatMessages = await graphClient.api(`/me/chats/${chat.id}/messages`)
            .filter(`createdDateTime ge ${cutoff}`)
            .top(10)
            .get();

          for (const msg of chatMessages.value || []) {
            if (msg.body?.content && msg.from?.user?.displayName) {
              const text = msg.body.content.replace(/<[^>]+>/g, '').trim();
              if (text.length > 5) {
                const name = msg.from.user.displayName;
                const time = new Date(msg.createdDateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                messages.push(`[${time}] ${name}: ${text.slice(0, 300)}`);
              }
            }
          }
        } catch {}
      }

      if (messages.length > 0) {
        const output = messages.join('\n');
        // Cache for fallback
        const { writeFile } = await import('fs/promises');
        await writeFile(CACHE_PATH, output, 'utf-8').catch(() => {});
        return output;
      }
    } catch (err: any) {
      console.log(`[teams] Graph API failed: ${err.message}`);
    }
  }

  // Fall back to local cache — only if < 24h old
  const cacheFresh = await isFresh(CACHE_PATH, 24);
  if (cacheFresh) {
    try {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) {
        console.log('[teams] using local cache (< 24h old)');
        return cached.trim();
      }
    } catch {}
  } else {
    console.log('[teams] local cache is stale or missing');
  }

  return ''; // silently return empty if no Teams integration
}
