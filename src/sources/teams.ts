import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { graphGet, getUserEmail, isGraphConfigured } from './graph-client';

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

  // Live Graph API via simple HTTP client — autonomous fetch
  if (isGraphConfigured()) {
    try {
      const userEmail = getUserEmail();
      const cutoff = new Date(Date.now() - 18 * 3600 * 1000);

      const chats = await graphGet(`/users/${userEmail}/chats`, { '$top': '20' });
      const messages: string[] = [];

      for (const chat of chats?.value || []) {
        try {
          const chatMessages = await graphGet(`/users/${userEmail}/chats/${chat.id}/messages`, { '$top': '10' });

          for (const msg of chatMessages?.value || []) {
            if (msg.body?.content && msg.from?.user?.displayName) {
              const created = new Date(msg.createdDateTime);
              if (created < cutoff) continue;
              const text = msg.body.content.replace(/<[^>]+>/g, '').trim();
              if (text.length > 5) {
                const name = msg.from.user.displayName;
                const time = created.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                messages.push(`[${time}] ${name}: ${text.slice(0, 300)}`);
              }
            }
          }
        } catch {}
      }

      if (messages.length > 0) {
        const output = messages.join('\n');
        console.log(`[teams] Graph API: ${messages.length} messages`);
        const { writeFile } = await import('fs/promises');
        await writeFile(CACHE_PATH, output, 'utf-8').catch(() => {});
        return output;
      } else {
        console.log('[teams] Graph API: no recent messages');
      }
    } catch (err: any) {
      console.log(`[teams] Graph API failed: ${err.message?.slice(0, 100)} — falling through`);
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
