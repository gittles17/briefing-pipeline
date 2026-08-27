/**
 * cursor-transcripts.ts
 *
 * Reads Cursor agent transcripts for the Auris repo and mechanically mines them
 * for correction/incident moments — the raw material the weekly harness retro
 * (src/auris-retro.ts) feeds to a single LLM judgement call.
 *
 * Transcript layout (one directory per chat session):
 *   <session-uuid>/<session-uuid>.jsonl        parent chat (what we scan)
 *   <session-uuid>/subagents/*.jsonl           optional worker chats (ignored —
 *                                              the human never corrects a
 *                                              subagent directly, so correction
 *                                              signal lives only in the parent)
 *
 * Per-line JSON: `role: "user" | "assistant"` with `message.content[]` blocks
 * (`type: "text"` / `type: "tool_use"`), plus `type: "turn_ended"` markers.
 * There is no JSON timestamp field — the human's date is embedded inside the
 * user text as a `<timestamp>...</timestamp>` tag, and the real ask is wrapped
 * in `<user_query>...</user_query>`. Everything else in a user block is IDE
 * scaffolding (attached skills, tool catalogs, auto-continue prompts) and is
 * stripped before matching.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export const AURIS_TRANSCRIPTS_DIR = join(
  homedir(),
  '.cursor',
  'projects',
  'Users-jonathan-gitlin-Projects-Auris-AurisFilmSeries',
  'agent-transcripts',
);

/** A parent-chat transcript selected for this run. */
export interface SessionRef {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

/** A flagged correction/incident moment from the mechanical pre-filter. */
export interface Candidate {
  sessionId: string;
  /** ISO date (YYYY-MM-DD) from the embedded <timestamp>, or the file mtime. */
  date: string;
  /** Correction signals that fired (e.g. ['wrong', 'revert']). */
  signals: string[];
  /** Count of STRONG (correction-specific) signals — used for ranking. */
  strongCount: number;
  /** The human message, trimmed to ~600 chars. */
  userMessage: string;
  /** Up to ~400 chars of the preceding assistant text, for context. */
  precedingAssistant: string;
}

export interface PrefilterResult {
  candidates: Candidate[];
  sessionsScanned: number;
  /** Candidates before the payload cap was applied. */
  rawCandidateCount: number;
  /** Total bytes of message + context text in the kept candidates. */
  payloadBytes: number;
  /** True if any scanned transcript mentions spot-builder / auris-demo work. */
  mentionsSpotWork: boolean;
}

const USER_MESSAGE_MAX = 600;
const CONTEXT_MAX = 400;
const DEFAULT_PAYLOAD_CAP = 80 * 1024;
/** Weak signals are noisy inside long task briefs; only trust them when short. */
const WEAK_SIGNAL_MAX_LEN = 500;
const REPEAT_MIN_LEN = 25;
const REPEAT_JACCARD = 0.85;

/**
 * STRONG signals name a correction directly and count regardless of length.
 * WEAK signals ("again", "stop") appear incidentally in long task briefs, so
 * they only count on short messages. Both lists are matched case-insensitively.
 */
const STRONG_SIGNALS: { name: string; re: RegExp }[] = [
  { name: 'no,', re: /\bno,/i },
  { name: 'wrong', re: /\bwrong\b/i },
  { name: "that's-not", re: /that'?s not/i },
  { name: 'not-what-i', re: /not what i/i },
  { name: 'undo', re: /\bundo\b/i },
  { name: 'revert', re: /\brevert\b/i },
  { name: 'you-broke', re: /you broke/i },
  { name: 'still-broken', re: /still broken/i },
  { name: 'i-said', re: /\bi said\b/i },
  { name: 'why-did-you', re: /why did you/i },
];

const WEAK_SIGNALS: { name: string; re: RegExp }[] = [
  { name: 'again', re: /\bagain\b/i },
  { name: 'stop', re: /\bstop\b/i },
];

/**
 * IDE-generated user turns that are not human asks: auto-continue prompts fired
 * after a subagent finishes, single-word continues, and bare tool/catalog
 * blocks. These dominate the raw stream and must be dropped before matching.
 */
const AUTO_MESSAGE_PATTERNS: RegExp[] = [
  /^perform any necessary follow-up/i,
  /perform any follow-up actions/i,
  /^briefly inform the user about the task result/i,
  /^continue\.?$/i,
];

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Selects parent-chat transcripts whose jsonl was modified within `daysBack`
 * days, excluding sessions already processed. Sorted newest-first.
 */
export async function selectRecentSessions(
  daysBack: number,
  excludeSessionIds: Set<string>,
): Promise<SessionRef[]> {
  const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
  const entries = await readdir(AURIS_TRANSCRIPTS_DIR).catch(() => [] as string[]);
  const sessions: SessionRef[] = [];

  for (const sessionId of entries) {
    if (excludeSessionIds.has(sessionId)) continue;
    const filePath = join(AURIS_TRANSCRIPTS_DIR, sessionId, `${sessionId}.jsonl`);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) continue;
    if (fileStat.mtimeMs < cutoff) continue;
    sessions.push({ sessionId, filePath, mtimeMs: fileStat.mtimeMs });
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

/**
 * Mechanically mines the selected sessions for correction moments. No LLM.
 * Candidates are ranked (strong signals first, then total signals, then
 * brevity) and truncated to `payloadCap` bytes so the strongest survive.
 */
export async function prefilterCandidates(
  sessions: SessionRef[],
  payloadCap: number = DEFAULT_PAYLOAD_CAP,
): Promise<PrefilterResult> {
  const all: Candidate[] = [];
  let mentionsSpotWork = false;

  for (const session of sessions) {
    const raw = await readFile(session.filePath, 'utf-8').catch(() => '');
    if (!raw) continue;

    if (/spot-builder|auris-demo/i.test(raw)) mentionsSpotWork = true;

    const fallbackDate = new Date(session.mtimeMs).toISOString().slice(0, 10);
    all.push(...extractSessionCandidates(session.sessionId, raw, fallbackDate));
  }

  const rawCandidateCount = all.length;

  all.sort((a, b) =>
    b.strongCount - a.strongCount ||
    b.signals.length - a.signals.length ||
    a.userMessage.length - b.userMessage.length,
  );

  const kept: Candidate[] = [];
  let payloadBytes = 0;
  for (const candidate of all) {
    // ~120 bytes accounts for the JSON scaffolding each candidate adds.
    const size = candidate.userMessage.length + candidate.precedingAssistant.length + 120;
    if (payloadBytes + size > payloadCap) continue;
    kept.push(candidate);
    payloadBytes += size;
  }

  return {
    candidates: kept,
    sessionsScanned: sessions.length,
    rawCandidateCount,
    payloadBytes,
    mentionsSpotWork,
  };
}

function extractSessionCandidates(
  sessionId: string,
  raw: string,
  fallbackDate: string,
): Candidate[] {
  const turns = parseTurns(raw);
  const candidates: Candidate[] = [];
  const priorTokenSets: Set<string>[] = [];
  let lastAssistant: string | null = null;

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      if (turn.text.trim()) lastAssistant = turn.text;
      continue;
    }

    const { text, date } = extractUserText(turn.text, fallbackDate);
    if (!text || isAutoMessage(text)) continue;

    const strong = STRONG_SIGNALS.filter(s => s.re.test(text)).map(s => s.name);
    const weak = text.length < WEAK_SIGNAL_MAX_LEN
      ? WEAK_SIGNALS.filter(s => s.re.test(text)).map(s => s.name)
      : [];

    const tokens = tokenize(text);
    let repeat = false;
    if (text.length > REPEAT_MIN_LEN) {
      repeat = priorTokenSets.some(prev => jaccard(tokens, prev) >= REPEAT_JACCARD);
    }
    priorTokenSets.push(tokens);

    const signals = [...strong, ...weak, ...(repeat ? ['repeat'] : [])];
    // A correction is a reply to the agent — require a preceding assistant turn,
    // which also excludes the session's opening task brief.
    if (signals.length === 0 || lastAssistant === null) continue;

    candidates.push({
      sessionId,
      date,
      signals,
      strongCount: strong.length,
      userMessage: text.slice(0, USER_MESSAGE_MAX),
      precedingAssistant: lastAssistant.slice(-CONTEXT_MAX),
    });
  }

  return candidates;
}

function parseTurns(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = entry.message?.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
    } else if (typeof content === 'string') {
      text = content;
    }
    turns.push({ role, text });
  }
  return turns;
}

/**
 * Pulls the human's actual message out of a user turn: unwraps
 * `<user_query>`, captures the `<timestamp>` date, and returns empty text for
 * turns with no user_query (bare tool/catalog scaffolding).
 */
function extractUserText(
  rawText: string,
  fallbackDate: string,
): { text: string; date: string } {
  const date = parseTimestampDate(rawText, fallbackDate);

  const queries = [...rawText.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map(m => m[1]);
  if (queries.length === 0) return { text: '', date };

  let text = queries.join('\n');
  text = text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, date };
}

function parseTimestampDate(rawText: string, fallbackDate: string): string {
  const tsMatch = rawText.match(/<timestamp>(.*?)<\/timestamp>/);
  if (tsMatch) {
    const m = tsMatch[1].match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/);
    if (m) {
      const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (month) {
        const day = m[2].padStart(2, '0');
        return `${m[3]}-${month}-${day}`;
      }
    }
  }
  return fallbackDate;
}

function isAutoMessage(text: string): boolean {
  return AUTO_MESSAGE_PATTERNS.some(re => re.test(text));
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
