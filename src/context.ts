import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

let _client: Anthropic;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const ARCHIVE_DIR = join(homedir(), 'briefing-data', 'archive');
const CONTEXT_DIR = join(homedir(), 'briefing-data', 'context');

/**
 * Save today's briefing to the archive.
 */
export async function archiveBriefing(briefing: string, date: string): Promise<void> {
  // Use local date, not UTC, to avoid writing to tomorrow's file after 5pm PT
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await writeFile(join(ARCHIVE_DIR, `${dateKey}.md`), `# ${date}\n\n${briefing}`, 'utf-8');
}

interface ContextEntry {
  date: string;
  actionItems: string[];
  inProgress: string[];
  awaitingResponse: string[];
  deadlines: string[];
}

/**
 * After sending a briefing, extract structured context and save for
 * future briefings. Extracts action items, in-progress deals/projects,
 * items awaiting response, and deadlines.
 */
export async function saveContext(briefing: string): Promise<void> {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Extract structured context from this briefing. Return ONLY valid JSON with these four arrays (no markdown, no code fences):

{
  "actionItems": ["things Jonathan needs to do or follow up on"],
  "inProgress": ["deals or projects currently active, with their status"],
  "awaitingResponse": ["items waiting on a specific person — include the person's name"],
  "deadlines": ["any dates or deadlines mentioned, with what they're for"]
}

Rules:
- Each item: max 20 words, include names/dates, no filler
- Max 6 items per category
- If a category has nothing, use an empty array
- Be specific: "Kyle owes deck feedback by Friday" not "awaiting feedback"

Briefing:
${briefing}`
    }]
  });

  const raw = (message.content[0] as { text: string }).text;

  let parsed: { actionItems?: string[]; inProgress?: string[]; awaitingResponse?: string[]; deadlines?: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: if Haiku didn't return valid JSON, save raw text in actionItems
    parsed = { actionItems: [raw.slice(0, 300)], inProgress: [], awaitingResponse: [], deadlines: [] };
  }

  const entry: ContextEntry = {
    date: dateKey,
    actionItems: parsed.actionItems ?? [],
    inProgress: parsed.inProgress ?? [],
    awaitingResponse: parsed.awaitingResponse ?? [],
    deadlines: parsed.deadlines ?? [],
  };

  await writeFile(join(CONTEXT_DIR, `${dateKey}.json`), JSON.stringify(entry, null, 2), 'utf-8');
}

/**
 * Format a context entry into readable text. For older entries (>3 days),
 * only include open/awaiting items to keep context focused.
 */
function formatEntry(data: ContextEntry, isOld: boolean): string {
  const sections: string[] = [];
  sections.push(`[${data.date}]`);

  // For old entries, only show items that are still likely open
  if (isOld) {
    if (data.awaitingResponse?.length > 0) {
      sections.push(`  Awaiting: ${data.awaitingResponse.join('; ')}`);
    }
    if (data.inProgress?.length > 0) {
      sections.push(`  In progress: ${data.inProgress.join('; ')}`);
    }
    if (data.deadlines?.length > 0) {
      sections.push(`  Deadlines: ${data.deadlines.join('; ')}`);
    }
  } else {
    if (data.actionItems?.length > 0) {
      sections.push(`  Action items: ${data.actionItems.join('; ')}`);
    }
    if (data.inProgress?.length > 0) {
      sections.push(`  In progress: ${data.inProgress.join('; ')}`);
    }
    if (data.awaitingResponse?.length > 0) {
      sections.push(`  Awaiting: ${data.awaitingResponse.join('; ')}`);
    }
    if (data.deadlines?.length > 0) {
      sections.push(`  Deadlines: ${data.deadlines.join('; ')}`);
    }
  }

  // If entry only had the date header, skip it
  return sections.length > 1 ? sections.join('\n') : '';
}

/**
 * Load rolling context from the last 7 days of briefings.
 * Recent entries (<=3 days) include all categories.
 * Older entries (>3 days) only include open/awaiting items.
 */
export async function loadRollingContext(): Promise<string> {
  try {
    const files = await readdir(CONTEXT_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, 7);

    if (jsonFiles.length === 0) return '';

    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const entries: string[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(CONTEXT_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as ContextEntry;

        // Handle legacy format (pre-structured entries with just "threads")
        if ((data as any).threads && !data.actionItems) {
          entries.push(`[${data.date}]\n${(data as any).threads}`);
          continue;
        }

        const entryDate = new Date(data.date + 'T00:00:00');
        const isOld = entryDate < threeDaysAgo;
        const formatted = formatEntry(data, isOld);
        if (formatted) entries.push(formatted);
      } catch {}
    }

    if (entries.length === 0) return '';

    // Cap at 2000 chars (~500 tokens) — richer context worth the cost
    const combined = entries.join('\n\n');
    return combined.length > 2000 ? combined.slice(0, 2000) + '...' : combined;
  } catch {
    return '';
  }
}
