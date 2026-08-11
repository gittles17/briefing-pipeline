/**
 * proposal.ts
 * Reads, writes, and applies maintenance proposals from maintenance-proposal.md.
 *
 * Data model (matches format written by maintenance.ts):
 *
 * ## Pending (N)
 *
 * ### proposal-<id>
 * **Type:** promote | merge
 * **Rule(s):** rule-id-1, rule-id-2
 * **Rationale:** ...
 * **Proposed change:** ...
 * **Created:** YYYY-MM-DD
 * **Expiration:** YYYY-MM-DD
 * **Status:** pending
 *
 * ---
 *
 * ## Recently applied (last 30 days)
 *
 * - YYYY-MM-DD: proposal-<id> — <outcome> — <description>
 *   [manual_action_required: true]   (optional, merge approvals only)
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { atomicWrite, withFileLock } from '../utils/atomic-fs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROPOSAL_FILE = join(homedir(), 'briefing-data', 'maintenance-proposal.md');
const NOTES_FILE    = join(homedir(), 'briefing-data', 'briefing-notes.md');
const ARCHIVE_FILE  = join(homedir(), 'briefing-data', 'briefing-notes-archive.md');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalType    = 'promote' | 'merge' | 'other';
export type ProposalStatus  = 'pending';
export type ProposalOutcome = 'approved' | 'rejected' | 'kept' | 'auto-applied' | 'auto-skipped';

export interface Proposal {
  id:             string;
  type:           ProposalType;
  ruleIds:        string[];
  rationale:      string;
  proposedChange: string;
  created:        string;
  expiration:     string;
  status:         ProposalStatus;
}

interface AppliedEntry {
  date:                  string;
  id:                    string;
  outcome:               ProposalOutcome;
  description:           string;
  manualActionRequired?: boolean;
}

interface ProposalFile {
  headerLine:     string; // "# Maintenance Proposals — generated <date>"
  pending:        Proposal[];
  recentlyApplied: AppliedEntry[];
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton, same pattern as rule-usage.ts)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 30_000,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[proposal] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// suggestPromotionLocation — auto-suggest where to hardcode a promoted rule
// ---------------------------------------------------------------------------

const SUGGEST_FALLBACK = 'src/claude-missions.ts (assembler rules — review manually)';

/**
 * Makes a single Sonnet call to suggest which pipeline file a rule should be
 * hardcoded into. Returns a short filepath string.
 *
 * Fail-safe: if the API call fails for any reason, returns SUGGEST_FALLBACK
 * so the archive always has a useful (non-'pending') value.
 */
