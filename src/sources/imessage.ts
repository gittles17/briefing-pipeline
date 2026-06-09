import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { readFile, writeFile, stat } from 'fs/promises';
import { copyDbForReading } from '../utils/copy-db-for-reading';

const CONTACTS_TSV = `${homedir()}/briefing-data/contacts.tsv`;
const CACHE_PATH = join(homedir(), 'briefing-data', 'imessages.txt');

/** Format an age from an mtime (ms) into a short human string, e.g. "2d 3h" or "5h". */
function formatAge(mtimeMs: number): string {
  const totalHours = Math.floor((Date.now() - mtimeMs) / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

/**
 * Load contact map from pre-exported TSV (phone/email → name).
 */
async function getContactMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const raw = await readFile(CONTACTS_TSV, 'utf-8');
    for (const line of raw.split('\n')) {
      const [key, name] = line.split('\t');
      if (key && name) {
        map[key.trim()] = name.trim();
        // Also store last 10 digits for phone matching
        const digits = key.replace(/\D/g, '');
        if (digits.length >= 10) {
          map[digits.slice(-10)] = name.trim();
        }
      }
    }
  } catch {}
  return map;
}

/**
 * Resolve a handle (phone/email) to a contact name.
 */
function resolveContact(handle: string, contactMap: Record<string, string>): string {
  // Direct match
  if (contactMap[handle]) return contactMap[handle];

  // Digits-only match for phone numbers
  const digits = handle.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    if (contactMap[last10]) return contactMap[last10];
  }

  // Email match (lowercase)
  const lower = handle.toLowerCase();
  for (const [key, name] of Object.entries(contactMap)) {
    if (key.toLowerCase() === lower) return name;
  }

  return handle; // fallback to raw handle
}

export async function fetchIMessages(hoursBack = 18): Promise<string> {
  const liveDbPath = `${homedir()}/Library/Messages/chat.db`;

  // Open DB + run queries inside try/catch. Messages.app holds an exclusive
  // WAL lock on the live chat.db whenever it's running, so we copy the DB +
  // sidecars to a temp dir and read the copy. The graceful placeholder is the
  // last-resort fallback if even the copy fails (e.g. Full Disk Access missing).
  let directRows: { text: string; sender: string; is_from_me: number }[] = [];
  let groupRows: { text: string; is_from_me: number; date: number; sender: string | null; group_name: string | null; chat_identifier: string }[] = [];
  let db: Database.Database | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    const copied = await copyDbForReading(liveDbPath);
    cleanup = copied.cleanup;
    db = new Database(copied.path, { readonly: true, timeout: 5000 });

    // macOS Messages dates are nanoseconds since 2001-01-01 (Apple Cocoa epoch)
    const cocoaEpoch = 978307200;
    const nowCocoaNano = (Math.floor(Date.now() / 1000) - cocoaEpoch) * 1000000000;
    const since = nowCocoaNano - hoursBack * 3600 * 1000000000;

    // 1-on-1 messages (direct handle join)
    directRows = db.prepare(`
      SELECT m.text, h.id as sender, m.is_from_me
      FROM message m
      JOIN handle h ON m.handle_id = h.rowid
      WHERE m.date > ? AND m.text IS NOT NULL
      ORDER BY m.date DESC
      LIMIT 40
    `).all(since) as typeof directRows;

    // Group chat messages (via chat_message_join, style 43 = group)
    groupRows = db.prepare(`
      SELECT m.text, m.is_from_me, m.date, h.id as sender, c.display_name as group_name, c.chat_identifier
      FROM message m
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      JOIN chat c ON cmj.chat_id = c.ROWID
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.date > ? AND m.text IS NOT NULL AND c.style = 43
      ORDER BY m.date DESC
      LIMIT 30
    `).all(since) as typeof groupRows;
  } catch (err: any) {
    console.log(`[imessage] DB read failed: ${err.message ?? err}`);
    try { db?.close(); } catch {}
    if (cleanup) await cleanup();

    // Degrade gracefully: serve an age-stamped cache (< 7 days) if the live read
    // failed (e.g. launchd lacks Full Disk Access), so the source slowly degrades
    // and visibly stays present rather than vanishing silently.
    try {
      const s = await stat(CACHE_PATH);
      const ageMs = Date.now() - s.mtimeMs;
      if (ageMs < 7 * 24 * 3600 * 1000) {
        const cached = await readFile(CACHE_PATH, 'utf-8');
        if (cached.trim()) {
          console.log(`[imessage] using on-disk cache (${formatAge(s.mtimeMs)} old)`);
          const stamp = `⚠️ iMessages below are cached as of ${formatAge(s.mtimeMs)} ago — live read failed.`;
          return `${stamp}\n\n${cached.trim()}`;
        }
      } else {
        console.log(`[imessage] cache is ${formatAge(s.mtimeMs)} old — REJECTING (> 7d)`);
      }
    } catch {}

    return '(iMessages unavailable — chat.db locked or inaccessible)';
  }

  try { db?.close(); } catch {}
  if (cleanup) await cleanup();

  // Resolve phone numbers to contact names
  const contactMap = await getContactMap();

  // Format 1-on-1 messages
  const directFormatted = directRows.map(r => {
    const name = r.is_from_me ? 'Jonathan' : resolveContact(r.sender, contactMap);
    const prefix = r.is_from_me ? 'To' : 'From';
    return `${prefix} ${name}: ${r.text}`;
  });

  // Format group chat messages
  const groupFormatted = groupRows.map(r => {
    const groupLabel = r.group_name || r.chat_identifier;
    const name = r.is_from_me ? 'Jonathan' : (r.sender ? resolveContact(r.sender, contactMap) : 'Unknown');
    return `[Group: ${groupLabel}] From ${name}: ${r.text}`;
  });

  const parts: string[] = [];
  if (directFormatted.length > 0) parts.push(directFormatted.join('\n'));
  if (groupFormatted.length > 0) {
    parts.push('--- Group Messages ---');
    parts.push(groupFormatted.join('\n'));
  }

  const result = parts.join('\n');
  if (result) {
    // Cache real messages (best-effort) so a future access loss degrades slowly
    // and visibly. Skip the empty '(no recent messages)' case below.
    await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
    return result;
  }

  return '(no recent messages)';
}
