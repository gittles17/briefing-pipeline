/**
 * maintenance.ts
 * Weekly maintenance agent for Jonathan's briefing rule system.
 *
 * Run manually:  npx tsx src/maintenance.ts
 * Run via cron:  launchd plist fires every Sunday at 8 PM
 *
 * What it does:
 *  1. Parses briefing-notes.md (all rules, including archived)
 *  2. Reads rule-usage.jsonl, aggregates counts per rule ID over last 30 days
 *  3. Updates each rule's last_applied and applied_count metadata in the file
 *  4. AUTO-ARCHIVES rules with 0 applications in last 30 days (moves to archive file)
 *  5. Detects merge candidates (Jaccard similarity > 0.8) — flags only, no auto-merge
 *  6. Writes maintenance-proposal.md with promotion candidates + merge suggestions
 *  7. Updates "## Stats" section in briefing-notes.md header
 *  8. Logs summary to stderr for cron visibility
 */

import { config } from 'dotenv';
config({ override: true });

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { processProposalReplies } from './sources/proposal-replies';
import { autoApplyExpired } from './sources/proposal';
import { atomicWrite, withFileLock } from './utils/atomic-fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTES_FILE = path.join(homedir(), 'briefing-data', 'briefing-notes.md');
const ARCHIVE_FILE = path.join(homedir(), 'briefing-data', 'briefing-notes-archive.md');
const LOG_FILE = path.join(homedir(), 'briefing-data', 'rule-usage.jsonl');
const PROPOSAL_FILE = path.join(homedir(), 'briefing-data', 'maintenance-proposal.md');

const MIN_RULES = 5;            // Don't prune if fewer than this many rules
const MIN_DAYS_DATA = 7;        // Don't prune if fewer than this many days of data
const LOOKBACK_DAYS = 30;       // Window for usage aggregation
const ARCHIVE_THRESHOLD = 0;    // Applications in 30d before archiving (0 = never fired)
const PROMOTE_THRESHOLD = 10;   // Applications in 30d before flagging for promotion
const MERGE_SIMILARITY = 0.8;   // Jaccard threshold for merge candidate detection
const PROPOSAL_TTL_DAYS = 14;   // Days until a pending proposal auto-expires

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuleBlock {
  id: string;
  created: string;
  last_applied: string | null;
  applied_count: number;
  status: 'active' | 'archived' | 'promoted';
  body: string;           // The markdown content after the frontmatter
  rawFrontmatter: string; // The original frontmatter lines (for rewriting)
}

interface UsageRecord {
  date: string;
  mode: 'morning' | 'afternoon';
  rules_applied: string[];
  rules_total: number;
}