export async function suggestPromotionLocation(ruleBody: string): Promise<string> {
  const prompt = `Given this persistent rule for a briefing pipeline, suggest a short file path (and optional line hint) where this rule should be hardcoded.

Files available:
- src/claude-missions.ts — main assembler and validator prompts (most rules go here)
- src/sources/feedback.ts — feedback constants
- src/sources/<specific-source>.ts — pre-processing for a specific data source

Rule:
${ruleBody}

Output a single-line suggestion like "src/claude-missions.ts near line 234 (assembler rules section)". No other text.`;

  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5', // 50-token location suggestion
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = ((msg.content[0] as { text: string }).text ?? '').trim();
    if (!raw) {
      log('suggestPromotionLocation: empty response — using fallback');
      return SUGGEST_FALLBACK;
    }
    // Sanity-check: must look like a filepath (contains a /)
    if (!raw.includes('/')) {
      log(`suggestPromotionLocation: unexpected response "${raw.slice(0, 80)}" — using fallback`);
      return SUGGEST_FALLBACK;
    }
    log(`suggestPromotionLocation: "${raw}"`);
    return raw;
  } catch (err: any) {
    log(`suggestPromotionLocation: API error — ${err.message} — using fallback`);
    return SUGGEST_FALLBACK;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the raw markdown file into structured data.
 * Returns all sections so we can re-serialise cleanly.
 */
function parseFile(content: string): ProposalFile {
  const lines = content.split('\n');

  // Extract header line
  const headerLine = lines[0] ?? '# Maintenance Proposals';

  // ---- Parse pending blocks ----
  const pending: Proposal[] = [];

  // Each pending block starts with "### proposal-<id>" and ends at the next "---" separator OR the "## Recently applied" heading
  const pendingBlockRe = /^### (proposal-[\w-]+)$/;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(pendingBlockRe);
    if (!m) { i++; continue; }

    const id = m[1];
    i++;

    // Collect fields until next `---` separator or `##` heading
    const fields: Record<string, string> = {};
    while (i < lines.length && lines[i].trim() !== '---' && !lines[i].startsWith('## ')) {
      const fMatch = lines[i].match(/^\*\*([^*]+):\*\*\s*(.+)$/);
      if (fMatch) fields[fMatch[1].trim()] = fMatch[2].trim();
      i++;
    }

    const status = fields['Status'] ?? '';
    if (status !== 'pending') continue; // skip non-pending

    pending.push({
      id,
      type:           (fields['Type'] ?? 'other') as ProposalType,
      ruleIds:        (fields['Rule(s)'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      rationale:      fields['Rationale'] ?? '',
      proposedChange: fields['Proposed change'] ?? '',
      created:        fields['Created'] ?? today(),
      expiration:     fields['Expiration'] ?? '',
      status:         'pending',
    });
  }

  // ---- Parse recently applied entries ----
  const recentlyApplied: AppliedEntry[] = [];

  // Line format:  "- YYYY-MM-DD: proposal-<id> — <outcome> — <description>"
  // Optional next line: "  [manual_action_required: true]"
  const appliedLineRe = /^- (\d{4}-\d{2}-\d{2}): (proposal-[\w-]+) — ([\w-]+) — (.+)$/;
  for (let j = 0; j < lines.length; j++) {
    const am = lines[j].match(appliedLineRe);
    if (!am) continue;
    const manualLine = lines[j + 1] ?? '';
    const manualActionRequired = manualLine.includes('manual_action_required: true');
    recentlyApplied.push({
      date:                  am[1],
      id:                    am[2],
      outcome:               am[3] as ProposalOutcome,
      description:           am[4].trim(),
      manualActionRequired,
    });
  }

  return { headerLine, pending, recentlyApplied };
}

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

function serialise(pf: ProposalFile): string {
  const lines: string[] = [];

  // Re-generate the header with today's date
  lines.push(`# Maintenance Proposals — generated ${today()}`);
  lines.push('');
  lines.push(`## Pending (${pf.pending.length})`);
  lines.push('');

  if (pf.pending.length === 0) {
    lines.push('_No pending proposals._');
    lines.push('');
  } else {
    for (const p of pf.pending) {
      lines.push(`### ${p.id}`);
      lines.push(`**Type:** ${p.type}`);
      lines.push(`**Rule(s):** ${p.ruleIds.join(', ')}`);
      lines.push(`**Rationale:** ${p.rationale}`);
      lines.push(`**Proposed change:** ${p.proposedChange}`);
      lines.push(`**Created:** ${p.created}`);
      lines.push(`**Expiration:** ${p.expiration}`);
      lines.push(`**Status:** pending`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push('## Recently applied (last 30 days)');
  lines.push('');

  // Only keep last 30 days in "Recently applied"
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = pf.recentlyApplied.filter(e => e.date >= cutoffStr);

  if (recent.length === 0) {
    lines.push('_None yet._');
  } else {
    for (const e of recent) {
      lines.push(`- ${e.date}: ${e.id} — ${e.outcome} — ${e.description}`);
      if (e.manualActionRequired) {
        lines.push('  [manual_action_required: true]');
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readProposalFile(): Promise<ProposalFile> {
  const empty: ProposalFile = {
    headerLine: `# Maintenance Proposals — generated ${today()}`,
    pending: [],
    recentlyApplied: [],
  };
  if (!existsSync(PROPOSAL_FILE)) return empty;
  try {
    const content = await readFile(PROPOSAL_FILE, 'utf-8');
    return parseFile(content);
  } catch {
    return empty;
  }
}

async function writeProposalFile(pf: ProposalFile): Promise<void> {
  // Atomic + locked: regression-check.ts and maintenance.ts can also write
  // this file, so we serialize to prevent partial-merge races.
  await withFileLock(PROPOSAL_FILE, () => atomicWrite(PROPOSAL_FILE, serialise(pf)));
}

// ---------------------------------------------------------------------------
// Rule file helpers (for applyProposal side-effects)
// ---------------------------------------------------------------------------

interface RuleBlock {
  id:             string;
  created:        string;
  last_applied:   string | null;
  applied_count:  number;
  status:         'active' | 'archived' | 'promoted';
  body:           string;
  promoted_on?:   string;
  promoted_to?:   string; // auto-suggested file location (set at promotion time)
}

function parseRuleBlocks(content: string): RuleBlock[] {
  const rules: RuleBlock[] = [];
  const lines = content.split('\n');
  let i = 0;
  let inCodeFence = false;

  while (i < lines.length) {
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      i++; continue;
    }
    if (inCodeFence) { i++; continue; }
    if (lines[i].trim() !== '---') { i++; continue; }
    i++;

    let peekIdx = i;
    while (peekIdx < lines.length && lines[peekIdx].trim() === '') peekIdx++;
    if (peekIdx >= lines.length) break;
    if (!/^\w[\w-]*:\s/.test(lines[peekIdx])) continue;

    const metaLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '---') {
      metaLines.push(lines[i]);
      i++;
    }
    i++; // skip closing ---

    let id: string | null = null;
    let created = '';
    let last_applied: string | null = null;
    let applied_count = 0;
    let status: RuleBlock['status'] = 'active';
    let promoted_on: string | undefined;
    let promoted_to: string | undefined;

    for (const ml of metaLines) {
      const m = (key: string) => ml.match(new RegExp(`^${key}:\\s*(.+)$`));
      const idM = m('id');        if (idM)  id = idM[1].trim().replace(/^["']|["']$/g, '');
      const crM = m('created');   if (crM)  created = crM[1].trim();
      const laM = m('last_applied'); if (laM) {
        const v = laM[1].trim();
        last_applied = (v === 'null' || v === '~' || v === '') ? null : v;
      }
      const acM = m('applied_count'); if (acM) applied_count = parseInt(acM[1].trim(), 10) || 0;
      const stM = m('status');    if (stM)  status = stM[1].trim() as RuleBlock['status'];
      const poM = m('promoted_on'); if (poM) promoted_on = poM[1].trim();
      const ptM = m('promoted_to'); if (ptM) promoted_to = ptM[1].trim();
    }

    if (!id) continue;

    const bodyLines: string[] = [];
    while (i < lines.length) {
      if (lines[i].trim() === '---') {
        let nextPeek = i + 1;
        while (nextPeek < lines.length && lines[nextPeek].trim() === '') nextPeek++;
        if (nextPeek < lines.length && /^\w[\w-]*:\s/.test(lines[nextPeek])) break;
      }
      bodyLines.push(lines[i]);
      i++;
    }

    rules.push({
      id, created, last_applied, applied_count, status, promoted_on, promoted_to,
      body: bodyLines.join('\n').replace(/\n---\s*$/, '').trim(),
    });
  }

  return rules;
}

function extractHeader(content: string): string {
  const lines = content.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) continue;
    if (lines[i].trim() === '---') {
      let peek = i + 1;
      while (peek < lines.length && lines[peek].trim() === '') peek++;
      if (peek < lines.length && /^\w[\w-]*:\s/.test(lines[peek])) return lines.slice(0, i).join('\n');
    }
  }
  return content;
}

function serializeRule(rule: RuleBlock): string {
  const parts = [
    '---',
    `id: ${rule.id}`,
    `created: ${rule.created}`,
    `last_applied: ${rule.last_applied ?? 'null'}`,
    `applied_count: ${rule.applied_count}`,
    `status: ${rule.status}`,
  ];
  if (rule.promoted_on) parts.push(`promoted_on: ${rule.promoted_on}`);
  if (rule.promoted_to) parts.push(`promoted_to: ${rule.promoted_to}`);
  parts.push('---', rule.body);
  return parts.join('\n');
}

function rebuildNotesFile(header: string, rules: RuleBlock[]): string {
  const activeRules = rules.filter(r => r.status !== 'archived' && r.status !== 'promoted');
  const parts = [header.trimEnd(), '', '---', ''];
  for (const rule of activeRules) {
    parts.push(serializeRule(rule));
    parts.push('', '---', '');
  }
  return parts.join('\n') + '\n';
}

function rebuildArchiveFile(header: string, rules: RuleBlock[]): string {
  const parts = [header.trimEnd(), ''];
  for (const rule of rules) {
    parts.push(serializeRule(rule));
    parts.push('', '---', '');
  }
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads maintenance-proposal.md and returns all pending proposals.
 */
export async function parseProposals(filePath?: string): Promise<Proposal[]> {
  const fp = filePath ?? PROPOSAL_FILE;
  if (!existsSync(fp)) return [];
  try {
    const content = await readFile(fp, 'utf-8');
    return parseFile(content).pending;
  } catch {
    return [];
  }
}

/**
 * Returns the oldest pending proposal (FIFO), or null if none.
 */
export async function getNextProposal(): Promise<Proposal | null> {
  try {
    const proposals = await parseProposals();
    if (proposals.length === 0) return null;
    // Sort by created date ascending (oldest first)
    const sorted = [...proposals].sort((a, b) => a.created.localeCompare(b.created));
    return sorted[0];
  } catch {
    return null;
  }
}

/**
 * Returns entries from "Recently applied" section dated within last N days,
 * filtered by outcome (e.g., 'auto-applied', 'auto-skipped').
 */
export async function getRecentlyApplied(
  outcomes: ProposalOutcome[],
  withinDays = 3,
): Promise<AppliedEntry[]> {
  try {
    const pf = await readProposalFile();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - withinDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return pf.recentlyApplied.filter(e =>
      e.date >= cutoffStr && outcomes.includes(e.outcome)
    );
  } catch {
    return [];
  }
}

/**
 * Updates the status of a proposal in maintenance-proposal.md.
 * Moves the proposal block to "Recently applied" with a timestamp.
 */
export async function markProposal(
  id: string,
  outcome: ProposalOutcome,
  description: string,
  opts?: { manualActionRequired?: boolean },
): Promise<void> {
  try {
    const pf = await readProposalFile();

    const idx = pf.pending.findIndex(p => p.id === id);
    if (idx === -1) {
      log(`markProposal: proposal ${id} not found in pending — skipping`);
      return;
    }

    const proposal = pf.pending[idx];
    pf.pending.splice(idx, 1);

    const entry: AppliedEntry = {
      date:                  today(),
      id,
      outcome,
      description,
      manualActionRequired:  opts?.manualActionRequired,
    };

    // Avoid duplicate entries
    const alreadyLogged = pf.recentlyApplied.some(e => e.id === id && e.outcome === outcome);
    if (!alreadyLogged) {
      pf.recentlyApplied.push(entry);
    }

    await writeProposalFile(pf);
    log(`markProposal: ${id} → ${outcome}`);
  } catch (err: any) {
    log(`markProposal error: ${err.message}`);
  }
}

/**
 * Executes the side effects of a proposal and calls markProposal() to archive it.
 */
export async function applyProposal(proposalId: string, outcome: ProposalOutcome): Promise<void> {
  try {
    const proposals = await parseProposals();
    const proposal = proposals.find(p => p.id === proposalId);

    if (!proposal) {
      log(`applyProposal: proposal ${proposalId} not found — already applied or doesn't exist`);
      return;
    }

    const ruleList = proposal.ruleIds.join(', ');

    if (outcome === 'approved' && proposal.type === 'promote') {
      // Mark the rule as promoted in briefing-notes.md, move to archive
      await promoteRule(proposal.ruleIds, proposalId);
      await markProposal(proposalId, 'approved',
        `Promote: ${ruleList} — marked promoted, moved to archive. Suggested location auto-set.`);
    }
    else if (outcome === 'approved' && proposal.type === 'merge') {
      // Cannot auto-merge — flag for manual action
      await markProposal(proposalId, 'approved',
        `Merge: ${ruleList} — MANUAL ACTION REQUIRED. Review and consolidate rules by hand.`,
        { manualActionRequired: true });
      log(`[proposal] Merge proposal ${proposalId} approved — manual_action_required. Rules: ${ruleList}`);
    }
    else if (outcome === 'rejected') {
      await markProposal(proposalId, 'rejected',
        `Rejected by Jonathan — rule(s) unchanged: ${ruleList}`);
    }
    else if (outcome === 'kept') {
      await markProposal(proposalId, 'kept',
        `Kept in notes — rule doing its job: ${ruleList}`);
    }
    else if (outcome === 'auto-applied') {
      if (proposal.type === 'promote') {
        // Advisory promotion — just mark it, no code changes required
        await markProposal(proposalId, 'auto-applied',
          `Expired — promote advisory for: ${ruleList}. Hardcode manually if still relevant.`);
        log(`[proposal] Auto-applied expired promote proposal ${proposalId}. Rule(s): ${ruleList} — please hardcode in src/claude-missions.ts if still relevant.`);
      } else {
        // merge / other — safe to skip entirely
        await markProposal(proposalId, 'auto-skipped',
          `Expired — merge skipped (requires manual review): ${ruleList}`);
        log(`[proposal] Auto-skipped expired merge proposal ${proposalId}. Review manually: ${ruleList}`);
      }
    }
    else if (outcome === 'auto-skipped') {
      await markProposal(proposalId, 'auto-skipped',
        `Expired — skipped (requires manual review): ${ruleList}`);
    }
  } catch (err: any) {
    log(`applyProposal error: ${err.message}`);
  }
}

/**
 * Finds all pending proposals whose expiration date has passed and processes them.
 */
export async function autoApplyExpired(): Promise<void> {
  try {
    const proposals = await parseProposals();
    const t = today();

    const expired = proposals.filter(p => p.expiration < t);
    if (expired.length === 0) {
      log('autoApplyExpired: no expired proposals');
      return;
    }

    log(`autoApplyExpired: processing ${expired.length} expired proposals`);
    for (const p of expired) {
      if (p.type === 'promote') {
        // Advisory: mark auto-applied (no actual code change — just surfaces to Jonathan)
        await applyProposal(p.id, 'auto-applied');
      } else {
        // merge / other: too risky to auto-apply
        await applyProposal(p.id, 'auto-skipped');
      }
    }
  } catch (err: any) {
    log(`autoApplyExpired error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Undo: restore a proposal from "Recently applied" back to pending
// ---------------------------------------------------------------------------

export async function undoProposal(id: string): Promise<void> {
  try {
    const pf = await readProposalFile();
    const idx = pf.recentlyApplied.findIndex(e => e.id === id);
    if (idx === -1) {
      log(`undoProposal: ${id} not found in recently applied`);
      return;
    }

    const entry = pf.recentlyApplied[idx];
    pf.recentlyApplied.splice(idx, 1);

    // We reconstruct a minimal pending proposal (original metadata is lost, but we
    // log the type from the description keywords as a hint)
    const typeHint: ProposalType = entry.description.toLowerCase().includes('merge') ? 'merge' : 'promote';
    pf.pending.unshift({
      id,
      type:           typeHint,
      ruleIds:        [], // original rule IDs not preserved — user must review
      rationale:      `Restored by undo on ${today()}. Original: ${entry.description}`,
      proposedChange: 'Restored — review and decide manually.',
      created:        entry.date,
      expiration:     addDays(today(), 14),
      status:         'pending',
    });

    await writeProposalFile(pf);
    log(`undoProposal: restored ${id} to pending`);
  } catch (err: any) {
    log(`undoProposal error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Internal: promote a rule
// ---------------------------------------------------------------------------

async function promoteRule(ruleIds: string[], proposalId: string): Promise<void> {
  const notesContent = await readFile(NOTES_FILE, 'utf-8');
  const archiveContent = await readFile(ARCHIVE_FILE, 'utf-8');

  const notesRules    = parseRuleBlocks(notesContent);
  const archiveRules  = parseRuleBlocks(archiveContent);
  const notesHeader   = extractHeader(notesContent);
  const archiveHeader = extractHeader(archiveContent);

  let changed = false;

  for (const ruleId of ruleIds) {
    const idx = notesRules.findIndex(r => r.id === ruleId);
    if (idx === -1) {
      log(`promoteRule: rule ${ruleId} not found in notes file — skipping`);
      continue;
    }

    const rule = notesRules[idx];
    rule.status      = 'promoted';
    rule.promoted_on = today();
    // Auto-suggest where to hardcode this rule — never leaves as 'pending'
    rule.promoted_to = await suggestPromotionLocation(rule.body);
    notesRules.splice(idx, 1); // remove from notes

    archiveRules.push(rule); // move to archive
    changed = true;

    log(`[proposal] Rule ${ruleId} promoted — suggested location: ${rule.promoted_to}`);
  }

  if (changed) {
    // Atomic + locked: maintenance.ts can also rewrite these files; serialize
    // on NOTES_FILE so we never observe a half-applied promote.
    await withFileLock(NOTES_FILE, async () => {
      await atomicWrite(NOTES_FILE, rebuildNotesFile(notesHeader, notesRules));
      await atomicWrite(ARCHIVE_FILE, rebuildArchiveFile(archiveHeader, archiveRules));
    });
  }
}

// ---------------------------------------------------------------------------
// Public API: registerPromotion
// ---------------------------------------------------------------------------

/**
 * Optionally overrides the auto-suggested `promoted_to` location for a rule
 * in the archive. This is a power-user function — you do NOT need to call it
 * as part of normal rule promotion. The system auto-suggests a location via
 * suggestPromotionLocation() at the moment of promotion.
 *
 * Use this only if you want to update the archive record after manually
 * hardcoding a rule at a precise file:line, e.g.:
 *
 *   registerPromotion('some-rule', 'src/claude-missions.ts:234')
 */
export async function registerPromotion(ruleId: string, fileLocation: string): Promise<void> {
  try {
    const content = await readFile(ARCHIVE_FILE, 'utf-8');

    // We need to update the promoted_to field for the matching rule.
    // Strategy: find the `id: <ruleId>` line inside a YAML block and
    // then update or insert `promoted_to:` on the line after it.
    const lines = content.split('\n');
    let found = false;
    let inBlock = false;
    let hasPtField = false;

    // First pass: does the block already have promoted_to?
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        // Check if next non-empty line is a YAML key
        let peek = i + 1;
        while (peek < lines.length && lines[peek].trim() === '') peek++;
        if (peek < lines.length && /^\w[\w-]*:\s/.test(lines[peek])) {
          inBlock = true;
          hasPtField = false;
        }
      }
      if (inBlock && lines[i].match(new RegExp(`^id:\\s*["']?${ruleId}["']?\\s*$`))) {
        found = true;
      }
      if (inBlock && found && lines[i].match(/^promoted_to:\s*/)) {
        hasPtField = true;
      }
      // End of block
      if (inBlock && found && lines[i].trim() === '---' && i > 0) {
        break;
      }
    }

    if (!found) {
      log(`registerPromotion: rule "${ruleId}" not found in archive`);
      return;
    }

    let updated: string;

    if (hasPtField) {
      // Replace existing promoted_to line for this rule's block
      // We need to be careful to only replace the one in the right block.
      let inTargetBlock = false;
      let doneReplacing = false;
      updated = lines.map(line => {
        if (line.match(new RegExp(`^id:\\s*["']?${ruleId}["']?\\s*$`))) {
          inTargetBlock = true;
        }
        if (inTargetBlock && !doneReplacing && line.match(/^promoted_to:\s*/)) {
          doneReplacing = true;
          return `promoted_to: ${fileLocation}`;
        }
        return line;
      }).join('\n');
    } else {
      // Insert promoted_to after promoted_on (or after id if no promoted_on)
      let inTargetBlock = false;
      let inserted = false;
      updated = lines.map(line => {
        if (line.match(new RegExp(`^id:\\s*["']?${ruleId}["']?\\s*$`))) {
          inTargetBlock = true;
        }
        if (inTargetBlock && !inserted && line.match(/^promoted_on:\s*/)) {
          inserted = true;
          return line + '\n' + `promoted_to: ${fileLocation}`;
        }
        return line;
      }).join('\n');

      if (!inserted) {
        // Fallback: insert after the id: line
        let inBlock2 = false;
        let inserted2 = false;
        updated = lines.map(line => {
          if (line.match(new RegExp(`^id:\\s*["']?${ruleId}["']?\\s*$`))) {
            inBlock2 = true;
          }
          if (inBlock2 && !inserted2 && line.match(new RegExp(`^id:\\s*["']?${ruleId}["']?\\s*$`))) {
            inserted2 = true;
            return line + '\n' + `promoted_to: ${fileLocation}`;
          }
          return line;
        }).join('\n');
      }
    }

    await withFileLock(NOTES_FILE, () => atomicWrite(ARCHIVE_FILE, updated));
    log(`registerPromotion: rule "${ruleId}" → promoted_to: ${fileLocation}`);
  } catch (err: any) {
    log(`registerPromotion error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
