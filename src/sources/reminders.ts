import { writeFile, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { runOsascript } from '../utils/retry-osascript';

const CACHE_PATH = join(homedir(), 'briefing-data', 'reminders.txt');
const SCRIPT_PATH = join(homedir(), 'briefing-data', 'reminders.applescript');

// Simpler script that's faster — avoids iterating all lists
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

/** Check if a file was modified within the last N hours */
async function isCacheFresh(maxAgeHours: number): Promise<boolean> {
  try {
    const s = await stat(CACHE_PATH);
    const ageMs = Date.now() - s.mtimeMs;
    return ageMs < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}

export async function fetchReminders(): Promise<string> {
  // Try live pull from Reminders app
  try {
    // Write inline script to file so runOsascript can execute it
    await writeFile(SCRIPT_PATH, APPLESCRIPT, 'utf-8');
    const stdout = await runOsascript(SCRIPT_PATH);
    const result = stdout.trim();
    if (result) {
      // Cache for fallback
      await writeFile(CACHE_PATH, result, 'utf-8').catch(() => {});
      return result;
    }
  } catch {}

  // Fall back to cache file (only if < 48h old)
  try {
    if (await isCacheFresh(48)) {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) return cached.trim();
    }
  } catch {}

  return '(reminders not available)';
}
