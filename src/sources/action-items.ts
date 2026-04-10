import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const ACTIONS_PATH = join(homedir(), 'briefing-data', 'action-items.json');

interface ActionItem {
  id: string;
  text: string;
  firstSeen: string;      // date first detected
  lastSeen: string;       // date last seen in data
  status: 'open' | 'done' | 'stale';
  source: string;         // email, reminder, calendar, etc.
  daysOpen: number;
}

/**
 * Load current action items and their history.
 */
export async function loadActionItems(): Promise<string> {
  try {
    const raw = await readFile(ACTIONS_PATH, 'utf-8');
    const items: ActionItem[] = JSON.parse(raw);

    const open = items.filter(i => i.status === 'open');
    const recentlyDone = items.filter(i => {
      if (i.status !== 'done') return false;
      const doneDate = new Date(i.lastSeen);
      const daysSinceDone = Math.floor((Date.now() - doneDate.getTime()) / 86400000);
      return daysSinceDone <= 2;
    });

    const lines: string[] = [];

    if (open.length > 0) {
      lines.push('OPEN ACTION ITEMS (tracked across days):');
      for (const item of open) {
        const aging = item.daysOpen > 1 ? ` [${item.daysOpen} days]` : '';
        lines.push(`- ${item.text}${aging} (source: ${item.source})`);
      }
    }

    if (recentlyDone.length > 0) {
      lines.push('');
      lines.push('RECENTLY COMPLETED:');
      for (const item of recentlyDone) {
        lines.push(`- ✓ ${item.text} (completed ${item.lastSeen})`);
      }
    }

    return lines.join('\n') || '';
  } catch {
    return '';
  }
}

/**
 * After generating a briefing, extract and update action items.
 * Called with the raw data sources to detect completions.
 */
export async function updateActionItems(
  briefing: string,
  sentEmails: string,
  reminders: string
): Promise<void> {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let existing: ActionItem[] = [];
  try {
    const raw = await readFile(ACTIONS_PATH, 'utf-8');
    existing = JSON.parse(raw);
  } catch {}

  // Extract action items from briefing (look for "action needed" and "urgent" tags)
  // Exclude calendar events (time-based entries like "10:30 AM —") — those aren't action items
  const actionPatterns = [
    /\*\*(.+?)\*\*.*?\*\*(?:action needed|urgent)\*\*/gi,
    /- \*\*(.+?)\*\*.*?(?:action needed|urgent)/gi,
  ];

  const timePattern = /^\d{1,2}:\d{2}\s*(?:AM|PM)?\s*[—–-]/i;

  const newItems: string[] = [];
  for (const pattern of actionPatterns) {
    let match;
    while ((match = pattern.exec(briefing)) !== null) {
      const text = match[1].trim();
      // Skip calendar entries — they're events, not action items
      if (timePattern.test(text)) continue;
      newItems.push(text);
    }
  }

  // Intelligent completion detection across all data sources
  const allSignals = [sentEmails, reminders, briefing].join('\n').toLowerCase();

  // Load Teams and calendar data for additional signals
  let teamsData = '';
  let calendarData = '';
  try { teamsData = (await readFile(join(homedir(), 'briefing-data', 'm365-teams.txt'), 'utf-8')).toLowerCase(); } catch {}
  try { teamsData += '\n' + (await readFile(join(homedir(), 'briefing-data', 'teams-messages.txt'), 'utf-8')).toLowerCase(); } catch {}
  try { calendarData = (await readFile(join(homedir(), 'briefing-data', 'm365-calendar.txt'), 'utf-8')).toLowerCase(); } catch {}
  try { calendarData += '\n' + (await readFile(join(homedir(), 'briefing-data', 'calendar.txt'), 'utf-8')).toLowerCase(); } catch {}

  const combined = allSignals + '\n' + teamsData + '\n' + calendarData;

  for (const item of existing) {
    if (item.status !== 'open') continue;
    if (detectCompletion(item, combined, today)) {
      item.status = 'done';
      item.lastSeen = today;
    }
  }

  // Add new items
  for (const text of newItems) {
    const id = text.toLowerCase().replace(/\s+/g, '-').slice(0, 50);
    if (!existing.some(e => e.id === id || e.text.toLowerCase() === text.toLowerCase())) {
      existing.push({
        id,
        text,
        firstSeen: today,
        lastSeen: today,
        status: 'open',
        source: 'briefing',
        daysOpen: 0,
      });
    }
  }

  // Update days open for existing items
  for (const item of existing) {
    if (item.status === 'open') {
      item.lastSeen = today;
      const first = new Date(item.firstSeen);
      item.daysOpen = Math.floor((now.getTime() - first.getTime()) / 86400000);
    }
  }

  // Prune: remove stale items (done > 7 days ago, or open > 30 days)
  existing = existing.filter(item => {
    if (item.status === 'done') {
      const days = Math.floor((now.getTime() - new Date(item.lastSeen).getTime()) / 86400000);
      return days <= 7;
    }
    if (item.status === 'open' && item.daysOpen > 30) {
      return false;
    }
    return true;
  });

  await writeFile(ACTIONS_PATH, JSON.stringify(existing, null, 2), 'utf-8');
}

