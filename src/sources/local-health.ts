/**
 * Local-health source — detects when macOS-protected local data stores are
 * inaccessible because the pipeline is running under launchd WITHOUT Full Disk
 * Access (TCC). Without FDA, reads of these TCC-protected stores throw EPERM
 * and the corresponding sources silently return "(unavailable)" sentinels.
 *
 * This module is PURE: it probes access, evaluates degraded state, diffs
 * against persisted state to surface working→broken / broken→working
 * transitions, and produces a banner string for the brief. It does NOT send
 * email itself — a later feature wires up alerting.
 *
 * Protected stores probed:
 *   - reminders: ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores
 *   - imessage:  ~/Library/Messages/chat.db
 *   - calendar:  ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb
 *                (LOCAL Calendar.sqlitedb enrichment only — not the MS Graph calendar)
 *
 * Resilience: every exported function is wrapped in try/catch and returns a
 * safe default — they NEVER throw out to the caller. Logs use the
 * [local-health] prefix so any fallback path is visible.
 */

import { readdir, access, readFile, writeFile, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type SourceKey = 'reminders' | 'imessage' | 'calendar';
export type AccessState = 'ok' | 'denied';

export interface ProbeResult {
  reminders: AccessState;
  imessage: AccessState;
  calendar: AccessState; // refers to LOCAL Calendar.sqlitedb enrichment only
}

export interface SourceValues {
  reminders?: string;
  imessage?: string;
  calendar?: string;
}

export interface HealthEvaluation {
  degraded: SourceKey[]; // currently broken
  banner: string; // '' if all healthy; else a 🛑 markdown banner
  transitions: { source: SourceKey; kind: 'broke' | 'recovered' }[]; // vs persisted state
}

interface HealthState {
  degraded: SourceKey[];
  updated: string; // ISO timestamp
}

/** All source keys, in stable display order. */
const SOURCE_KEYS: SourceKey[] = ['reminders', 'imessage', 'calendar'];

/** Human-friendly labels for banner copy. */
const SOURCE_LABELS: Record<SourceKey, string> = {
  reminders: 'Reminders',
  imessage: 'iMessage',
  calendar: 'Calendar',
};

// TCC-protected store paths.
const REMINDERS_STORE_DIR = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.reminders',
  'Container_v1',
  'Stores',
);
const IMESSAGE_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const CALENDAR_DB = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.calendar',
  'Calendar.sqlitedb',
);

const STATE_PATH = join(homedir(), 'briefing-data', 'source-health.json');

// Staged copies written by stage-protected.sh (sourced by the launchd bash
// wrapper right before the pipeline starts). Under launchd, node's direct
// reads of the protected originals are TCC-denied (stale per-binary deny on
// the node binary overrides the /bin/bash FDA grant), but the pipeline works
// off these staged copies — so a FRESH staged copy means the source is
// functionally healthy even when the direct probe is denied.
const STAGING_DIR = join(homedir(), 'briefing-data', 'staging');
const STAGED_REMINDERS_DIR = join(STAGING_DIR, 'reminders-stores');
const STAGING_MAX_AGE_MS = 30 * 60 * 1000;

