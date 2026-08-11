import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { graphGet, getUserEmail, isGraphConfigured } from './graph-client';
import { copyDbForReading } from '../utils/copy-db-for-reading';

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

/** Format an age (whole hours) from an mtime (ms), e.g. "5h". */
function formatAgeHours(mtimeMs: number): string {
  const hours = Math.floor((Date.now() - mtimeMs) / 3600000);
  return `${hours}h`;
}

function buildQuery(startOffsetDays: number, endOffsetDays: number): string {
  // Cocoa/CoreData epoch: Jan 1, 2001 00:00 UTC (= unix 978307200).
  // Critical: anchor to UTC, not local time. Using `new Date('2001-01-01T00:00:00')`
  // without a 'Z' suffix gets parsed as LOCAL time (Jan = PST = UTC-8), which
  // produces an 8-hour offset that silently dropped near-boundary events
  // (e.g. Friday 8 PM Glossi Board falling outside what we thought was 5/9).
  const COCOA_EPOCH_UNIX_S = 978307200;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const startDate = new Date(todayStart.getTime() + startOffsetDays * 86400000);
  const endDate = new Date(todayStart.getTime() + endOffsetDays * 86400000);

  const startTs = startDate.getTime() / 1000 - COCOA_EPOCH_UNIX_S;
  const endTs = endDate.getTime() / 1000 - COCOA_EPOCH_UNIX_S;

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

/**
 * Build a dedup key for an event: lowercase title + ISO date+time (rounded to
 * minute). Identical events from Graph (Outlook) and SQLite (Calendar.app
 * showing the synced Exchange copy) will collide; we keep Graph's version
 * because it has attendees.
 */
function eventKey(title: string, startISO: string): string {
  return `${title.trim().toLowerCase()}|${startISO.slice(0, 16)}`;
}

/**
 * Run SQLite query and return events as { key, line }, plus original sortable
 * timestamp for merge ordering.
 */
async function fetchSqliteEvents(startOffset: number, endOffset: number): Promise<{ key: string; line: string; ts: number; calendar: string }[]> {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    // Calendar.app holds WAL locks on the live DB while running. Copy first.
    const copied = await copyDbForReading(DB_PATH);
    cleanup = copied.cleanup;
    const query = buildQuery(startOffset, endOffset);
    const { stdout } = await exec('sqlite3', ['-separator', '|', copied.path, query], { timeout: 10000 });
    if (!stdout.trim()) return [];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const out: { key: string; line: string; ts: number; calendar: string }[] = [];
    for (const raw of stdout.trim().split('\n')) {
      const parts = raw.split('|');
      if (parts.length < 4) continue;
      const [startStr, endStr, summary, calName, location] = parts;
      const summaryLower = (summary || '').trim().toLowerCase();
      if (CAL_FILTER.some(f => summaryLower.includes(f))) continue;
      const start = new Date(startStr.trim());
      const end = new Date(endStr.trim());
      if (isNaN(start.getTime())) continue;

      const fmt12 = (h: number, m: number) => {
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${h12}:${String(m).padStart(2, '0')} ${period}`;
      };
      const sh = start.getHours(), sm = start.getMinutes(), eh = end.getHours(), em = end.getMinutes();
      const isAllDay = sh === 0 && sm === 0 && eh === 23 && em === 59;
      const dayName = days[start.getDay()];
      const dateStr = `${dayName} ${start.getMonth() + 1}/${start.getDate()}`;
      const timeStr = isAllDay ? 'all day' : `${fmt12(sh, sm)}-${fmt12(eh, em)}`;
      let entry = `${dateStr} | ${timeStr} -- ${(summary || '').trim()} [${(calName || '').trim()}]`;
      if (location && location.trim()) entry += ` @ ${location.trim()}`;

      out.push({
        key: eventKey(summary || '', start.toISOString()),
        line: entry,
        ts: start.getTime(),
        calendar: (calName || '').trim(),
      });
    }
    return out;
  } catch (err: any) {
    console.log(`[calendar] SQLite query failed: ${err.message ?? err}`);
    return [];
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function fetchICal(): Promise<string> {
  // STRATEGY: Merge Graph (Outlook with rich attendee data) + SQLite (sees ALL
  // local calendars: AJ Personal, glossi.io, iCloud, Found in Mail, Holidays).
  //
  // Graph alone misses events on non-Outlook calendars (e.g. the Glossi Board
  // Meeting on Jonathan's glossi.io calendar). SQLite alone misses Outlook
  // attendee names. Merging gives the union with attendees where available.

  const graphEvents: { key: string; line: string; ts: number }[] = [];

  if (isGraphConfigured()) {
    try {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 3);

      const events = await graphGet(`/me/calendarView`, {
        'startDateTime': now.toISOString(),
        'endDateTime': end.toISOString(),
        '$top': '50',
        '$select': 'subject,start,end,attendees,location,bodyPreview,isAllDay',
        '$orderby': 'start/dateTime',
      });

      for (const evt of events?.value || []) {
        const startDt = new Date(evt.start?.dateTime + 'Z');
        const time = evt.isAllDay ? 'All Day' : startDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const date = startDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const attendees = (evt.attendees || [])
          .map((a: any) => a.emailAddress?.name || a.emailAddress?.address)
          .filter(Boolean)
          .join(', ');
        const loc = evt.location?.displayName ? ` @ ${evt.location.displayName}` : '';
        graphEvents.push({
          key: eventKey(evt.subject || '', startDt.toISOString()),
          line: `${date} ${time} — ${evt.subject} [Calendar]${loc}${attendees ? ` [${attendees}]` : ''}`,
          ts: startDt.getTime(),
        });
      }
      if (graphEvents.length > 0) console.log(`[calendar] Graph API: ${graphEvents.length} events`);
    } catch (err: any) {
      console.log(`[calendar] Graph API failed: ${err.message?.slice(0, 100)} — continuing with SQLite only`);
    }
  }

  // Always pull SQLite to capture non-Outlook calendars (glossi.io, AJ Personal, etc.)
  const sqliteEvents = await fetchSqliteEvents(0, 3);
  if (sqliteEvents.length > 0) console.log(`[calendar] SQLite: ${sqliteEvents.length} events (covers all calendars)`);

  // Merge: Graph events take priority (richer data with attendees). SQLite events
  // only added if their key isn't already in Graph results.
  const seen = new Set<string>(graphEvents.map(e => e.key));
  const merged: { line: string; ts: number }[] = [...graphEvents];
  for (const e of sqliteEvents) {
    if (!seen.has(e.key)) {
      seen.add(e.key);
      merged.push({ line: e.line, ts: e.ts });
    }
  }

  if (merged.length > 0) {
    merged.sort((a, b) => a.ts - b.ts);
    const result = merged.map(e => e.line).join('\n');
    console.log(`[calendar] merged ${graphEvents.length} Graph + ${sqliteEvents.length - (sqliteEvents.length - (merged.length - graphEvents.length))} SQLite-only = ${merged.length} unique events`);
    await writeFile(M365_CACHE_PATH, result, 'utf-8').catch(() => {});
    await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
    return result;
  }

  // Both Graph and SQLite returned empty — fall through to caches/AppleScript
  console.log('[calendar] Graph + SQLite both empty — checking caches');

  const m365Fresh = await isFresh(M365_CACHE_PATH, 2);
  if (m365Fresh) {
    try {
      const m365 = await readFile(M365_CACHE_PATH, 'utf-8');
      if (m365.trim()) {
        console.log('[calendar] using fresh M365 cache (< 2h old)');
        return m365.trim();
      }
    } catch {}
  }

  // Last-resort: AppleScript before stale cache (live data is always preferred)
  const SCRIPT_PATH = join(__dirname, 'calendar.applescript');
  try {
    const { stdout } = await exec('osascript', [SCRIPT_PATH], { timeout: 60000 });
    const events = stdout.trim();
    if (events) {
      const lines = events.split('\n').filter(Boolean).sort();
      const result = lines.join('\n');
      await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
      console.log('[calendar] AppleScript fallback succeeded');
      return result;
    }
  } catch (err: any) {
    console.log(`[calendar] AppleScript fallback failed: ${err.message?.slice(0, 120)}`);
  }

  // Cache fallback — REJECT if older than 24h. Serving April data in May
  // is worse than serving "(unavailable)" because it gets quoted as current.
  try {
    if (await isFresh(CACHE_PATH, 24)) {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) {
        const s = await stat(CACHE_PATH);
        console.log('[calendar] using on-disk cache (< 24h old)');
        const stamp = `⚠️ Calendar below is cached as of ${formatAgeHours(s.mtimeMs)} ago — live read failed.`;
        return `${stamp}\n\n${cached.trim()}`;
      }
    } else {
      const s = await stat(CACHE_PATH);
      const ageDays = ((Date.now() - s.mtimeMs) / 86400000).toFixed(1);
      console.log(`[calendar] cache is ${ageDays}d old — REJECTING (would serve stale data)`);
    }
  } catch {}

  return '(calendar unavailable — Graph/SQLite/AppleScript all failed and on-disk cache is stale)';
}

export async function fetchYesterdayCalendar(): Promise<string> {
  // 1. Live Graph API for yesterday's events
  if (isGraphConfigured()) {
    try {
      const userEmail = getUserEmail();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const yesterdayEnd = new Date(yesterday);
      yesterdayEnd.setHours(23, 59, 59, 999);

      const events = await graphGet(`/me/calendarView`, {
        'startDateTime': yesterday.toISOString(),
        'endDateTime': yesterdayEnd.toISOString(),
        '$top': '30',
        '$select': 'subject,start,end,attendees,location',
        '$orderby': 'start/dateTime',
      });

      const lines: string[] = [];
      for (const evt of events.value || []) {
        const start = new Date(evt.start?.dateTime + 'Z');
        const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const attendees = (evt.attendees || []).map((a: any) => a.emailAddress?.name).filter(Boolean).join(', ');
        lines.push(`${time} — ${evt.subject}${attendees ? ` [${attendees}]` : ''}`);
      }

      if (lines.length > 0) {
        console.log(`[calendar] Graph API yesterday: ${events.value?.length} events`);
        return lines.join('\n');
      }
    } catch (err: any) {
      console.log(`[calendar] Graph API yesterday failed: ${err.message?.slice(0, 100)} — falling through`);
    }
  }

  // 2. Try SQLite direct query (copy DB first to dodge Calendar.app's WAL lock)
  {
    let cleanup: (() => Promise<void>) | null = null;
    try {
      const copied = await copyDbForReading(DB_PATH);
      cleanup = copied.cleanup;
      const query = buildQuery(-1, 0);
      const { stdout } = await exec('sqlite3', ['-separator', '|', copied.path, query], { timeout: 10000 });
      if (stdout.trim()) {
        const result = formatEvents(stdout);
        if (result) {
          await writeFile(YESTERDAY_CACHE_PATH, result, 'utf-8').catch(() => {});
          return result;
        }
      }
    } catch (err: any) {
      console.log(`[calendar] yesterday SQLite failed: ${err.message ?? err}`);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  // Cache fallback — only if fresh (< 36h, since this IS yesterday data)
  try {
    if (await isFresh(YESTERDAY_CACHE_PATH, 36)) {
      const cached = await readFile(YESTERDAY_CACHE_PATH, 'utf-8');
      if (cached.trim()) return cached.trim();
    }
  } catch {}

  return '(yesterday calendar unavailable)';
}