/**
 * Intelligently detect whether an action item was completed by analyzing
 * sent emails, Teams chats, calendar events, and briefing content.
 */
function detectCompletion(item: ActionItem, allData: string, today: string): boolean {
  const text = item.text.toLowerCase();

  // Extract meaningful keywords (>3 chars, not common words)
  const stopWords = new Set(['with', 'from', 'that', 'this', 'have', 'been', 'will', 'your', 'about', 'review', 'send', 'need', 'list', 'item']);
  const keywords = text.split(/[\s—–\-\/,.:]+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 3 && !stopWords.has(w));

  // --- Pattern 1: Sent email evidence ---
  // If Jonathan sent an email that matches key entities in the action item
  const sentPattern = /\[(?:create|glossi)\s*\/?\s*sent\]|from: jonathan gitlin/gi;
  const sentBlocks = allData.split('\n').filter(l => sentPattern.test(l));
  const sentText = sentBlocks.join(' ');

  // Name-based matching: extract proper nouns from action item
  const namePatterns = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  const names = item.text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];

  // Check if sent mail references the key people/topics
  for (const name of names) {
    const nameLower = name.toLowerCase();
    if (nameLower.length > 3 && sentText.includes(nameLower)) {
      // Found a sent email mentioning the same person — likely completed
      const entityKeywords = keywords.filter(k => k.length > 4);
      const matchCount = entityKeywords.filter(k => sentText.includes(k)).length;
      if (matchCount >= 1) return true;
    }
  }

  // --- Pattern 2: Auris newsletter detection ---
  // Jonathan sends Auris Markets newsletters via auris-ai.io and receives a copy
  // (from weeklyroundup@auris-ai.io) because he's on the list. If that email
  // appears in the inbox data, the newsletter was sent.
  if (text.includes('newsletter') || text.includes('auris')) {
    if (allData.includes('auris-ai.io') || allData.includes('weeklyroundup@auris') || allData.includes('weekly round up')) {
      return true;
    }
    // Fallback: if it's past the send day, auto-expire
    if (item.daysOpen >= 1) return true;
  }

  // --- Pattern 3: Calendar event passed ---
  // If the action is about a meeting/event that already happened
  if (text.includes('prep') || text.includes('lunch') || text.includes('meeting')) {
    // Check if the event date has passed
    const dateStr = today;
    if (item.firstSeen < dateStr && item.daysOpen >= 1) {
      // Prep tasks expire after the day they were created
      return true;
    }
  }

  // --- Pattern 4: Strong keyword overlap with sent/teams data ---
  // If 3+ significant keywords from the action appear in sent mail or teams
  const significantKeywords = keywords.filter(k => k.length > 5);
  if (significantKeywords.length >= 2) {
    const matchCount = significantKeywords.filter(k => sentText.includes(k) || allData.includes(k)).length;
    if (matchCount >= Math.min(3, significantKeywords.length)) return true;
  }

  // --- Pattern 5: "already sent" / "done" / "completed" signals in data ---
  for (const kw of keywords) {
    if (kw.length < 5) continue;
    // Look for completion language near the keyword
    const idx = allData.indexOf(kw);
    if (idx > -1) {
      const nearby = allData.slice(Math.max(0, idx - 100), idx + 100);
      if (/already sent|done|completed|approved|signed|confirmed|reviewed/i.test(nearby)) {
        return true;
      }
    }
  }

  return false;
}
