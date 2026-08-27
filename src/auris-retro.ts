/**
 * auris-retro.ts
 * Weekly "harness retro" for the CREATE-LA/AurisFilmSeries repo.
 *
 * Run manually:  npx tsx src/auris-retro.ts [--dry-run]
 * Run via cron:  launchd plist fires every Monday at 07:30.
 *
 * What it does each week:
 *  1. SELECT   — parent Cursor transcripts modified in the last 7 days, minus
 *                sessions already recorded in the state file.
 *  2. PREFILTER— mechanically (no LLM) mine those transcripts for the human's
 *                correction / frustration moments (see sources/cursor-transcripts).
 *  3. JUDGE    — one Sonnet call weighs the candidates against the repo's current
 *                .cursor/rules/ inventory and proposes 0-3 new/expanded rules,
 *                held to a HIGH bar. Zero proposals is a valid, common outcome.
 *  4. WATCH    — report-only staleness checks (spot-builder retro, mission skill).
 *  5. DELIVER  — if >=1 proposal, open a PR on the Auris repo (branch + append/new
 *                rule file + PR body) purely through the authenticated gh CLI.
 *                Never touches main; never checks the repo out locally.
 *  6. RECORD   — append processed session ids + a run record to the state file
 *                and log a human-readable summary.
 *
 * --dry-run runs the full pipeline (including the real LLM call) but prints the
 * proposals / PR body to stdout instead of creating a branch or PR, and does not
 * write state.
 */

import { config } from 'dotenv';
config({ override: true });

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { readFile, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  selectRecentSessions,
  prefilterCandidates,
  Candidate,
} from './sources/cursor-transcripts';
import { atomicWrite } from './utils/atomic-fs';
import { withTimeout } from './utils/with-timeout';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = 'CREATE-LA/AurisFilmSeries';
const RULES_DIR = '.cursor/rules';
const MODEL = 'claude-sonnet-5';
const DAYS_BACK = 7;
const MAX_PROPOSALS = 3;

const STATE_FILE = join(homedir(), 'briefing-data', 'auris-retro-state.json');

// Staleness-watch targets.
const SPOT_LEARNINGS = join(homedir(), '.claude', 'skills', 'auris-spot-builder', 'LEARNINGS.md');
const SPOT_RENDERS = join(homedir(), 'Desktop', 'Auris', 'auris-demo', 'renders');
const MISSION_SKILL = join(homedir(), '.claude', 'skills', 'mission', 'SKILL.md');
const SPOT_STALE_DAYS = 14;
const MISSION_STALE_DAYS = 60;

// Sonnet 5 (per-million-token) rates for the run cost estimate — approximate.
const RATE_INPUT_PER_M = 3;
const RATE_OUTPUT_PER_M = 15;

const CALL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Evidence {
  sessionId: string;
  date: string;
  quote: string;
}

export interface Proposal {
  targetFile: string;
  title: string;
  ruleMarkdown: string;
  evidence: Evidence[];
  rationale: string;
}

interface RunRecord {
  date: string;
  sessionsScanned: number;
  candidatesFound: number;
  proposalsMade: number;
  prUrl: string;
}

interface RetroState {
  processedSessions: string[];
  runs: RunRecord[];
}

