/**
 * rule-usage.ts
 * Async tracker that runs AFTER each briefing is sent.
 * Determines which persistent rules from briefing-notes.md were observably
 * applied to today's briefing output, and appends a JSONL log record.
 *
 * JSONL schema (one record per briefing, appended to rule-usage.jsonl):
 * {
 *   "date": "2026-04-17",          // ISO date string (YYYY-MM-DD)
 *   "mode": "morning" | "afternoon",
 *   "rules_applied": ["rule-id-1", "rule-id-2"],  // IDs of rules observably applied
 *   "rules_total": 5               // Total rules parsed from briefing-notes.md
 * }
 *
 * Rules file format (briefing-notes.md) supports TWO formats:
 *   1. YAML frontmatter blocks (preferred, post-restructuring):
 *      ---
 *      id: some-rule-slug
 *      ---
 *      Rule body text here...
 *      (next --- or EOF ends the block)
 *
 *   2. Fallback — H2 markdown headings (original format):
 *      ## Rule Title
 *      Rule body text here...
 *      (next ## or EOF ends the block)
 *      ID is auto-generated as a slugified version of the heading.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, appendFile, writeFile, rename, unlink, mkdir, rmdir } from 'fs/promises';
import { homedir } from 'os';
import { spawn } from 'child_process';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Concurrency-safe append helper
// ---------------------------------------------------------------------------
//
// The rule-usage log is written by morning + afternoon runs and (potentially)
// the maintenance subprocess. Plain appendFile() is NOT atomic across
// concurrent writers — earlier writes saw the same EOF and produced
// duplicates (6+ entries observed for 2026-05-04 in the audit).
//
// Strategy: directory-based lock (mkdir is atomic on POSIX), short retry
// budget, then read-modify-write atomically (temp file + rename). Records
// are deduplicated on every write by exact JSON string match, so even if
// the lock briefly fails, duplicate appends self-heal on the next run.

async function acquireFileLock(lockDir: string, retries = 30, delayMs = 100): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await mkdir(lockDir);
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') return false;
      // Stale-lock cleanup: if the lock dir is older than 60s, force-remove
      try {
        const { stat } = await import('fs/promises');
        const s = await stat(lockDir);
        if (Date.now() - s.mtimeMs > 60_000) {
          await rmdir(lockDir).catch(() => {});
        }
      } catch {}
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function releaseFileLock(lockDir: string): Promise<void> {
  try { await rmdir(lockDir); } catch {}
}

/**
 * Atomic JSONL append with deduplication. Reads existing records, appends the
 * new one, dedupes by exact JSON string equality, writes back via temp+rename.
 * Concurrent callers serialize on a directory-based lock.
 */
