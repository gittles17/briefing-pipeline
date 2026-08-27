/**
 * auris-retro-status.ts
 *
 * Pure, mechanical reader for the weekly "harness retro" job (src/auris-retro.ts,
 * Mondays 07:30). That job records each run in ~/briefing-data/auris-retro-state.json
 * via its writeState():
 *   { processedSessions: string[], runs: RunRecord[] }
 * where each RunRecord is
 *   { date, sessionsScanned, candidatesFound, proposalsMade, prUrl }.
 *
 * This reader returns ONE line summarizing the most recent run IF that run
 * happened within the last 7 days, e.g.
 *   "Harness retro (Mon): 2 rule proposals → https://github.com/…/pull/12"
 *   "Harness retro (Mon): nothing qualified this week"
 * otherwise null. Null is also returned when the state file is missing, empty,
 * malformed, or has no in-window run — the caller then omits the line entirely
 * so the briefing is completely unaffected.
 *
 * No LLM call, no network, no writes; defensive against every field being the
 * wrong type; never throws.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const STATE_FILE = join(homedir(), 'briefing-data', 'auris-retro-state.json');
const WINDOW_DAYS = 7;

// Only the fields we read, all optional/unknown so a malformed record can never
// throw. `date` is what auris-retro.ts writeState() persists; `runAt` is read as
// a tolerant fallback. `stalenessFlags` is optional — the current writer does
// NOT persist it, so the clause simply never appears until/unless it does.
interface RetroRunRecord {
  date?: unknown;
  runAt?: unknown;
  proposalsMade?: unknown;
  prUrl?: unknown;
  stalenessFlags?: unknown;
}

/** Parse a date/timestamp string to epoch ms, or null if unusable. */
function toTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** Condense a (possibly long) staleness-flag sentence into one short clause. */
function shortFlag(flag: string): string {
  // Flags from auris-retro.ts read like "spot-builder retro dormant while work
  // happened — …". Keep only the leading summary before the first "while" /
  // em-dash / sentence break so the briefing stays a single line.
  const head = flag.split(/\s+while\s+|\s+—\s+|[.;]/i)[0].trim();
  return (head || flag.trim()).slice(0, 60).trim();
}

/** Build the optional "; <clause>" suffix from a run's staleness flags. */
function buildStalenessClause(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const flags = raw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  if (flags.length === 0) return '';
  const clause = shortFlag(flags[0]);
  if (!clause) return '';
  const extra = flags.length > 1 ? ` (+${flags.length - 1} more)` : '';
  return `; ${clause}${extra}`;
}

/** The most recent run by parseable date, or null if none is dated. */
function pickMostRecentRun(runs: RetroRunRecord[]): { run: RetroRunRecord; time: number } | null {
  let best: { run: RetroRunRecord; time: number } | null = null;
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    const time = toTime(run.date) ?? toTime(run.runAt);
    if (time === null) continue;
    if (!best || time > best.time) best = { run, time };
  }
  return best;
}

/**
 * @param stateFile overridable for testing; defaults to the real state path.
 * @returns the one-line retro summary, or null when nothing should be surfaced.
 */
export async function fetchAurisRetroStatus(stateFile: string = STATE_FILE): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(stateFile, 'utf-8');
  } catch {
    return null; // no state file yet → nothing to surface
  }
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON → omit, never throw
  }

  const runs = Array.isArray((parsed as { runs?: unknown })?.runs)
    ? ((parsed as { runs: RetroRunRecord[] }).runs)
    : [];
  if (runs.length === 0) return null;

  const recent = pickMostRecentRun(runs);
  if (!recent) return null;

  // Only surface a run from the last 7 days. Allow a small negative tolerance so
  // a same-day run (state date is UTC midnight, "now" is local) is not excluded.
  const ageDays = (Date.now() - recent.time) / 86_400_000;
  if (ageDays > WINDOW_DAYS || ageDays < -2) return null;

  const run = recent.run;
  const staleness = buildStalenessClause(run.stalenessFlags);
  const proposals =
    typeof run.proposalsMade === 'number' && run.proposalsMade > 0 ? run.proposalsMade : 0;

  if (proposals === 0) {
    return `Harness retro (Mon): nothing qualified this week${staleness}`;
  }

  const noun = `${proposals} rule proposal${proposals === 1 ? '' : 's'}`;
  const target = isHttpUrl(run.prUrl) ? ` → ${run.prUrl.trim()}` : '';
  return `Harness retro (Mon): ${noun}${target}${staleness}`;
}