interface RuleFile {
  name: string;
  firstLines: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[auris-retro] ${msg}`);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Anthropic client (mirrors claude-missions.ts)
// ---------------------------------------------------------------------------

let _client: Anthropic;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 120_000,
      maxRetries: 1,
    });
  }
  return _client;
}

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn(), CALL_TIMEOUT_MS, label);
    } catch (err: any) {
      const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');
      const isOverloaded = err.status === 529 || err.status === 503;
      if ((isTimeout || isOverloaded) && attempt < retries) {
        const delay = attempt * 15_000;
        log(`${label} attempt ${attempt} failed (${err.message}) — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${retries} attempts`);
}

function extractText(msg: Anthropic.Message): string {
  const block = msg.content.find(b => (b as { type: string }).type === 'text') as { text?: string } | undefined;
  return block?.text ?? '';
}

// ---------------------------------------------------------------------------
// gh CLI helpers (pure REST via the authenticated gh CLI — no local checkout)
// ---------------------------------------------------------------------------

/**
 * Minimal environment for the gh child. gh authenticates via the macOS keyring
 * and needs only PATH (to be found on disk) and HOME (to locate ~/.config/gh).
 * We pass an explicit allow-list rather than the full process env so none of the
 * pipeline's .env secrets (ANTHROPIC_API_KEY, DATABASE_URL, …) leak into the
 * child. Token / config-dir overrides are forwarded only when actually set.
 */
function ghEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** True when a gh api error is a genuine 404 (resource absent), not transient. */
function isNotFoundError(err: any): boolean {
  return typeof err?.message === 'string'
    && err.message.includes('exited 1')
    && /404|Not Found/i.test(err.message);
}

function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: ghEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/** GETs a repo file's raw content (throws on 404). */
async function ghGetRaw(path: string, ref: string): Promise<string> {
  return runGh([
    'api', '-H', 'Accept: application/vnd.github.raw',
    `repos/${REPO}/contents/${path}?ref=${ref}`,
  ]);
}

/** GETs a repo file's JSON metadata (content + sha), or null on 404. */
async function ghGetFileJson(
  path: string,
  ref: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    const raw = await runGh(['api', `repos/${REPO}/contents/${path}?ref=${ref}`]);
    const json = JSON.parse(raw);
    const content = Buffer.from(json.content ?? '', 'base64').toString('utf-8');
    return { content, sha: json.sha };
  } catch (err: any) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rule inventory
// ---------------------------------------------------------------------------

async function fetchRuleInventory(): Promise<{ files: RuleFile[]; names: Set<string> }> {
  const listing = await runGh(['api', `repos/${REPO}/contents/${RULES_DIR}?ref=main`]);
  const entries: { name: string; type: string }[] = JSON.parse(listing);
  const files: RuleFile[] = [];
  const names = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith('.mdc')) continue;
    names.add(entry.name);

    // Distinguish a genuine 404 (file vanished between listing and fetch → treat
    // as empty) from a transient failure. Swallowing the latter would make the
    // rule look empty and let the judge propose a near-duplicate of a rule that
    // actually exists — so abort the whole run instead. Skipping a week is safer.
    let firstLines = '';
    try {
      const raw = await ghGetRaw(`${RULES_DIR}/${entry.name}`, 'main');
      firstLines = raw.split('\n').slice(0, 15).join('\n');
    } catch (err: any) {
      if (!isNotFoundError(err)) {
        log(
          `FATAL: rule-inventory fetch for ${entry.name} failed and was not a 404 ` +
          `(${err.message}) — aborting rather than risk proposing near-duplicates`,
        );
        throw err;
      }
    }

    files.push({ name: entry.name, firstLines });
  }

  return { files, names };
}

// ---------------------------------------------------------------------------
// LLM judgement — one call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the reviewer for a weekly "harness retro" on the CREATE-LA/AurisFilmSeries repository. Cursor coding agents work in this repo all week. A mechanical pre-filter has extracted moments where the human corrected, contradicted, or expressed frustration with an agent. Your job: decide whether any moment justifies a NEW or EXPANDED standing rule in .cursor/rules/ — the always-on instructions every future agent reads.

Hold a HIGH bar. Propose a rule ONLY when the lesson is ALL of:
1. RECURRING or EXPENSIVE — it happened more than once, or a single occurrence wasted real time or caused real damage (broke prod, lost work, shipped the same thing twice).
2. ACTIONABLE as a standing instruction — a future agent could read it and behave differently. "Be more careful" is not a rule; "Before merging, run scripts/auris-preflight.sh and stop on a non-zero exit" is.
3. NOT ALREADY COVERED — the current rule inventory (provided) does not already address it. Never propose a duplicate of an existing rule.

Most weeks produce ZERO proposals, and that is the expected, correct outcome. A wrong-chat paste, a one-off typo, a normal task instruction, a routine question, or a single ambiguous signal is NOT a lesson. Do not invent rules to seem useful.

Prefer EXPANDING an existing rule (set targetFile to its exact filename) over creating a new one. Only create a new kebab-case .mdc when the lesson is a genuinely new domain not covered by any existing file.

Output STRICT JSON and NOTHING else — no prose, no code fences:
{"proposals": [ { "targetFile": "existing-file.mdc OR new-kebab-name.mdc", "title": "short imperative title", "ruleMarkdown": "the rule body as markdown ready to drop into a .mdc — imperative bullets or a short paragraph, no top-level heading", "evidence": [ { "sessionId": "id", "date": "YYYY-MM-DD", "quote": "short verbatim quote from the moment" } ], "rationale": "one sentence: why this clears the bar" } ] }

Constraints:
- 0 to ${MAX_PROPOSALS} proposals. Fewer is better. {"proposals": []} is valid and expected.
- Every proposal MUST cite at least one evidence quote taken from the candidate moments below.
- ruleMarkdown must be self-contained and specific to this repo's actual workflow.`;

function buildUserPrompt(candidates: Candidate[], inventory: RuleFile[]): string {
  const inventoryBlock = inventory
    .map(f => `=== ${f.name} ===\n${f.firstLines}`)
    .join('\n\n');

  const candidateBlock = candidates
    .map((c, i) => {
      const ctx = c.precedingAssistant.trim().replace(/\s+/g, ' ');
      const msg = c.userMessage.trim();
      return `[#${i + 1}] session ${c.sessionId} · ${c.date} · signals: ${c.signals.join(', ')}\nAGENT (preceding, truncated): ${ctx}\nHUMAN: ${msg}`;
    })
    .join('\n\n');

  return `CURRENT RULE INVENTORY (.cursor/rules/ on main — filename + first 15 lines):

${inventoryBlock}

---

CANDIDATE CORRECTION MOMENTS (mechanically pre-filtered — high recall, mostly noise; apply your bar):

${candidateBlock}`;
}

async function judgeProposals(
  candidates: Candidate[],
  inventory: RuleFile[],
  knownNames: Set<string>,
): Promise<{ proposals: Proposal[]; usage: TokenUsage }> {
  const userPrompt = buildUserPrompt(candidates, inventory);

  const msg = await withRetry(() => getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Sonnet 5 defaults adaptive thinking ON when omitted, which burns the whole
    // budget on thinking and returns no text block — disable it for reliable JSON.
    thinking: { type: 'disabled' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }), 'retro-judge');