/** True if `path` exists and was modified within the staging freshness window. */
async function isFreshStaged(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs <= STAGING_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** True if the staged reminders dir holds at least one fresh .sqlite store. */
async function hasFreshStagedReminders(): Promise<boolean> {
  try {
    const files = await readdir(STAGED_REMINDERS_DIR);
    for (const f of files) {
      if (!f.endsWith('.sqlite')) continue;
      if (await isFreshStaged(join(STAGED_REMINDERS_DIR, f))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Probe read access to each protected store IN THE CURRENT PROCESS CONTEXT.
 * Never throws — any failure maps to 'denied'.
 */
export async function probeProtectedAccess(): Promise<ProbeResult> {
  const [reminders, imessage, calendar] = await Promise.all([
    probeReminders(),
    probeImessage(),
    probeCalendar(),
  ]);
  return { reminders, imessage, calendar };
}

/** Reminders: direct listing of the Stores dir, else a fresh staged copy. */
async function probeReminders(): Promise<AccessState> {
  try {
    // Success OR empty listing both mean we have read access to the dir.
    await readdir(REMINDERS_STORE_DIR);
    return 'ok';
  } catch (err: any) {
    if (await hasFreshStagedReminders()) {
      console.log('[local-health] reminders: direct read denied, fresh staged copy present — ok');
      return 'ok';
    }
    console.log(
      `[local-health] reminders probe denied: ${err?.code || err?.message?.slice(0, 60) || 'unknown'}`,
    );
    return 'denied';
  }
}

/** iMessage: direct fs.access(R_OK) on chat.db, else a fresh staged copy. */
async function probeImessage(): Promise<AccessState> {
  try {
    await access(IMESSAGE_DB, fsConstants.R_OK);
    return 'ok';
  } catch (err: any) {
    if (await isFreshStaged(join(STAGING_DIR, 'chat.db'))) {
      console.log('[local-health] imessage: direct read denied, fresh staged copy present — ok');
      return 'ok';
    }
    console.log(
      `[local-health] imessage probe denied: ${err?.code || err?.message?.slice(0, 60) || 'unknown'}`,
    );
    return 'denied';
  }
}

/** Calendar: direct fs.access(R_OK) on Calendar.sqlitedb, else a fresh staged copy. */
async function probeCalendar(): Promise<AccessState> {
  try {
    await access(CALENDAR_DB, fsConstants.R_OK);
    return 'ok';
  } catch (err: any) {
    if (await isFreshStaged(join(STAGING_DIR, 'Calendar.sqlitedb'))) {
      console.log('[local-health] calendar: direct read denied, fresh staged copy present — ok');
      return 'ok';
    }
    console.log(
      `[local-health] calendar probe denied: ${err?.code || err?.message?.slice(0, 60) || 'unknown'}`,
    );
    return 'denied';
  }
}

/**
 * A source value counts as a HARD sentinel (NO data) ONLY when, after trimming,
 * it BOTH starts with '(' AND contains "unavailable" — i.e. one of the
 * parenthetical no-data strings like '(unavailable)', '(reminders unavailable
 * — ...)', '(calendar unavailable — ...)'. The exact '(unavailable)' case
 * satisfies this rule too.
 *
 * WHY NOT match every "unavailable": age-stamped cache values are prefixed with
 * '⚠️' and still carry real cached content below the stamp — data IS present,
 * so they must NOT be flagged here. A true Full-Disk-Access denial is caught
 * independently and authoritatively by probeProtectedAccess(), so suppressing
 * the value-flag for age-stamped cache only avoids noisy false alerts on
 * transient hiccups that still served fresh cache; it never hides a real FDA
 * emergency.
 */
function isUnavailableSentinel(value: string | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  return trimmed.startsWith('(') && /unavailable/i.test(trimmed);
}

/** Read prior persisted degraded[] (missing/corrupt file => []). Never throws. */
async function loadPriorDegraded(): Promise<SourceKey[]> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HealthState>;
    if (!parsed || !Array.isArray(parsed.degraded)) return [];
    // Only keep recognized keys, de-duplicated, in stable order.
    return SOURCE_KEYS.filter(k => (parsed.degraded as unknown[]).includes(k));
  } catch {
    return [];
  }
}

/**
 * Decide which sources are degraded given the probe result AND the actual
 * fetched source values. A source is degraded if probe==='denied' OR its
 * value matches /unavailable/i (or is exactly '(unavailable)').
 *
 * Diffs against the persisted degraded-set to report transitions. Does NOT
 * write state — that's commitHealthState's job. Never throws.
 */
export async function evaluateLocalHealth(
  probe: ProbeResult,
  values: SourceValues,
): Promise<HealthEvaluation> {
  try {
    const degraded: SourceKey[] = SOURCE_KEYS.filter(key => {
      const probeDenied = probe?.[key] === 'denied';
      const valueSentinel = isUnavailableSentinel(values?.[key]);
      return probeDenied || valueSentinel;
    });

    const prior = await loadPriorDegraded();
    const transitions: { source: SourceKey; kind: 'broke' | 'recovered' }[] = [];
    for (const key of SOURCE_KEYS) {
      const nowDegraded = degraded.includes(key);
      const wasDegraded = prior.includes(key);
      if (nowDegraded && !wasDegraded) transitions.push({ source: key, kind: 'broke' });
      else if (!nowDegraded && wasDegraded) transitions.push({ source: key, kind: 'recovered' });
    }

    const banner = buildBanner(degraded);
    if (degraded.length) {
      console.log(
        `[local-health] degraded: ${degraded.join(', ')}${transitions.length ? ` | transitions: ${transitions.map(t => `${t.source}:${t.kind}`).join(', ')}` : ''}`,
      );
    }

    return { degraded, banner, transitions };
  } catch (err: any) {
    console.log(`[local-health] evaluate failed: ${err?.message?.slice(0, 80) || 'unknown'}`);
    return { degraded: [], banner: '', transitions: [] };
  }
}

/** Build the 🛑 markdown banner. Returns '' when nothing is degraded. */
function buildBanner(degraded: SourceKey[]): string {
  if (!degraded.length) return '';
  const labels = degraded.map(k => SOURCE_LABELS[k]);
  const list = joinWithAnd(labels);
  const verb = degraded.length === 1 ? 'is' : 'are';
  return (
    `🛑 **Data access issue:** ${list} ${verb} unavailable ` +
    `(Full Disk Access likely revoked for the scheduled job). ` +
    `Fix: grant Full Disk Access to /bin/bash in System Settings → Privacy & Security, ` +
    `then run \`npm run check-access\`.`
  );
}

/** "A", "A and B", "A, B and C". */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Persist the current degraded-set so the next run can diff for transitions.
 * Caller commits AFTER sending any alerts. Never throws.
 */
export async function commitHealthState(currentDegraded: SourceKey[]): Promise<void> {
  try {
    // Normalize to recognized keys, de-duplicated, stable order.
    const degraded = SOURCE_KEYS.filter(k => currentDegraded?.includes(k));
    const state: HealthState = { degraded, updated: new Date().toISOString() };
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`[local-health] committed health state (degraded: ${degraded.join(', ') || 'none'})`);
  } catch (err: any) {
    console.log(`[local-health] commit failed: ${err?.message?.slice(0, 80) || 'unknown'}`);
  }
}
