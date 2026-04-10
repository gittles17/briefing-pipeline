import Database from 'better-sqlite3';
import { homedir } from 'os';
import { readFile } from 'fs/promises';

const CONTACTS_TSV = `${homedir()}/briefing-data/contacts.tsv`;

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
  const dbPath = `${homedir()}/Library/Messages/chat.db`;
  const db = new Database(dbPath, { readonly: true });

  // macOS Messages dates are nanoseconds since 2001-01-01 (Apple Cocoa epoch)
  const cocoaEpoch = 978307200;
  const nowCocoaNano = (Math.floor(Date.now() / 1000) - cocoaEpoch) * 1000000000;
  const since = nowCocoaNano - hoursBack * 3600 * 1000000000;

  const rows = db.prepare(`
    SELECT m.text, h.id as sender, m.is_from_me
    FROM message m
    JOIN handle h ON m.handle_id = h.rowid
    WHERE m.date > ? AND m.text IS NOT NULL
    ORDER BY m.date DESC
    LIMIT 40
  `).all(since) as { text: string; sender: string; is_from_me: number }[];

  db.close();

  // Resolve phone numbers to contact names
  const contactMap = await getContactMap();

  return rows.map(r => {
    const name = r.is_from_me ? 'Jonathan' : resolveContact(r.sender, contactMap);
    const prefix = r.is_from_me ? 'To' : 'From';
    return `${prefix} ${name}: ${r.text}`;
  }).join('\n') || '(no recent messages)';
}
