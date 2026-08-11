/**
 * Reminders source — SQLite-direct read of the macOS Reminders DB.
 *
 * Why SQLite? The legacy AppleScript path frequently hung (60s timeout,
 * `osascript` serializes on macOS, Reminders.app needs to be running). SQLite
 * reads the same data without invoking Reminders.app and runs in <100ms.
 *
 * DB location: ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-*.sqlite
 *   - There may be multiple .sqlite files (one per account / iCloud zone).
 *   - We pick the LARGEST mtime-recent one as the active store.
 *   - Cocoa epoch (Jan 1 2001) for date columns: add 978307200 to convert.
 *
 * Resilience: live SQLite read first, AppleScript fallback if that fails,
 * 24h on-disk cache as last resort. Logs make every fallback path visible.
 */

import { writeFile, readFile, stat, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runOsascript } from '../utils/retry-osascript';

const exec = promisify(execFile);

const CACHE_PATH = join(homedir(), 'briefing-data', 'reminders.txt');
const SCRIPT_PATH = join(homedir(), 'briefing-data', 'reminders.applescript');
const STORE_DIR = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.reminders',
  'Container_v1',
  'Stores',
);

// Staged copies written by stage-protected.sh (sourced by the launchd bash
// wrapper right before the pipeline). Under launchd, node cannot read the
// protected Stores dir directly — a stale per-binary TCC deny on node
// overrides the /bin/bash FDA grant — so bash stages copies and we read those.
const STAGED_STORE_DIR = join(homedir(), 'briefing-data', 'staging', 'reminders-stores');
const STAGING_MAX_AGE_MS = 30 * 60 * 1000;