  const usage: TokenUsage = {
    inputTokens: msg.usage?.input_tokens ?? 0,
    outputTokens: msg.usage?.output_tokens ?? 0,
  };

  const proposals = parseProposals(extractText(msg), knownNames);
  return { proposals, usage };
}

export function parseProposals(raw: string, knownNames: Set<string>): Proposal[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // Accept either the expected {"proposals": [...]} object or a bare [...] array,
  // whichever the model emitted first.
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  let slice = '';
  if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) {
    slice = text.slice(arrIdx, text.lastIndexOf(']') + 1);
  } else if (objIdx !== -1) {
    slice = text.slice(objIdx, text.lastIndexOf('}') + 1);
  }
  if (!slice) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }

  const arr = Array.isArray(parsed) ? parsed : parsed?.proposals;
  if (!Array.isArray(arr)) return [];

  const proposals: Proposal[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.title !== 'string' || typeof item.ruleMarkdown !== 'string') continue;
    if (!item.title.trim() || !item.ruleMarkdown.trim()) continue;

    const evidence: Evidence[] = Array.isArray(item.evidence)
      ? item.evidence
          .filter((e: any) => e && typeof e.quote === 'string' && e.quote.trim())
          .map((e: any) => ({
            sessionId: String(e.sessionId ?? '').trim(),
            date: String(e.date ?? '').trim(),
            quote: String(e.quote).trim().replace(/\s+/g, ' ').slice(0, 240),
          }))
      : [];
    if (evidence.length === 0) continue; // every proposal must cite evidence

    proposals.push({
      targetFile: sanitizeTargetFile(item.targetFile, item.title, knownNames),
      title: item.title.trim(),
      ruleMarkdown: item.ruleMarkdown.trim(),
      evidence,
      rationale: typeof item.rationale === 'string' ? item.rationale.trim() : '',
    });
    if (proposals.length >= MAX_PROPOSALS) break;
  }
  return proposals;
}

