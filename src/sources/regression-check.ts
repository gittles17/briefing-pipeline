/**
 * regression-check.ts
 *
 * Detects regressions in the assembled briefing against PROMOTED rules —
 * rules that have been hardcoded into the pipeline because they proved reliable.
 *
 * A regression means: the briefing violates a rule that was already promoted
 * and should be baked in. This is a signal that either the hardcoded rule
 * was lost, changed, or the assembler slipped.
 *
 * Flow:
 *   loadPromotedRules()                → reads briefing-notes-archive.md
 *   checkBriefingForRegressions(text)  → Sonnet call, logs, creates proposals
 *
 * Called from claude-missions.ts after the validator finishes. Non-blocking.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWrite, withFileLock } from '../utils/atomic-fs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ARCHIVE_FILE   = join(homedir(), 'briefing-data', 'briefing-notes-archive.md');
const REGRESSION_LOG = join(homedir(), 'briefing-data', 'regression-log.jsonl');
const PROPOSAL_FILE  = join(homedir(), 'briefing-data', 'maintenance-proposal.md');

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const REGRESSION_MODEL = 'claude-haiku-4-5'; // mechanical: rule-violation detection

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotedRule {
  id:          string;
  body:        string;
  promoted_on: string;
  promoted_to: string; // auto-suggested file location (set at promotion time)
}

export interface Regression {
  rule_id:         string;
  violation_quote: string;
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton)
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
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[regression] ${msg}\n`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, compatible with rule-usage.ts conventions)
// Parses blocks delimited by `---` with YAML key: value lines.
// Returns only rules with status: promoted.
// ---------------------------------------------------------------------------

function parsePromotedBlocks(content: string): PromotedRule[] {
  const rules: PromotedRule[] = [];
  const lines = content.split('\n');
  let i = 0;
  let inCodeFence = false;

  while (i < lines.length) {
    // Track code fences so we don't parse --- inside ``` blocks
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      i++;
      continue;
    }
    if (inCodeFence) { i++; continue; }

    // Find opening ---
    if (lines[i].trim() !== '---') { i++; continue; }
    i++;

    // Peek — must look like a YAML key (word: ) to be a frontmatter block
    let peekIdx = i;
    while (peekIdx < lines.length && lines[peekIdx].trim() === '') peekIdx++;
    if (peekIdx >= lines.length) break;
    if (!/^\w[\w-]*:\s/.test(lines[peekIdx])) continue;

    // Collect YAML metadata until closing ---
    const metaLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '---') {
      metaLines.push(lines[i]);
      i++;
    }
    i++; // skip closing ---

    // Parse fields
    let id:          string | null = null;
    let status       = 'active';
    let promoted_on  = '';
    let promoted_to  = '';

    for (const ml of metaLines) {
      const match = (key: string) => ml.match(new RegExp(`^${key}:\\s*(.+)$`));
      const idM  = match('id');          if (idM)  id = idM[1].trim().replace(/^["']|["']$/g, '');
      const stM  = match('status');      if (stM)  status = stM[1].trim();
      const poM  = match('promoted_on'); if (poM)  promoted_on = poM[1].trim();
      const ptM  = match('promoted_to'); if (ptM)  promoted_to = ptM[1].trim();
    }

    if (!id || status !== 'promoted') {
      // Skip non-promoted blocks — still consume body to keep parser in sync
      while (i < lines.length) {
        if (lines[i].trim() === '---') {
          let np = i + 1;
          while (np < lines.length && lines[np].trim() === '') np++;
          if (np < lines.length && /^\w[\w-]*:\s/.test(lines[np])) break;
        }
        i++;
      }
      continue;
    }

    // Collect body until next YAML block or EOF
    const bodyLines: string[] = [];
    while (i < lines.length) {
      if (lines[i].trim() === '---') {
        let np = i + 1;
        while (np < lines.length && lines[np].trim() === '') np++;
        if (np < lines.length && /^\w[\w-]*:\s/.test(lines[np])) break;
      }
      bodyLines.push(lines[i]);
      i++;
    }

    const body = bodyLines.join('\n').replace(/\n---\s*$/, '').trim();
    if (!body) continue;

    rules.push({ id, body, promoted_on, promoted_to });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// loadPromotedRules — public
// ---------------------------------------------------------------------------

/**
 * Reads briefing-notes-archive.md and returns all rules with status: promoted.
 * Returns empty array if the file doesn't exist or has no promoted rules.
 */