async function atomicAppendJsonl(filePath: string, record: object): Promise<void> {
  const lockDir = filePath + '.lock';
  const acquired = await acquireFileLock(lockDir);
  try {
    let existing = '';
    try { existing = await readFile(filePath, 'utf-8'); } catch {}

    const recordStr = JSON.stringify(record);
    // Dedup: drop any line that exactly matches the new record (same date+mode+ids)
    const lines = existing.split('\n').filter(l => l.trim() && l.trim() !== recordStr);
    lines.push(recordStr);
    // Also dedup any other identical lines that may have accumulated
    const seen = new Set<string>();
    const deduped = lines.filter(l => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });

    const content = deduped.join('\n') + '\n';
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, content, 'utf-8');
    try {
      await rename(tmp, filePath);
    } catch (err) {
      try { await unlink(tmp); } catch {}
      throw err;
    }
  } finally {
    if (acquired) await releaseFileLock(lockDir);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RULE_USAGE_MODEL = 'claude-haiku-4-5'; // mechanical: which rules applied
const NOTES_FILE = `${homedir()}/briefing-data/briefing-notes.md`;
const LOG_FILE = `${homedir()}/briefing-data/rule-usage.jsonl`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRule {
  id: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton, same pattern as claude-missions.ts)
// ---------------------------------------------------------------------------

let _client: Anthropic;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// parseRules — dual-format parser (YAML frontmatter + H2 fallback)
// ---------------------------------------------------------------------------

/**
 * Converts a heading string to a URL-safe slug for use as a rule ID.
 * e.g. "CRITICAL — ALWAYS CHECK REMINDERS FIRST" → "critical-always-check-reminders-first"
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric (except spaces/hyphens)
    .trim()
    .replace(/\s+/g, '-')            // spaces → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .slice(0, 64);                   // cap length
}

/**
 * Attempt to parse rules using YAML-style frontmatter blocks.
 * Each block is delimited by `---` lines and must contain `id: <value>`.
 * Returns null if no valid YAML blocks are found (signals fallback needed).
 *
 * A "valid" YAML block is one where the FIRST non-empty line after `---`
 * looks like a YAML key (matches /^\w+:\s/). This filters out markdown
 * horizontal rules and code-block delimiters that also use `---`.
 */
function parseYamlFrontmatterRules(content: string): ParsedRule[] | null {
  const rules: ParsedRule[] = [];
  const lines = content.split('\n');
  let i = 0;
  let validBlocksFound = 0;
  let inCodeFence = false;

  while (i < lines.length) {
    // Track code fence state so we don't parse --- inside ``` blocks
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      i++;
      continue;
    }
    if (inCodeFence) {
      i++;
      continue;
    }

    // Look for a line that is exactly `---`
    if (lines[i].trim() !== '---') {
      i++;
      continue;
    }

    i++;

    // Peek at the next non-empty line to decide if this is a YAML block
    // (a YAML key looks like `word: `) vs a markdown HR or code fence
    let peekIdx = i;
    while (peekIdx < lines.length && lines[peekIdx].trim() === '') peekIdx++;

    if (peekIdx >= lines.length) break;
    const firstContentLine = lines[peekIdx];

    // Must look like a YAML key: starts with a word char, has a colon
    if (!/^\w[\w-]*:\s/.test(firstContentLine)) {
      // Not a YAML block (it's an HR, code fence end, etc.) — skip
      continue;
    }

    validBlocksFound++;

    // Collect YAML metadata until closing `---`
    const metaLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '---') {
      metaLines.push(lines[i]);
      i++;
    }
    i++; // skip closing ---

    // Parse `id:` and `status:` from metadata
    let id: string | null = null;
    let status = 'active';
    for (const metaLine of metaLines) {
      const idMatch = metaLine.match(/^id:\s*(.+)$/);
      if (idMatch) id = idMatch[1].trim().replace(/^["']|["']$/g, '');
      const statusMatch = metaLine.match(/^status:\s*(.+)$/);
      if (statusMatch) status = statusMatch[1].trim();
    }

    if (!id) {
      console.log('[rule-usage] skipping YAML block — no id field found');
      continue;
    }

    // Skip archived rules
    if (status === 'archived') {
      console.log(`[rule-usage] skipping archived rule: ${id}`);
      continue;
    }

    // Collect body until next `---` opening (or EOF)
    // The body is terminated by a standalone `---` followed by YAML content
    const bodyLines: string[] = [];
    while (i < lines.length) {
      // Check if this line is `---` and next non-empty line is a YAML key
      if (lines[i].trim() === '---') {
        let nextPeek = i + 1;
        while (nextPeek < lines.length && lines[nextPeek].trim() === '') nextPeek++;
        if (nextPeek < lines.length && /^\w[\w-]*:\s/.test(lines[nextPeek])) {
          // This is the start of the NEXT rule block — stop collecting body
          break;
        }
      }
      bodyLines.push(lines[i]);
      i++;
    }
    // Do NOT advance i — it now points at the opening `---` of the next block

    // Strip trailing blank lines and any trailing `---` (separator lines)
    const body = bodyLines
      .join('\n')
      .replace(/\n---\s*$/, '')  // strip trailing standalone HR
      .trim();

    if (!body) {
      console.log(`[rule-usage] skipping rule "${id}" — empty body`);
      continue;
    }

    rules.push({ id, body });
  }

  // Return null if no valid YAML blocks were found (pure markdown file)
  return validBlocksFound > 0 ? rules : null;
}

/**
 * Fallback parser: treats H2 headings (## Title) as rule boundaries.
 * Generates a slug ID from the heading text.
 */
function parseH2Rules(content: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  // Split on H2 headings, keeping the heading text
  const sections = content.split(/^## /m);

  for (const section of sections) {
    if (!section.trim()) continue;
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;

    const heading = section.slice(0, newlineIdx).trim();
    const body = section.slice(newlineIdx + 1).trim();

    if (!heading || !body) continue;

    const id = slugify(heading);
    if (!id) {
      console.log(`[rule-usage] skipping H2 section — could not generate slug for: "${heading}"`);
      continue;
    }

    rules.push({ id, body });
  }

  return rules;
}

/**
 * Reads briefing-notes.md and returns an array of parsed rules.
 * Tries YAML frontmatter format first, falls back to H2 headings.
 * Skips malformed rules gracefully.
 */
export async function parseRules(notesFilePath: string = NOTES_FILE): Promise<ParsedRule[]> {
  let content: string;
  try {
    content = await readFile(notesFilePath, 'utf-8');
  } catch (err: any) {
    console.log(`[rule-usage] briefing-notes.md not found at ${notesFilePath}: ${err.message}`);
    return [];
  }

  if (!content.trim()) {
    console.log('[rule-usage] briefing-notes.md is empty');
    return [];
  }

  // Try YAML frontmatter first
  const yamlRules = parseYamlFrontmatterRules(content);
  if (yamlRules !== null) {
    console.log(`[rule-usage] parsed ${yamlRules.length} rules via YAML frontmatter`);
    return yamlRules;
  }

  // Fallback to H2 heading parser
  const h2Rules = parseH2Rules(content);
  console.log(`[rule-usage] parsed ${h2Rules.length} rules via H2 heading fallback`);
  return h2Rules;
}

// ---------------------------------------------------------------------------
// trackRuleUsage — main exported function
// ---------------------------------------------------------------------------

/**
 * Determines which persistent rules were observably applied in the briefing,
 * then appends a JSONL record to rule-usage.jsonl.
 *
 * Safe to call fire-and-forget: wrap in .catch() at the call site.
 */
export async function trackRuleUsage(
  briefingText: string,
  mode: 'morning' | 'afternoon',
): Promise<void> {
  const rules = await parseRules();

  if (rules.length === 0) {
    console.log('[rule-usage] no rules parsed — skipping usage tracking');
    return;
  }

  // Build the prompt
  const rulesBlock = rules
    .map((r, idx) => `Rule ${idx + 1} — id: "${r.id}"\n${r.body}`)
    .join('\n\n---\n\n');

  const prompt = `You are auditing whether a set of persistent editorial rules were observably applied in a CEO's morning/afternoon briefing.

Here are ${rules.length} persistent rules:

${rulesBlock}

---

Here is today's briefing output:

${briefingText.slice(0, 8000)}

---

For each rule, decide YES or NO: is there clear evidence the briefing RESPECTS or REFLECTS this rule? A rule is "applied" if:
- The briefing avoids an error the rule prohibits, OR
- The briefing follows a format/behavior the rule requires, AND
- You can point to specific text in the briefing that demonstrates compliance.

Be conservative — only mark YES if you can clearly see compliance. If the rule's domain simply didn't come up today, mark NO (not applicable ≠ applied).

Respond with ONLY a JSON array of rule IDs that were observably applied. Example:
["reminders-authoritative", "sent-email-resolution-rules"]

No explanation. No other text. Just the JSON array.`;

  let appliedIds: string[] = [];

  try {
    const msg = await getClient().messages.create({
      model: RULE_USAGE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = (msg.content[0] as { text: string }).text.trim();

    // Extract JSON array from response (handle any leading/trailing text)
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`[rule-usage] unexpected response format: ${rawText.slice(0, 100)}`);
    } else {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        // Validate against known rule IDs to avoid hallucinated IDs
        const knownIds = new Set(rules.map(r => r.id));
        appliedIds = parsed.filter((id: unknown) => typeof id === 'string' && knownIds.has(id));
        const rejected = parsed.length - appliedIds.length;
        if (rejected > 0) {
          console.log(`[rule-usage] dropped ${rejected} unrecognized rule IDs from response`);
        }
      }
    }
  } catch (err: any) {
    console.log(`[rule-usage] API call failed: ${err.message}`);
    // Still write a partial record so we know it ran
  }

  // Build today's date in YYYY-MM-DD format
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const record = {
    date,
    mode,
    rules_applied: appliedIds,
    rules_total: rules.length,
  };

  try {
    // Atomic append + dedup — concurrent runs no longer produce duplicate entries
    await atomicAppendJsonl(LOG_FILE, record);
    console.log(`[rule-usage] logged — ${appliedIds.length}/${rules.length} rules applied (${mode})`);
  } catch (err: any) {
    console.log(`[rule-usage] failed to write log: ${err.message}`);
  }

  // Size ceiling check — spawn maintenance if needed (fire-and-forget)
  if (await checkSizeCeiling()) {
    console.log('[rule-usage] size ceiling tripped, launching maintenance');
    const maintenanceScript = path.join(__dirname, '..', 'maintenance.ts');
    const child = spawn(
      '/opt/homebrew/bin/npx',
      ['tsx', maintenanceScript],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
  }
}

// ---------------------------------------------------------------------------
// checkSizeCeiling — exported for use by other callers
// ---------------------------------------------------------------------------

/**
 * Returns true if active rules exceed 15 OR briefing-notes.md exceeds 1500 words.
 * When true, the caller should trigger a maintenance run.
 */
export async function checkSizeCeiling(notesFilePath: string = NOTES_FILE): Promise<boolean> {
  try {
    const content = await readFile(notesFilePath, 'utf-8');

    // Word count check
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    if (wordCount > 1500) {
      console.log(`[rule-usage] size ceiling: file has ${wordCount} words (> 1500)`);
      return true;
    }

    // Active rule count check — use existing parser, which skips archived rules
    const activeRules = await parseRules(notesFilePath);
    if (activeRules.length > 15) {
      console.log(`[rule-usage] size ceiling: ${activeRules.length} active rules (> 15)`);
      return true;
    }

    return false;
  } catch (err: any) {
    console.log(`[rule-usage] checkSizeCeiling error: ${err.message}`);
    return false;
  }
}