function kebab(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sanitizeTargetFile(raw: unknown, title: string, knownNames: Set<string>): string {
  let base = typeof raw === 'string' ? (raw.split('/').pop() ?? '').trim().toLowerCase() : '';
  if (knownNames.has(base)) return base;
  if (/^[a-z0-9][a-z0-9-]*\.mdc$/.test(base)) return base;
  const derived = kebab(title).slice(0, 50) || 'harness-retro';
  return `${derived}.mdc`;
}

// ---------------------------------------------------------------------------
// Rule-file rendering (append-only; never rewrites existing content)
// ---------------------------------------------------------------------------

function renderEvidenceFooter(proposal: Proposal, date: string): string {
  const lines = proposal.evidence.map(e => {
    const where = e.sessionId ? ` — session \`${e.sessionId}\`` : '';
    const when = e.date ? ` (${e.date})` : '';
    return `> - "${e.quote}"${where}${when}`;
  });
  return `> Added by the weekly harness retro on ${date}. Evidence:\n${lines.join('\n')}`;
}

/** A clearly-delimited section appended to an EXISTING rule file. */
export function renderAppendedSection(proposal: Proposal, date: string): string {
  return [
    '',
    '',
    `<!-- auris-retro:${date} -->`,
    `## ${proposal.title}`,
    '',
    proposal.ruleMarkdown,
    '',
    renderEvidenceFooter(proposal, date),
    '',
  ].join('\n');
}

/** A fresh rule file when the proposal targets a NEW .mdc. */
export function renderNewRuleFile(proposal: Proposal, date: string): string {
  const description = proposal.title.replace(/\n/g, ' ').slice(0, 120);
  return [
    '---',
    `description: ${description}`,
    'alwaysApply: false',
    '---',
    '',
    `# ${proposal.title}`,
    '',
    proposal.ruleMarkdown,
    '',
    renderEvidenceFooter(proposal, date),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Delivery — branch, commits, PR (only when there is >=1 proposal)
// ---------------------------------------------------------------------------

async function createBranch(date: string): Promise<string> {
  const headSha = (await runGh(['api', `repos/${REPO}/git/ref/heads/main`, '--jq', '.object.sha'])).trim();

  let branch = `retro/${date}`;
  const body = JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha });
  try {
    await runGh(['api', '--method', 'POST', `repos/${REPO}/git/refs`, '--input', '-'], body);
  } catch (err: any) {
    if (/already exists/i.test(err.message)) {
      branch = `retro/${date}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
      const retryBody = JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha });
      await runGh(['api', '--method', 'POST', `repos/${REPO}/git/refs`, '--input', '-'], retryBody);
    } else {
      throw err;
    }
  }
  return branch;
}

async function commitProposal(branch: string, proposal: Proposal, date: string): Promise<void> {
  const path = `${RULES_DIR}/${proposal.targetFile}`;
  // Re-read on the branch each time so repeated appends to the same file chain
  // correctly (the second append picks up the first commit's blob + sha).
  const existing = await ghGetFileJson(path, branch);

  let newContent: string;
  let action: string;
  const body: Record<string, string> = { branch };

  if (existing) {
    newContent = existing.content + renderAppendedSection(proposal, date);
    body.sha = existing.sha;
    action = 'append';
  } else {
    newContent = renderNewRuleFile(proposal, date);
    action = 'add';
  }

  body.message = `retro: ${action} rule "${proposal.title}" (${date})`;
  body.content = Buffer.from(newContent, 'utf-8').toString('base64');

  await runGh(['api', '--method', 'PUT', `repos/${REPO}/contents/${path}`, '--input', '-'], JSON.stringify(body));
  log(`committed ${action} → ${path} on ${branch}`);
}

async function openPullRequest(branch: string, date: string, prBody: string): Promise<string> {
  const body = JSON.stringify({
    title: `retro: proposed rules from week of ${date}`,
    head: branch,
    base: 'main',
    body: prBody,
  });
  const raw = await runGh(['api', '--method', 'POST', `repos/${REPO}/pulls`, '--input', '-'], body);
  const json = JSON.parse(raw);
  return json.html_url as string;
}

/**
 * Best-effort deletion of a branch ref, used when delivery fails after the
 * branch was created so we don't leave an orphan retro/* branch behind. Logs
 * the attempt either way and never throws (the original failure is the story).
 */
async function deleteOrphanBranch(branch: string): Promise<void> {
  log(`cleaning up orphan branch ${branch} after failed delivery`);
  try {
    await runGh(['api', '--method', 'DELETE', `repos/${REPO}/git/refs/heads/${branch}`]);
    log(`deleted orphan branch ${branch}`);
  } catch (err: any) {
    log(`orphan-branch cleanup failed for ${branch} (manual cleanup may be needed): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// PR / dry-run body
// ---------------------------------------------------------------------------

function renderProposalMarkdown(proposals: Proposal[], knownNames: Set<string>): string {
  return proposals
    .map((p, i) => {
      const kind = knownNames.has(p.targetFile) ? 'append to existing' : 'new file';
      const evidence = p.evidence
        .map(e => `- "${e.quote}" — session \`${e.sessionId}\`${e.date ? ` (${e.date})` : ''}`)
        .join('\n');
      return [
        `### ${i + 1}. ${p.title}`,
        `**Target:** \`${RULES_DIR}/${p.targetFile}\` (${kind})`,
        p.rationale ? `**Rationale:** ${p.rationale}` : '',
        '',
        p.ruleMarkdown,
        '',
        '**Evidence:**',
        evidence,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');
}

function renderStalenessBlock(flags: string[]): string {
  if (flags.length === 0) return '- No staleness flags this week.';
  return flags.map(f => `- ${f}`).join('\n');
}

export function buildPrBody(
  proposals: Proposal[],
  knownNames: Set<string>,
  flags: string[],
  stats: { sessionsScanned: number; candidatesFound: number },
  date: string,
): string {
  return [
    `## Proposed rules — week of ${date}`,
    '',
    'Auto-drafted by the weekly harness retro from Cursor agent transcripts. Each proposal was mined from a correction/incident moment and judged against a high bar (recurring or expensive, actionable as a standing instruction, not already covered). Review and merge selectively — nothing here is authoritative until a human approves it.',
    '',
    renderProposalMarkdown(proposals, knownNames),
    '',
    '---',
    '',
    '## Staleness watch',
    renderStalenessBlock(flags),
    '',
    '---',
    `_Sessions scanned: ${stats.sessionsScanned} · candidate moments: ${stats.candidatesFound} · proposals: ${proposals.length}_`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Staleness watch (report-only)
// ---------------------------------------------------------------------------

async function mtimeDaysAgo(path: string): Promise<number | null> {
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  return (Date.now() - s.mtimeMs) / (24 * 3600 * 1000);
}

async function dirHasRecentFiles(dir: string, daysBack: number): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && s.mtimeMs >= cutoff) return true;
  }
  return false;
}

async function runStalenessWatch(mentionsSpotWork: boolean): Promise<string[]> {
  const flags: string[] = [];

  // spot-builder retro dormant while spot work happened.
  const rendersRecent = await dirHasRecentFiles(SPOT_RENDERS, DAYS_BACK);
  const spotWorkHappened = mentionsSpotWork || rendersRecent;
  const learningsAge = await mtimeDaysAgo(SPOT_LEARNINGS);
  if (spotWorkHappened && learningsAge !== null && learningsAge > SPOT_STALE_DAYS) {
    flags.push(
      `spot-builder retro dormant while work happened — spot work seen this week ` +
      `(${mentionsSpotWork ? 'transcript mentions' : ''}${mentionsSpotWork && rendersRecent ? ' + ' : ''}${rendersRecent ? 'fresh renders' : ''}) ` +
      `but auris-spot-builder/LEARNINGS.md is ${Math.round(learningsAge)} days old (>${SPOT_STALE_DAYS}).`,
    );
  }

  // Mission skill untouched for a long stretch.
  const missionAge = await mtimeDaysAgo(MISSION_SKILL);
  if (missionAge !== null && missionAge > MISSION_STALE_DAYS) {
    flags.push(
      `mission skill untouched ${Math.round(missionAge)} days (>${MISSION_STALE_DAYS}) — ` +
      `SKILL.md may be drifting from current practice.`,
    );
  }

  return flags;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function readState(): Promise<RetroState> {
  const raw = await readFile(STATE_FILE, 'utf-8').catch(() => '');
  if (!raw) return { processedSessions: [], runs: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      processedSessions: Array.isArray(parsed.processedSessions) ? parsed.processedSessions : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    log('state file was unparseable — starting fresh');
    return { processedSessions: [], runs: [] };
  }
}

async function writeState(state: RetroState): Promise<void> {
  await atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

function estimateCost(usage: TokenUsage): string {
  const dollars =
    (usage.inputTokens / 1_000_000) * RATE_INPUT_PER_M +
    (usage.outputTokens / 1_000_000) * RATE_OUTPUT_PER_M;
  return `in=${usage.inputTokens} out=${usage.outputTokens} tokens ≈ $${dollars.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const date = todayStr();

  log(`=== weekly harness retro — ${date}${dryRun ? ' (DRY RUN)' : ''} ===`);

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY missing from environment');
  }

  // 1. Select sessions.
  const state = await readState();
  const processed = new Set(state.processedSessions);
  const sessions = await selectRecentSessions(DAYS_BACK, processed);
  log(`selected ${sessions.length} new session(s) from the last ${DAYS_BACK} days (${processed.size} already processed)`);

  // 2. Mechanical pre-filter.
  const prefilter = await prefilterCandidates(sessions);
  log(
    `pre-filter: ${prefilter.rawCandidateCount} raw candidate(s), ` +
    `${prefilter.candidates.length} kept after 80KB cap (${(prefilter.payloadBytes / 1024).toFixed(1)}KB payload)`,
  );

  // 4 (compute early so flags are ready for both PR and log-only paths).
  const flags = await runStalenessWatch(prefilter.mentionsSpotWork);
  for (const f of flags) log(`STALENESS: ${f}`);

  // 3. LLM judgement (skip the call only when there is genuinely nothing to judge).
  let proposals: Proposal[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let knownNames = new Set<string>();

  if (prefilter.candidates.length === 0) {
    log('no candidate moments — skipping LLM call (0 proposals)');
  } else {
    const inventory = await fetchRuleInventory();
    knownNames = inventory.names;
    log(`fetched rule inventory: ${inventory.files.length} .mdc file(s)`);
    const judged = await judgeProposals(prefilter.candidates, inventory.files, knownNames);
    proposals = judged.proposals;
    usage = judged.usage;
    log(`LLM judged ${proposals.length} proposal(s) · ${estimateCost(usage)}`);
  }

  const prBody = buildPrBody(
    proposals,
    knownNames,
    flags,
    { sessionsScanned: sessions.length, candidatesFound: prefilter.candidates.length },
    date,
  );

  // --- DRY RUN: print, never mutate ---
  if (dryRun) {
    log('--- DRY RUN OUTPUT ---');
    log(`sessions scanned: ${sessions.length}`);
    log(`candidate moments: ${prefilter.candidates.length}`);
    log(`staleness flags: ${flags.length}`);
    log(`proposals drafted: ${proposals.length}`);
    console.log('\n========== PROPOSALS (verbatim) ==========');
    console.log(proposals.length ? JSON.stringify(proposals, null, 2) : '(none — 0 proposals is a valid outcome)');
    console.log('\n========== PR BODY THAT WOULD BE OPENED ==========');
    console.log(proposals.length ? prBody : '(no PR — 0 proposals)');
    console.log('\n========== END DRY RUN ==========');
    log(`cost estimate: ${estimateCost(usage)}`);
    log('dry run complete — no branch, no PR, no state written');
    return;
  }

  // 5. Deliver.
  let prUrl = 'none';
  if (proposals.length > 0) {
    const branch = await createBranch(date);
    log(`created branch ${branch}`);
    try {
      for (const proposal of proposals) {
        await commitProposal(branch, proposal, date);
      }
      prUrl = await openPullRequest(branch, date, prBody);
      log(`opened PR: ${prUrl}`);
    } catch (err) {
      // Delivery broke mid-flight after the branch existed — remove it so a
      // retry next run starts clean instead of colliding with an empty orphan.
      await deleteOrphanBranch(branch);
      throw err;
    }
  } else {
    log('0 proposals — no branch, no PR');
  }

  // 6. Record state + summary.
  const newProcessed = [...state.processedSessions];
  for (const s of sessions) if (!processed.has(s.sessionId)) newProcessed.push(s.sessionId);

  const runRecord: RunRecord = {
    date,
    sessionsScanned: sessions.length,
    candidatesFound: prefilter.candidates.length,
    proposalsMade: proposals.length,
    prUrl,
  };

  await writeState({ processedSessions: newProcessed, runs: [...state.runs, runRecord] });
  log(`state updated: ${newProcessed.length} processed session(s) total, ${state.runs.length + 1} run(s) recorded`);

  log('--- RETRO SUMMARY ---');
  log(`sessions scanned: ${sessions.length}`);
  log(`candidate moments: ${prefilter.candidates.length}`);
  log(`proposals made: ${proposals.length}`);
  log(`staleness flags: ${flags.length}`);
  log(`PR: ${prUrl}`);
  log(`cost estimate: ${estimateCost(usage)}`);
  log('--- DONE ---');
}

if (require.main === module) {
  run().catch(err => {
    console.error(`[auris-retro] FATAL: ${err.message}\n${err.stack ?? ''}`);
    process.exit(1);
  });
}