export async function loadPromotedRules(): Promise<PromotedRule[]> {
  if (!existsSync(ARCHIVE_FILE)) {
    log('archive file not found — no promoted rules');
    return [];
  }
  try {
    const content = await readFile(ARCHIVE_FILE, 'utf-8');
    const rules = parsePromotedBlocks(content);
    log(`loadPromotedRules: found ${rules.length} promoted rule(s)`);
    return rules;
  } catch (err: any) {
    log(`loadPromotedRules error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// appendRegressionProposal — creates a special "regression" entry in proposals
// ---------------------------------------------------------------------------

async function appendRegressionProposal(regressions: Regression[]): Promise<void> {
  try {
    // Read-modify-write under lock — proposal.ts and maintenance.ts also write
    // this file. Without the lock, concurrent updates clobber each other.
    await withFileLock(PROPOSAL_FILE, async () => {
      const propExists = existsSync(PROPOSAL_FILE);
      let content = propExists ? await readFile(PROPOSAL_FILE, 'utf-8') : '';

      const ruleList = regressions.map(r => r.rule_id).join(', ');
      const summary  = regressions
        .map(r => `  - ${r.rule_id}: "${r.violation_quote.slice(0, 80)}${r.violation_quote.length > 80 ? '...' : ''}"`)
        .join('\n');

      const proposalId = `proposal-regression-${today()}`;
      const block = `
### ${proposalId}
**Type:** regression
**Rule(s):** ${ruleList}
**Rationale:** The briefing violated ${regressions.length} promoted rule(s) that should be hardcoded in the pipeline. This suggests a rule was lost or the assembler slipped.
**Proposed change:** Investigate each regression and re-apply the rule hardcoding if needed.
**Evidence:**
${summary}
**Created:** ${today()}
**Expiration:** ${addDays(today(), 14)}
**Status:** pending

---
`;

      if (content.includes('## Pending')) {
        const insertBefore = '## Recently applied';
        const idx = content.indexOf(insertBefore);
        if (idx !== -1) {
          content = content.slice(0, idx) + block + '\n' + content.slice(idx);
        } else {
          content += block;
        }
      } else {
        content += `\n# Maintenance Proposals — generated ${today()}\n\n## Pending (1)\n${block}\n## Recently applied (last 30 days)\n\n_None yet._\n`;
      }

      await atomicWrite(PROPOSAL_FILE, content);
      log(`appendRegressionProposal: wrote regression proposal ${proposalId}`);
    });
  } catch (err: any) {
    log(`appendRegressionProposal error: ${err.message}`);
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// checkBriefingForRegressions — main export
// ---------------------------------------------------------------------------

/**
 * Checks a completed briefing against all promoted rules.
 * Non-blocking: callers should wrap in .catch() or a try/catch.
 *
 * Returns array of detected regressions (empty if none or on error).
 * Side effects:
 *   - Logs regressions to regression-log.jsonl
 *   - Creates a maintenance proposal entry for each regression batch
 */
export async function checkBriefingForRegressions(
  briefingText: string,
  mode: 'morning' | 'afternoon' = 'morning',
): Promise<Regression[]> {
  try {
    const promotedRules = await loadPromotedRules();

    if (promotedRules.length === 0) {
      log('no promoted rules — skipping regression check');
      return [];
    }

    const rulesBlock = promotedRules
      .map((r, idx) => `Rule ${idx + 1} — id: "${r.id}" (promoted ${r.promoted_on})\n${r.body}`)
      .join('\n\n---\n\n');

    const prompt = `You are a regression detector for an automated CEO briefing pipeline.

The following ${promotedRules.length} rule(s) have been PROMOTED — meaning they were reliable enough to be hardcoded directly into the briefing generation system. They should ALWAYS be respected in the output.

PROMOTED RULES:
${rulesBlock}

---

BRIEFING TO CHECK:
${briefingText.slice(0, 10000)}

---

For each promoted rule, check if the briefing VIOLATES the rule. A violation means the briefing does the thing the rule explicitly prohibits, or fails to do what the rule requires.

If NO violations: return an empty JSON array: []

If violations found: return a JSON array of objects with this shape:
[
  {"rule_id": "<the rule id>", "violation_quote": "<verbatim quote from the briefing that violates the rule, max 120 chars>"},
  ...
]

IMPORTANT:
- Only report clear, unambiguous violations. If unsure, do not report.
- If the rule's domain simply did not come up in the briefing, that is NOT a violation.
- Return ONLY the JSON array. No explanation, no other text.`;

    log(`checking ${promotedRules.length} promoted rule(s) against briefing...`);

    const msg = await getClient().messages.create({
      model: REGRESSION_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = ((msg.content[0] as { text: string }).text).trim();

    // Extract JSON array
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log(`unexpected response format: ${rawText.slice(0, 100)}`);
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      log('response was not a JSON array');
      return [];
    }

    // Validate shape
    const knownIds = new Set(promotedRules.map(r => r.id));
    const regressions: Regression[] = parsed
      .filter((item: any) =>
        item &&
        typeof item.rule_id === 'string' &&
        typeof item.violation_quote === 'string' &&
        knownIds.has(item.rule_id)
      )
      .map((item: any) => ({
        rule_id: item.rule_id as string,
        violation_quote: (item.violation_quote as string).slice(0, 120),
      }));

    if (regressions.length === 0) {
      log('no regressions detected');
      return [];
    }

    log(`detected ${regressions.length} regression(s)`);

    // Log to regression-log.jsonl
    const record = {
      date: today(),
      mode,
      regressions,
    };
    try {
      await appendFile(REGRESSION_LOG, JSON.stringify(record) + '\n', 'utf-8');
      log(`logged ${regressions.length} regression(s) to regression-log.jsonl`);
    } catch (err: any) {
      log(`failed to write regression log: ${err.message}`);
    }

    // Create a maintenance proposal flagging the regressions
    await appendRegressionProposal(regressions);

    return regressions;

  } catch (err: any) {
    log(`checkBriefingForRegressions error: ${err.message}`);
    return [];
  }
}
