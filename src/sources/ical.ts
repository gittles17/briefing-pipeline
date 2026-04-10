import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const exec = promisify(execFile);

const DB_PATH = join(homedir(), 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb');
const CACHE_PATH = join(homedir(), 'briefing-data', 'calendar.txt');
const YESTERDAY_CACHE_PATH = join(homedir(), 'briefing-data', 'yesterday-calendar.txt');
const M365_CACHE_PATH = join(homedir(), 'briefing-data', 'm365-calendar.txt');

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

function buildQuery(startOffsetDays: number, endOffsetDays: number): string {
  // CoreData epoch: Jan 1, 2001
  const epoch = new Date('2001-01-01T00:00:00');
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const startDate = new Date(todayStart.getTime() + startOffsetDays * 86400000);
  const endDate = new Date(todayStart.getTime() + endOffsetDays * 86400000);

  const startTs = (startDate.getTime() - epoch.getTime()) / 1000;
  const endTs = (endDate.getTime() - epoch.getTime()) / 1000;

  return `
SELECT
  datetime(oc.occurrence_date + 978307200, 'unixepoch', 'localtime') as start_time,
  datetime(oc.occurrence_end_date + 978307200, 'unixepoch', 'localtime') as end_time,
  ci.summary,
  c.title as calendar_name,
  COALESCE(l.title, '') as location
FROM OccurrenceCache oc
JOIN CalendarItem ci ON oc.event_id = ci.ROWID
JOIN Calendar c ON ci.calendar_id = c.ROWID
LEFT JOIN Location l ON ci.location_id = l.ROWID
WHERE oc.occurrence_date >= ${startTs}
  AND oc.occurrence_date < ${endTs}
ORDER BY oc.occurrence_date;`;
}

// Routine recurring events to filter out (kids activities, recurring personal)
const CAL_FILTER = [
  'homework club',
  'village arts',
  'hip hop class',
  'alex hip hop',
  'jake tutor',
  'jake tutoring',
  'alex jazz',
  'ashley hair',
  'therapy',
];

function formatEvents(raw: string): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const lines = raw.trim().split('\n').filter(Boolean);
  const formatted: string[] = [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;

    const [startStr, endStr, summary, calName, location] = parts;
    const summaryLower = (summary || '').trim().toLowerCase();

    // Skip routine personal events
    if (CAL_FILTER.some(f => summaryLower.includes(f))) continue;

    const start = new Date(startStr.trim());
    const end = new Date(endStr.trim());

    if (isNaN(start.getTime())) continue;

    const dayName = days[start.getDay()];
    const month = start.getMonth() + 1;
    const day = start.getDate();
    const dateStr = `${dayName} ${month}/${day}`;

    const fmt12 = (h: number, m: number) => {
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${String(m).padStart(2, '0')} ${period}`;
    };

    const sh = start.getHours();
    const sm = start.getMinutes();
    const eh = end.getHours();
    const em = end.getMinutes();

    // All-day events (00:00-23:59)
    const isAllDay = sh === 0 && sm === 0 && eh === 23 && em === 59;
    const timeStr = isAllDay ? 'all day' : `${fmt12(sh, sm)}-${fmt12(eh, em)}`;

    let entry = `${dateStr} | ${timeStr} -- ${(summary || '').trim()} [${(calName || '').trim()}]`;
    if (location && location.trim()) {
      entry += ` @ ${location.trim()}`;
    }
    formatted.push(entry);
  }

  return formatted.join('\n');
}

export async function fetchICal(): Promise<string> {
  // Prefer M365 MCP cache (richer data with attendees) — only if fresh
  const m365Fresh = await isFresh(M365_CACHE_PATH, 2);
  if (m365Fresh) {
    try {
      const m365 = await readFile(M365_CACHE_PATH, 'utf-8');
      if (m365.trim()) {
        console.log('[calendar] using fresh M365 cache (< 2h old)');
        return m365.trim();
      }
    } catch {}
  } else {
    console.log('[calendar] M365 cache is stale or missing — falling through to SQLite');
  }

  // Try SQLite direct query first (fast, no timeout issues)
  try {
    const query = buildQuery(0, 3);
    const { stdout } = await exec('sqlite3', ['-separator', '|', DB_PATH, query], { timeout: 10000 });
    if (stdout.trim()) {
      const result = formatEvents(stdout);
      if (result) {
        // Update cache
        await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
        return result;
      }
    }
  } catch {}

  // Fall back to cache
  try {
    const cached = await readFile(CACHE_PATH, 'utf-8');
    if (cached.trim()) return cached.trim();
  } catch {}

  // Last resort: AppleScript
  const SCRIPT_PATH = join(__dirname, 'calendar.applescript');
  try {
    const { stdout } = await exec('osascript', [SCRIPT_PATH], { timeout: 120000 });
    const events = stdout.trim();
    if (!events) return '(no events today)';
    const lines = events.split('\n').filter(Boolean).sort();
    return lines.join('\n');
  } catch {
    return '(calendar unavailable)';
  }
}

export async function fetchYesterdayCalendar(): Promise<string> {
  // Try SQLite direct query first
  try {
    const query = buildQuery(-1, 0);
    const { stdout } = await exec('sqlite3', ['-separator', '|', DB_PATH, query], { timeout: 10000 });
    if (stdout.trim()) {
      const result = formatEvents(stdout);
      if (result) {
        await writeFile(YESTERDAY_CACHE_PATH, result, 'utf-8').catch(() => {});
        return result;
      }
    }
  } catch {}

  // Fall back to cache
  try {
    const cached = await readFile(YESTERDAY_CACHE_PATH, 'utf-8');
    if (cached.trim()) return cached.trim();
  } catch {}

  return '(yesterday calendar unavailable)';
}