interface AggregatedUsage {
  count: number;
  lastApplied: string | null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(`[maintenance] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Full-file rule parser (parses ALL rules including archived)
// ---------------------------------------------------------------------------

/**
 * Parses briefing-notes.md and returns all rule blocks (active + archived).
 * Unlike rule-usage.ts parseRules(), this does NOT skip archived rules.
 */
function parseAllRules(content: string): RuleBlock[] {
  const rules: RuleBlock[] = [];
  const lines = content.split('\n');
  let i = 0;
  let inCodeFence = false;

  while (i < lines.length) {
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      i++;
      continue;
    }
    if (inCodeFence) { i++; continue; }

    if (lines[i].trim() !== '---') { i++; continue; }

    i++;

    // Peek at the next non-empty line — must be a YAML key
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
    let id: string | null = null;
    let created = '';
    let last_applied: string | null = null;
    let applied_count = 0;
    let status: RuleBlock['status'] = 'active';

    for (const ml of metaLines) {
      const m = (key: string) => ml.match(new RegExp(`^${key}:\\s*(.+)$`));
      const idM = m('id');
      if (idM) id = idM[1].trim().replace(/^["']|["']$/g, '');
      const createdM = m('created');
      if (createdM) created = createdM[1].trim();
      const laM = m('last_applied');
      if (laM) {
        const v = laM[1].trim();
        last_applied = (v === 'null' || v === '~' || v === '') ? null : v;
      }
      const acM = m('applied_count');
      if (acM) applied_count = parseInt(acM[1].trim(), 10) || 0;
      const stM = m('status');
      if (stM) status = stM[1].trim() as RuleBlock['status'];
    }

    if (!id) {
      log(`skipping YAML block — no id field`);
      continue;
    }

    // Collect body until next rule block opener
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

    const body = bodyLines.join('\n').replace(/\n---\s*$/, '').trim();

    rules.push({
      id,
      created,
      last_applied,
      applied_count,
      status,
      body,
      rawFrontmatter: metaLines.join('\n'),
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Parse header block (everything before the first rule ---)
// ---------------------------------------------------------------------------

function extractHeader(content: string): string {
  // Find the first `---` that is followed by a YAML key
  const lines = content.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (lines[i].trim() === '---') {
      let peek = i + 1;
      while (peek < lines.length && lines[peek].trim() === '') peek++;
      if (peek < lines.length && /^\w[\w-]*:\s/.test(lines[peek])) {
        return lines.slice(0, i).join('\n');
      }
    }
  }
  return content; // no rules found
}

// ---------------------------------------------------------------------------
// Serialize a rule block back to markdown
// ---------------------------------------------------------------------------

function serializeRule(rule: RuleBlock): string {
  const la = rule.last_applied ?? 'null';
  return [
    '---',
    `id: ${rule.id}`,
    `created: ${rule.created}`,
    `last_applied: ${la}`,
    `applied_count: ${rule.applied_count}`,
    `status: ${rule.status}`,
    '---',
    rule.body,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Read and aggregate usage log
// ---------------------------------------------------------------------------

async function readUsageLog(): Promise<UsageRecord[]> {
  try {
    const raw = await readFile(LOG_FILE, 'utf-8');
    const records: UsageRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as UsageRecord);
      } catch {
        // skip malformed lines
      }
    }
    return records;
  } catch {
    return [];
  }
}

function aggregateUsage(records: UsageRecord[]): Map<string, AggregatedUsage> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const agg = new Map<string, AggregatedUsage>();

  for (const rec of records) {
    if (rec.date < cutoffStr) continue; // outside 30-day window
    for (const id of rec.rules_applied) {
      const existing = agg.get(id);
      if (!existing) {
        agg.set(id, { count: 1, lastApplied: rec.date });
      } else {
        existing.count++;
        if (rec.date > (existing.lastApplied ?? '')) existing.lastApplied = rec.date;
      }
    }
  }

  return agg;
}

function countUniqueDays(records: UsageRecord[]): number {
  const days = new Set(records.map(r => r.date));
  return days.size;
}

// ---------------------------------------------------------------------------
// Jaccard similarity for merge candidate detection
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2) // skip very short tokens
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const aArr = Array.from(a);
  const bArr = Array.from(b);
  const intersection = aArr.filter(t => b.has(t)).length;
  const unionSet = new Set(aArr.concat(bArr));
  const union = unionSet.size;
  return union === 0 ? 0 : intersection / union;
}

interface MergePair {
  idA: string;
  idB: string;
  similarity: number;
}

function detectMergeCandidates(rules: RuleBlock[]): MergePair[] {
  const active = rules.filter(r => r.status === 'active');
  const pairs: MergePair[] = [];

  for (let i = 0; i < active.length; i++) {
    const tokA = tokenize(active[i].body);
    for (let j = i + 1; j < active.length; j++) {
      const tokB = tokenize(active[j].body);
      const sim = jaccardSimilarity(tokA, tokB);
      if (sim >= MERGE_SIMILARITY) {
        pairs.push({ idA: active[i].id, idB: active[j].id, similarity: sim });
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Update stats line in a file header
// ---------------------------------------------------------------------------

function updateStatsLine(header: string, active: number, archived: number, total: number): string {
  const statsLine = `Current rules: ${total} | Active: ${active} | Archived: ${archived}`;
  // Replace existing stats line
  if (/^Current rules:.*$/m.test(header)) {
    return header.replace(/^Current rules:.*$/m, statsLine);
  }
  // Append before the last --- separator if stats section exists
  if (/^## Stats/m.test(header)) {
    return header.replace(/^(## Stats\s*\n)([\s\S]*?)(\n---|\n##|$)/m,
      `$1\n${statsLine}$3`
    );
  }
  return header;
}

function updateArchiveStatsLine(header: string, count: number): string {
  const statsLine = `Archived rules: ${count}`;
  if (/^Archived rules:.*$/m.test(header)) {
    return header.replace(/^Archived rules:.*$/m, statsLine);
  }
  return header;
}

// ---------------------------------------------------------------------------
// Proposal file helpers
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Proposal {
  id: string;
  type: 'promote' | 'merge' | 'other';
  rules: string[];
  rationale: string;
  proposed_change: string;
  created: string;
  expiration: string;
  status: 'pending';
}

interface AppliedProposal {
  date: string;
  id: string;
  outcome: 'approved' | 'auto-applied' | 'rejected';
  description: string;
}

interface ProposalFile {
  pending: Proposal[];
  recentlyApplied: AppliedProposal[];
}

async function readProposalFile(): Promise<ProposalFile> {
  const empty: ProposalFile = { pending: [], recentlyApplied: [] };
  if (!existsSync(PROPOSAL_FILE)) return empty;

  try {
    const content = await readFile(PROPOSAL_FILE, 'utf-8');

    // Parse pending proposals from markdown blocks
    const pending: Proposal[] = [];
    const pendingBlockRe = /### (proposal-[a-z0-9-]+)\n([\s\S]+?)(?=\n---\n|\n## |$)/g;
    let m: RegExpExecArray | null;

    while ((m = pendingBlockRe.exec(content)) !== null) {
      const id = m[1];
      const block = m[2];
      const field = (key: string) => {
        const fm = block.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
        return fm ? fm[1].trim() : '';
      };
      const status = field('Status');
      if (status !== 'pending') continue;

      pending.push({
        id,
        type: field('Type') as Proposal['type'],
        rules: field('Rule\\(s\\)').split(',').map(s => s.trim()).filter(Boolean),
        rationale: field('Rationale'),
        proposed_change: field('Proposed change'),
        created: field('Created') || new Date().toISOString().slice(0, 10),
        expiration: field('Expiration'),
        status: 'pending',
      });
    }

    // Parse recently applied items
    const recentlyApplied: AppliedProposal[] = [];
    const appliedRe = /^- (\d{4}-\d{2}-\d{2}): (proposal-[a-z0-9-]+) — (approved|auto-applied|rejected) — (.+)$/gm;
    while ((m = appliedRe.exec(content)) !== null) {
      recentlyApplied.push({
        date: m[1],
        id: m[2],
        outcome: m[3] as AppliedProposal['outcome'],
        description: m[4],
      });
    }

    return { pending, recentlyApplied };
  } catch {
    return empty;
  }
}

function renderProposalFile(proposals: ProposalFile, generatedDate: string): string {
  const pendingCount = proposals.pending.length;
  const lines: string[] = [];

  lines.push(`# Maintenance Proposals — generated ${generatedDate}`);
  lines.push('');
  lines.push(`## Pending (${pendingCount})`);
  lines.push('');

  if (pendingCount === 0) {
    lines.push('_No pending proposals._');
    lines.push('');
  } else {
    for (const p of proposals.pending) {
      lines.push(`### ${p.id}`);
      lines.push(`**Type:** ${p.type}`);
      lines.push(`**Rule(s):** ${p.rules.join(', ')}`);
      lines.push(`**Rationale:** ${p.rationale}`);
      lines.push(`**Proposed change:** ${p.proposed_change}`);
      lines.push(`**Created:** ${p.created}`);
      lines.push(`**Expiration:** ${p.expiration}`);
      lines.push(`**Status:** ${p.status}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push('## Recently applied (last 30 days)');
  lines.push('');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const recent = proposals.recentlyApplied.filter(a => a.date >= cutoffStr);
  if (recent.length === 0) {
    lines.push('_None yet._');
  } else {
    for (const a of recent) {
      lines.push(`- ${a.date}: ${a.id} — ${a.outcome} — ${a.description}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rebuild briefing-notes.md content
// ---------------------------------------------------------------------------

function rebuildNotesFile(header: string, rules: RuleBlock[]): string {
  const activeRules = rules.filter(r => r.status !== 'archived' && r.status !== 'promoted');
  const parts = [header.trimEnd()];
  parts.push('');
  parts.push('---');
  parts.push('');
  for (const rule of activeRules) {
    parts.push(serializeRule(rule));
    parts.push('');
    parts.push('---');
    parts.push('');
  }
  // Remove trailing extra blank line
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Rebuild archive file content
// ---------------------------------------------------------------------------

function rebuildArchiveFile(archiveHeader: string, archivedRules: RuleBlock[]): string {
  const parts = [archiveHeader.trimEnd()];
  parts.push('');
  for (const rule of archivedRules) {
    parts.push(serializeRule(rule));
    parts.push('');
    parts.push('---');
    parts.push('');
  }
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  log(`starting maintenance run — ${today}`);

  // 0a. Process any approval replies Jonathan sent this week (FIRST — before generating new proposals)
  log('processing proposal replies from Apple Mail...');
  await processProposalReplies().catch(err => log(`reply processing error: ${err.message}`));

  // 0b. Auto-expire any stale pending proposals before generating new ones
  log('checking for expired proposals...');
  await autoApplyExpired().catch(err => log(`auto-expire error: ${err.message}`));

  // 1. Read both files
  const notesContent = await readFile(NOTES_FILE, 'utf-8');
  const archiveContent = await readFile(ARCHIVE_FILE, 'utf-8');

  // 2. Parse all rules from notes file (active only — archive is separate)
  const allNotesRules = parseAllRules(notesContent);
  const activeRules = allNotesRules.filter(r => r.status === 'active');
  log(`parsed ${allNotesRules.length} rules from notes file (${activeRules.length} active)`);

  // Guard: insufficient rules
  if (activeRules.length < MIN_RULES) {
    log(`insufficient data: only ${activeRules.length} active rules (need ≥ ${MIN_RULES}). Exiting cleanly.`);
    process.exit(0);
  }

  // 3. Read usage log
  const usageRecords = await readUsageLog();
  const uniqueDays = countUniqueDays(usageRecords);
  log(`usage log: ${usageRecords.length} records across ${uniqueDays} unique days`);

  // Guard: insufficient days of data
  if (uniqueDays < MIN_DAYS_DATA) {
    log(`insufficient data: only ${uniqueDays} days of usage data (need ≥ ${MIN_DAYS_DATA}). Exiting cleanly.`);
    process.exit(0);
  }

  // 4. Aggregate usage over last 30 days
  const usage = aggregateUsage(usageRecords);

  // 5. Update metadata on each active rule
  for (const rule of activeRules) {
    const u = usage.get(rule.id);
    if (u) {
      rule.applied_count = u.count;
      rule.last_applied = u.lastApplied;
    } else {
      rule.applied_count = 0;
      // Don't overwrite last_applied if it exists (it may be from before the window)
    }
  }

  // 6. Detect rules to archive (0 applications in last 30 days)
  const toArchive = activeRules.filter(r => (usage.get(r.id)?.count ?? 0) <= ARCHIVE_THRESHOLD);
  const toKeep = activeRules.filter(r => (usage.get(r.id)?.count ?? 0) > ARCHIVE_THRESHOLD);

  log(`rules to archive: ${toArchive.length} (${toArchive.map(r => r.id).join(', ') || 'none'})`);

  // 7. Detect promotion candidates (≥ 10 applications in 30 days)
  const promotionCandidates = toKeep.filter(r => (usage.get(r.id)?.count ?? 0) >= PROMOTE_THRESHOLD);
  log(`promotion candidates: ${promotionCandidates.length}`);

  // 8. Detect merge candidates
  const mergePairs = detectMergeCandidates(activeRules);
  log(`merge candidate pairs: ${mergePairs.length}`);

  // 9. Perform archive operation — move rules to archive file
  let archiveFileRules: RuleBlock[] = [];
  if (toArchive.length > 0) {
    // Parse existing archived rules from archive file
    archiveFileRules = parseAllRules(archiveContent);

    for (const rule of toArchive) {
      rule.status = 'archived';
      archiveFileRules.push(rule);
      log(`archiving rule: ${rule.id} (applied ${rule.applied_count}x in last 30 days)`);
    }
  } else {
    archiveFileRules = parseAllRules(archiveContent);
  }

  // 10. Update notes file header stats
  const notesHeader = extractHeader(notesContent);
  const remainingActive = toKeep.length;
  const totalArchived = archiveFileRules.length;
  const totalRules = remainingActive + totalArchived;

  const updatedHeader = updateStatsLine(notesHeader, remainingActive, totalArchived, totalRules);

  // 11+12. Rebuild and write briefing-notes.md + archive atomically under a
  // shared lock — proposal.ts can also rewrite these files when applyProposal
  // fires concurrently, so we serialize on briefing-notes.md.
  const updatedNotesContent = rebuildNotesFile(updatedHeader, toKeep);
  const archiveHeader = extractHeader(archiveContent);
  const updatedArchiveHeader = updateArchiveStatsLine(archiveHeader, archiveFileRules.length);
  const updatedArchiveContent = rebuildArchiveFile(updatedArchiveHeader, archiveFileRules);

  await withFileLock(NOTES_FILE, async () => {
    await atomicWrite(NOTES_FILE, updatedNotesContent);
    await atomicWrite(ARCHIVE_FILE, updatedArchiveContent);
  });
  log(`wrote updated briefing-notes.md (${toKeep.length} active rules) + archive (${archiveFileRules.length} rules)`);

  // 13. Verify write by reading back
  const verifyNotes = await readFile(NOTES_FILE, 'utf-8');
  const verifiedRules = parseAllRules(verifyNotes);
  log(`verified: ${verifiedRules.length} rules in notes file after write`);

  // 14. Build proposals
  const existingProposals = await readProposalFile();
  const existingPendingIds = new Set(existingProposals.pending.map(p => p.rules.join(',')));

  const newProposals: Proposal[] = [];

  // Promotion proposals
  for (const rule of promotionCandidates) {
    const ruleKey = rule.id;
    if (!existingPendingIds.has(ruleKey)) {
      const id = generateId('proposal');
      newProposals.push({
        id,
        type: 'promote',
        rules: [rule.id],
        rationale: `Rule "${rule.id}" has been applied ${rule.applied_count} times in the last 30 days, indicating it should be hardcoded into the briefing prompt.`,
        proposed_change: `Hardcode this rule's logic directly into the Claude prompt in src/claude.ts or src/claude-missions.ts, then remove it from briefing-notes.md.`,
        created: today,
        expiration: addDays(today, PROPOSAL_TTL_DAYS),
        status: 'pending',
      });
    }
  }

  // Merge proposals
  for (const pair of mergePairs) {
    const ruleKey = [pair.idA, pair.idB].sort().join(',');
    if (!existingPendingIds.has(ruleKey)) {
      const id = generateId('proposal');
      newProposals.push({
        id,
        type: 'merge',
        rules: [pair.idA, pair.idB],
        rationale: `Rules "${pair.idA}" and "${pair.idB}" have ${Math.round(pair.similarity * 100)}% token overlap and likely cover the same concern.`,
        proposed_change: `Review both rules and consolidate into a single rule that covers both cases. Delete the redundant one.`,
        created: today,
        expiration: addDays(today, PROPOSAL_TTL_DAYS),
        status: 'pending',
      });
    }
  }

  // Merge new proposals with existing (existing first for priority)
  const allProposals: ProposalFile = {
    pending: [...existingProposals.pending, ...newProposals],
    recentlyApplied: existingProposals.recentlyApplied,
  };

  const proposalContent = renderProposalFile(allProposals, today);
  await withFileLock(PROPOSAL_FILE, () => atomicWrite(PROPOSAL_FILE, proposalContent));
  log(`wrote maintenance-proposal.md (${allProposals.pending.length} pending, ${newProposals.length} new)`);

  // 15. Final summary to stderr
  log('--- MAINTENANCE SUMMARY ---');
  log(`Active rules: ${remainingActive}`);
  log(`Archived this run: ${toArchive.length} (${toArchive.map(r => r.id).join(', ') || 'none'})`);
  log(`Total archived: ${totalArchived}`);
  log(`Promotion candidates: ${promotionCandidates.length}`);
  log(`Merge candidate pairs: ${mergePairs.length}`);
  log(`New proposals written: ${newProposals.length}`);
  log('--- DONE ---');
}

run().catch(err => {
  process.stderr.write(`[maintenance] FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