/** Largest .sqlite in a dir; when maxAgeMs is set, only files modified within it. */
async function pickLargestSqlite(dir: string, maxAgeMs: number | null): Promise<string | null> {
  try {
    const files = await readdir(dir);
    const candidates = files.filter(f => f.endsWith('.sqlite'));
    if (candidates.length === 0) return null;
    let best: { path: string; size: number } | null = null;
    for (const f of candidates) {
      const p = join(dir, f);
      try {
        const s = await stat(p);
        if (maxAgeMs !== null && Date.now() - s.mtimeMs > maxAgeMs) continue;
        if (!best || s.size > best.size) best = { path: p, size: s.size };
      } catch {}
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/** Pick the largest active reminders store (typically the iCloud one). */
async function findActiveDb(): Promise<string | null> {
  // Fresh staged copy first (scheduled runs), then the protected original
  // (interactive contexts have their own FDA and read it directly).
  const staged = await pickLargestSqlite(STAGED_STORE_DIR, STAGING_MAX_AGE_MS);
  if (staged) {
    console.log('[reminders] using staged store copy');
    return staged;
  }
  return pickLargestSqlite(STORE_DIR, null);
}

/** Run the SQL query against the Reminders DB. Returns formatted text or null. */
async function fetchViaSqlite(): Promise<string | null> {
  const dbPath = await findActiveDb();
  if (!dbPath) {
    console.log('[reminders] no SQLite store found');
    return null;
  }

  // Cocoa epoch offset = 978307200 seconds.
  // Filter: not completed, not deleted. Order by due date (nulls last).
  const sql = `
SELECT
  COALESCE(l.ZNAME, '(no list)') AS list_name,
  r.ZTITLE AS title,
  COALESCE(r.ZNOTES, '') AS notes,
  CASE WHEN r.ZDUEDATE IS NULL THEN ''
       ELSE strftime('%Y-%m-%d %H:%M', r.ZDUEDATE + 978307200, 'unixepoch', 'localtime')
  END AS due,
  CASE WHEN r.ZFLAGGED = 1 THEN 1 ELSE 0 END AS flagged
FROM ZREMCDREMINDER r
LEFT JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
WHERE r.ZCOMPLETED = 0
  AND COALESCE(r.ZMARKEDFORDELETION, 0) = 0
  AND r.ZTITLE IS NOT NULL
  AND TRIM(r.ZTITLE) != ''
ORDER BY
  CASE WHEN r.ZDUEDATE IS NULL THEN 1 ELSE 0 END,
  r.ZDUEDATE,
  r.ZCREATIONDATE DESC
LIMIT 200;
`.trim();

  try {
    // Use a non-default separator so titles/notes containing pipes don't break parsing
    const SEP = ''; // SOH — won't appear in user content
    const { stdout } = await exec('sqlite3', ['-separator', SEP, dbPath, sql], { timeout: 10_000 });
    if (!stdout.trim()) {
      console.log('[reminders] SQLite returned no open reminders');
      return '(no open reminders)';
    }

    // Group by list, format like the old AppleScript output so prompts don't have to change.
    const byList = new Map<string, string[]>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(SEP);
      if (parts.length < 5) continue;
      const [listName, title, notes, due, flaggedStr] = parts;
      const flagged = flaggedStr.trim() === '1';
      let entry = `- ${flagged ? '🚩 ' : ''}${title.trim()}`;
      if (due.trim()) entry += ` [due: ${due.trim()}]`;
      const noteTrim = notes.trim();
      if (noteTrim) {
        // Single-line indent any embedded newlines in notes
        entry += '\n  ' + noteTrim.replace(/\r?\n/g, ' ').slice(0, 280);
      }
      const list = byList.get(listName) || [];
      list.push(entry);
      byList.set(listName, list);
    }

    const sections: string[] = [];
    for (const [listName, items] of byList) {
      sections.push(`=== ${listName} ===\n${items.join('\n')}`);
    }
    return sections.join('\n\n');
  } catch (err: any) {
    console.log(`[reminders] SQLite read failed: ${err.message?.slice(0, 120)}`);
    return null;
  }
}

/** Check if a file was modified within the last N hours */
async function isCacheFresh(maxAgeHours: number): Promise<boolean> {
  try {
    const s = await stat(CACHE_PATH);
    return Date.now() - s.mtimeMs < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}

/** Format an age from an mtime (ms) into a short human string, e.g. "2d 3h" or "5h". */
function formatAge(mtimeMs: number): string {
  const totalHours = Math.floor((Date.now() - mtimeMs) / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

// AppleScript fallback (same as old impl) — kept for last-resort reliability
const APPLESCRIPT = `
tell application "Reminders"
  set allLists to every list
  set output to ""
  repeat with aList in allLists
    set listName to name of aList
    set rems to every reminder of aList whose completed is false
    if (count of rems) > 0 then
      set output to output & "=== " & listName & " ===" & linefeed
      repeat with r in rems
        set rName to name of r
        set rBody to ""
        try
          set rBody to body of r
        end try
        set rDue to ""
        try
          set rDue to due date of r as string
        end try
        set output to output & "- " & rName
        if rDue is not "" and rDue is not missing value then
          set output to output & " [due: " & rDue & "]"
        end if
        if rBody is not "" and rBody is not missing value then
          set output to output & linefeed & "  " & rBody
        end if
        set output to output & linefeed
      end repeat
      set output to output & linefeed
    end if
  end repeat
end tell
return output
`;

export async function fetchReminders(): Promise<string> {
  // 1. SQLite — fast, no app dependency
  const fromDb = await fetchViaSqlite();
  if (fromDb && fromDb !== '(no open reminders)') {
    await writeFile(CACHE_PATH, fromDb, 'utf-8').catch(() => {});
    console.log('[reminders] SQLite live read succeeded');
    return fromDb;
  }
  if (fromDb === '(no open reminders)') {
    return fromDb;
  }

  // 2. AppleScript — fallback if SQLite path is blocked (TCC permission, etc.)
  try {
    await writeFile(SCRIPT_PATH, APPLESCRIPT, 'utf-8');
    const stdout = await runOsascript(SCRIPT_PATH, 30_000);
    const result = stdout.trim();
    if (result) {
      await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
      console.log('[reminders] AppleScript fallback succeeded');
      return result;
    }
  } catch (err: any) {
    console.log(`[reminders] AppleScript fallback failed: ${err.message?.slice(0, 80)}`);
  }

  // 3. On-disk cache — last resort, < 14 days (336h). Reminders rarely change
  //    mid-week; when live access is lost (e.g. launchd lacks Full Disk Access)
  //    we'd rather degrade slowly and visibly with an age-stamped snapshot than
  //    have the source vanish silently. The age stamp makes staleness obvious.
  try {
    if (await isCacheFresh(336)) {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) {
        const s = await stat(CACHE_PATH);
        const ageDays = ((Date.now() - s.mtimeMs) / 86400000).toFixed(1);
        console.log(`[reminders] using on-disk cache (${ageDays}d old)`);
        const stamp = `⚠️ Reminders below are cached as of ${formatAge(s.mtimeMs)} ago — live read failed.`;
        return `${stamp}\n\n${cached.trim()}`;
      }
    } else {
      const s = await stat(CACHE_PATH);
      const ageDays = ((Date.now() - s.mtimeMs) / 86400000).toFixed(1);
      console.log(`[reminders] cache is ${ageDays}d old — REJECTING (> 14d)`);
    }
  } catch {}

  return '(reminders unavailable — SQLite/AppleScript both failed and cache is stale)';
}
