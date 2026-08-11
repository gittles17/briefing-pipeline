import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { runOsascript } from '../utils/retry-osascript';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const FEEDBACK_PATH = join(homedir(), 'briefing-data', 'feedback.json');
const NOTES_PATH = join(homedir(), 'briefing-data', 'briefing-notes.md');

/**
 * Is Apple Mail actually running? If not, we must NOT `tell application "Mail"`
 * — that would LAUNCH Mail under launchd and can hang for minutes. Cheap 5s probe
 * via System Events; on any error assume not running and skip the scan.
 */
async function isMailRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      ['-e', 'tell application "System Events" to (name of processes) contains "Mail"'],
      { timeout: 5000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

interface FeedbackEntry {
  date: string;
  type: 'positive' | 'negative';
  item: string;
  body: string;
}

/**
 * Scans Gmail sent/inbox for +/− feedback replies from Jonathan,
 * and returns accumulated feedback for the prompt.
 */
export async function fetchFeedback(): Promise<string> {
  // Load existing feedback
  let existing: FeedbackEntry[] = [];
  try {
    const raw = await readFile(FEEDBACK_PATH, 'utf-8');
    existing = JSON.parse(raw);
  } catch {}

  // Scan Apple Mail for new feedback emails (last 7 days)
  const smtpUser = process.env.SMTP_USER || '';
  const script = `
tell application "Mail"
  set cutoff to (current date) - 7 * days
  set output to ""

  repeat with acct in every account
    repeat with mb in every mailbox of acct
      try
        set mbName to name of mb
        if mbName is "Sent Messages" or mbName is "Sent" or mbName is "Sent Items" or mbName is "Inbox" or mbName is "INBOX" then
          set msgs to (every message of mb whose date received is greater than cutoff and subject contains "+" and subject does not contain "Briefing Test")
          repeat with msg in msgs
            try
              set subj to subject of msg
              set recips to address of to recipient 1 of msg
              if recips is "${smtpUser}" or (subj starts with "+" or subj starts with "−" or subj starts with "-") then
                set bod to content of msg
                set d to date received of msg
                set dateStr to (year of d as text) & "-" & text -2 thru -1 of ("0" & ((month of d as integer) as text)) & "-" & text -2 thru -1 of ("0" & (day of d as text))
                set output to output & dateStr & "|||" & subj & "|||" & (text 1 thru 200 of (bod & "")) & linefeed
              end if
            end try
          end repeat
        end if
      end try
    end repeat
  end repeat

  return output
end tell`;

  try {
    if (!(await isMailRunning())) {
      console.log('[feedback] Mail not running — skipping scan, using cached feedback');
      throw new Error('mail-not-running');  // caught below → falls through to cached notes
    }
    const scriptPath = join(homedir(), 'briefing-data', 'feedback.applescript');
    await writeFile(scriptPath, script, 'utf-8');
    const stdout = await runOsascript(scriptPath);

    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [date, subject, body] = line.split('|||');
      if (!subject) continue;

      const isPositive = subject.startsWith('+');
      const item = subject.replace(/^[+−\-]\s*/, '').trim();

      // Deduplicate
      if (existing.some(e => e.date === date && e.item === item)) continue;

      existing.push({
        date: date || new Date().toISOString().split('T')[0],
        type: isPositive ? 'positive' : 'negative',
        item,
        body: (body || '').trim(),
      });
    }

    // Keep last 90 days of feedback
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    existing = existing.filter(e => e.date >= cutoffStr);

    await writeFile(FEEDBACK_PATH, JSON.stringify(existing, null, 2), 'utf-8');
  } catch {}

  // Load persistent structural notes (always prepended — these are Jonathan's hard rules)
  let persistentNotes = '';
  try {
    persistentNotes = (await readFile(NOTES_PATH, 'utf-8')).trim();
  } catch {}

  if (existing.length === 0 && !persistentNotes) return '';

  // Format for the prompt
  const positive = existing.filter(e => e.type === 'positive');
  const negative = existing.filter(e => e.type === 'negative');

  const lines: string[] = [];
  if (persistentNotes) {
    lines.push('PERSISTENT RULES & CORRECTIONS (follow these every time):');
    lines.push(persistentNotes);
    lines.push('');
  }
  if (positive.length > 0) {
    lines.push('LIKED:');
    for (const f of positive.slice(-15)) {
      lines.push(`+ ${f.item}`);
    }
  }
  if (negative.length > 0) {
    lines.push('DISLIKED:');
    for (const f of negative.slice(-15)) {
      lines.push(`− ${f.item}${f.body ? ' — ' + f.body.slice(0, 100) : ''}`);
    }
  }

  const patternInsights = analyzeFeedbackPatterns(existing);
  if (patternInsights) {
    lines.push('');
    lines.push('PATTERNS:');
    lines.push(patternInsights);
  }

  return lines.join('\n');
}

// Analyze patterns from feedback
function analyzeFeedbackPatterns(entries: FeedbackEntry[]): string {
  const patterns = {
    likedTopics: new Set<string>(),
    dislikedTopics: new Set<string>(),
    likedSources: new Set<string>(),
    dislikedSources: new Set<string>(),
  };

  // Keywords that indicate topic/source
  const topicKeywords = ['industry', 'intel', 'tldr', 'luminate', 'forecast', 'glossi', 'create', 'personal', 'thread', 'calendar', 'reminder'];

  for (const entry of entries) {
    const lower = entry.item.toLowerCase();
    const set = entry.type === 'positive' ? patterns.likedTopics : patterns.dislikedTopics;

    for (const keyword of topicKeywords) {
      if (lower.includes(keyword)) {
        set.add(keyword);
      }
    }

    // Detect source-level patterns
    if (lower.includes('[create]') || lower.includes('create')) {
      (entry.type === 'positive' ? patterns.likedSources : patterns.dislikedSources).add('Create items');
    }
    if (lower.includes('[glossi]') || lower.includes('glossi')) {
      (entry.type === 'positive' ? patterns.likedSources : patterns.dislikedSources).add('Glossi items');
    }
    if (lower.includes('[personal]') || lower.includes('personal')) {
      (entry.type === 'positive' ? patterns.likedSources : patterns.dislikedSources).add('Personal items');
    }
  }

  const insights: string[] = [];
  if (patterns.likedTopics.size > 0) {
    insights.push(`Topics Jonathan likes: ${[...patterns.likedTopics].join(', ')}`);
  }
  if (patterns.dislikedTopics.size > 0) {
    insights.push(`Topics Jonathan dislikes or wants less of: ${[...patterns.dislikedTopics].join(', ')}`);
  }

  return insights.join('\n');
}
