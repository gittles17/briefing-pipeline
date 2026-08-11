/**
 * self-heal.ts
 * Autonomous pre-flight repair pass. Runs at the START of every briefing (and
 * on demand via `npm run heal`), BEFORE any data source is fetched, so the
 * fetches see an already-repaired environment.
 *
 * DESIGN PRINCIPLES
 * - Every remediation is idempotent and fault-isolated: a step that can't run
 *   or fails returns a result, it NEVER throws out to the caller.
 * - Every step reports one of: 'healed' (it found a problem and fixed it),
 *   'noop' (nothing to do — already healthy), or 'failed' (found a problem it
 *   could not fix — this is what escalates to a human alert).
 * - HONESTY over optimism: a step only claims 'healed' after re-verifying. When
 *   a problem genuinely cannot be fixed by software (a revoked macOS Full Disk
 *   Access grant — Apple blocks scripted TCC changes by design), the step says
 *   so precisely instead of pretending, so the alert names the real cause.
 *
 * WHAT IT FIXES AUTOMATICALLY
 *  1. native-module ABI mismatch (THE common breakage): after `brew upgrade
 *     node`, better-sqlite3's compiled binary targets the wrong Node ABI and
 *     iMessage silently drops out. Self-heal detects it and runs
 *     `npm rebuild better-sqlite3` against the running Node, loop-guarded.
 *  2. missing data/staging directories
 *  3. stale `*.lock` mutex dirs left by a crashed writer
 *  4. orphaned `brief-db-*` temp dirs from crashed DB copies
 *  5. corrupt graph-tokens.json (the `}}` double-brace class)
 *  6. stale staged copies of TCC-protected DBs — re-staged when THIS process
 *     context can read the originals (interactive / launchd-with-FDA).
 *
 * WHAT IT CANNOT FIX (and says so)
 *  - Full Disk Access revoked from /bin/bash for the scheduled job. macOS does
 *    not allow granting TCC permissions programmatically. Self-heal will still
 *    attempt a re-stage (which recovers the common case where the current
 *    context retained FDA); only a genuine, unrecoverable denial escalates.
 */

import { readdir, readFile, writeFile, rename, unlink, mkdir, rmdir, rm, stat, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir, tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { getGraphTokenHealth, isGraphConfigured } from './graph-client';

const exec = promisify(execFile);

const DATA_DIR = join(homedir(), 'briefing-data');
const STAGING_DIR = join(DATA_DIR, 'staging');
const STAGED_REMINDERS_DIR = join(STAGING_DIR, 'reminders-stores');
const TOKEN_PATH = join(DATA_DIR, 'graph-tokens.json');
const ABI_MARKER_PATH = join(DATA_DIR, '.abi-heal.json');

// Repo root = two levels up from this file (src/sources/self-heal.ts).
const REPO_ROOT = join(__dirname, '..', '..');

const LOCK_STALE_MS = 60 * 1000; // a mutex dir older than this is from a dead writer
const TEMPDIR_STALE_MS = 60 * 60 * 1000; // orphan brief-db-* temp dirs older than 1h
const ABI_REBUILD_COOLDOWN_MS = 60 * 60 * 1000; // don't re-rebuild the same ABI within 1h

export type HealOutcome = 'healed' | 'noop' | 'failed';

export interface HealAction {
  id: string;
  detail: string;
  outcome: HealOutcome;
  note?: string;
}

export interface SelfHealReport {
  actions: HealAction[];
  healed: string[]; // ids that fixed something
  failed: string[]; // ids that found an unfixable problem (escalate)
  summary: string; // one-line human summary
}

function log(msg: string): void {
  console.log(`[self-heal] ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. ensure-dirs — the whole system assumes these exist
// ---------------------------------------------------------------------------
async function ensureDirs(): Promise<HealAction> {
  const id = 'ensure-dirs';
  try {
    let created = 0;
    for (const d of [DATA_DIR, STAGING_DIR, STAGED_REMINDERS_DIR]) {
      try {
        await access(d, fsConstants.F_OK);
      } catch {
        await mkdir(d, { recursive: true });
        created++;
      }
    }
    return created
      ? { id, detail: 'create missing data/staging dirs', outcome: 'healed', note: `created ${created}` }
      : { id, detail: 'data/staging dirs present', outcome: 'noop' };
  } catch (err: any) {
    return { id, detail: 'ensure data/staging dirs', outcome: 'failed', note: err?.message?.slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// 2. clear-stale-locks — a crashed writer can leave a *.lock mutex dir behind,
//    which would make atomic writers (rule-usage, proposals) wait then fail.
// ---------------------------------------------------------------------------
async function clearStaleLocks(): Promise<HealAction> {
  const id = 'clear-stale-locks';
  try {
    const entries = await readdir(DATA_DIR, { withFileTypes: true });
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.endsWith('.lock')) continue;
      const p = join(DATA_DIR, e.name);
      try {
        const s = await stat(p);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rmdir(p);
          removed++;
          log(`removed stale lock ${e.name}`);
        }
      } catch {
        /* lock vanished or held; leave it */
      }
    }
    return removed
      ? { id, detail: 'remove stale mutex locks', outcome: 'healed', note: `removed ${removed}` }
      : { id, detail: 'no stale locks', outcome: 'noop' };
  } catch (err: any) {
    return { id, detail: 'scan for stale locks', outcome: 'failed', note: err?.message?.slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// 3. prune-orphan-tempdirs — copyDbForReading() makes brief-db-* temp dirs and
//    cleans them up, but a crash mid-read leaks them. Prune old ones.
// ---------------------------------------------------------------------------
async function pruneOrphanTempDirs(): Promise<HealAction> {
  const id = 'prune-orphan-tempdirs';
  try {
    const base = tmpdir();
    const entries = await readdir(base, { withFileTypes: true });
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('brief-db-')) continue;
      const p = join(base, e.name);
      try {
        const s = await stat(p);
        if (Date.now() - s.mtimeMs > TEMPDIR_STALE_MS) {
          await rm(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    return removed
      ? { id, detail: 'prune orphaned DB temp dirs', outcome: 'healed', note: `removed ${removed}` }
      : { id, detail: 'no orphaned temp dirs', outcome: 'noop' };
  } catch (err: any) {
    return { id, detail: 'scan temp dirs', outcome: 'failed', note: err?.message?.slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// 4. repair-graph-token — the `}}` double-brace corruption class (concurrent
//    writers appended a stray brace). Parse; if it fails but a single trailing
//    brace strip makes it valid, rewrite atomically.
// ---------------------------------------------------------------------------
async function repairGraphToken(): Promise<HealAction> {
  const id = 'repair-graph-token';
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, 'utf-8');
  } catch {
    return { id, detail: 'graph token file', outcome: 'noop', note: 'absent (delegated auth may be unused)' };
  }
  try {
    JSON.parse(raw);
    return { id, detail: 'graph token JSON valid', outcome: 'noop' };
  } catch {
    const trimmed = raw.trim();
    if (trimmed.endsWith('}}')) {
      try {
        const obj = JSON.parse(trimmed.slice(0, -1));
        const tmp = `${TOKEN_PATH}.tmp.${process.pid}.${Date.now()}`;
        await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
        await rename(tmp, TOKEN_PATH);
        log('repaired graph-tokens.json (}} corruption)');
        return { id, detail: 'repair corrupt graph token JSON', outcome: 'healed' };
      } catch {
        /* fall through */
      }
    }
    return {
      id,
      detail: 'graph token JSON corrupt',
      outcome: 'failed',
      note: 'unrecoverable — run `npm run reauth`',
    };
  }
}

// ---------------------------------------------------------------------------
// 5. native-module ABI mismatch — THE common breakage after a Node upgrade.
//    better-sqlite3's compiled .node targets a Node ABI; if the running Node's
//    ABI differs, `new Database()` throws NODE_MODULE_VERSION and iMessage
//    silently drops out. Detect by probing in a child, then `npm rebuild`.
// ---------------------------------------------------------------------------

/** Probe better-sqlite3 in a child using the SAME node; returns true if it loads. */
async function betterSqliteLoads(): Promise<{ ok: boolean; abiErr: boolean; msg: string }> {
  try {
    await exec(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], {
      cwd: REPO_ROOT,
      timeout: 20_000,
    });
    return { ok: true, abiErr: false, msg: '' };
  } catch (err: any) {
    const msg = `${err?.stderr || err?.message || ''}`.slice(0, 300);
    const abiErr = /NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(msg);
    return { ok: false, abiErr, msg };
  }
}

interface AbiMarker {
  abi: string;
  at: string;
  result: 'ok' | 'failed';
}

async function readAbiMarker(): Promise<AbiMarker | null> {
  try {
    return JSON.parse(await readFile(ABI_MARKER_PATH, 'utf-8')) as AbiMarker;
  } catch {
    return null;
  }
}

async function writeAbiMarker(result: 'ok' | 'failed'): Promise<void> {
  try {
    const m: AbiMarker = { abi: process.versions.modules, at: new Date().toISOString(), result };
    await writeFile(ABI_MARKER_PATH, JSON.stringify(m, null, 2), 'utf-8');
  } catch {
    /* best effort */
  }
}

async function healNativeModule(): Promise<HealAction> {
  const id = 'native-module-abi';
  const abi = process.versions.modules;

  const before = await betterSqliteLoads();
  if (before.ok) {
    // Loads fine — record success so future failed-marker logic stays accurate.
    await writeAbiMarker('ok');
    return { id, detail: `better-sqlite3 loads (Node ABI ${abi})`, outcome: 'noop' };
  }

  if (!before.abiErr) {
    // Fails for a NON-ABI reason (missing module, corrupt install) — rebuild is
    // still the right lever, but report honestly.
    log(`better-sqlite3 load failed (non-ABI): ${before.msg}`);
  } else {
    log(`better-sqlite3 ABI mismatch under Node ${process.version} (ABI ${abi}) — attempting rebuild`);
  }

  // Loop-guard: if we already rebuilt for THIS exact ABI within the cooldown
  // and it still fails, don't rebuild again every run — escalate instead.
  const marker = await readAbiMarker();
  if (
    marker &&
    marker.abi === abi &&
    marker.result === 'failed' &&
    Date.now() - new Date(marker.at).getTime() < ABI_REBUILD_COOLDOWN_MS
  ) {
    return {
      id,
      detail: 'better-sqlite3 rebuild',
      outcome: 'failed',
      note: `rebuild already failed for ABI ${abi} within the last hour — needs manual \`npm rebuild better-sqlite3\` / build tools check`,
    };
  }

  // Rebuild against the running Node, using the npm next to it.
  const npmPath = join(dirname(process.execPath), 'npm');
  const runNpm = async (bin: string) =>
    exec(bin, ['rebuild', 'better-sqlite3'], { cwd: REPO_ROOT, timeout: 180_000 });
  try {
    try {
      await runNpm(npmPath);
    } catch {
      await runNpm('npm'); // fall back to PATH npm
    }
  } catch (err: any) {
    await writeAbiMarker('failed');
    return {
      id,
      detail: 'npm rebuild better-sqlite3',
      outcome: 'failed',
      note: `rebuild failed: ${`${err?.stderr || err?.message || ''}`.slice(0, 120)}`,
    };
  }

  const after = await betterSqliteLoads();
  if (after.ok) {
    await writeAbiMarker('ok');
    log(`rebuilt better-sqlite3 for Node ABI ${abi} — iMessage restored`);
    return { id, detail: 'rebuild better-sqlite3 for current Node ABI', outcome: 'healed', note: `ABI ${abi}` };
  }
  await writeAbiMarker('failed');
  return {
    id,
    detail: 'better-sqlite3 still failing after rebuild',
    outcome: 'failed',
    note: after.msg,
  };
}

// ---------------------------------------------------------------------------
// 6. restage-protected — refresh staged copies of TCC-protected DBs when THIS
//    context can read the originals. Under launchd the wrapper already sources
//    stage-protected.sh before Node; this covers interactive/manual runs and
//    the launchd-with-FDA case, and is a safe no-op when reads are denied.
// ---------------------------------------------------------------------------
const IMESSAGE_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const STAGE_SCRIPT = join(REPO_ROOT, 'stage-protected.sh');
const STAGING_MAX_AGE_MS = 30 * 60 * 1000;

async function restageProtected(): Promise<HealAction> {
  const id = 'restage-protected';
  // Is the staged chat.db already fresh? Then nothing to do.
  try {
    const s = await stat(join(STAGING_DIR, 'chat.db'));
    if (Date.now() - s.mtimeMs <= STAGING_MAX_AGE_MS) {
      return { id, detail: 'staged copies already fresh', outcome: 'noop' };
    }
  } catch {
    /* no staged copy — fall through and try to create one */
  }

  // Can THIS context read a protected original? If not, a node-spawned restage
  // can't help (and under launchd node's subtree is TCC-poisoned anyway).
  let canRead = false;
  try {
    await access(IMESSAGE_DB, fsConstants.R_OK);
    canRead = true;
  } catch {
    canRead = false;
  }
  if (!canRead) {
    return {
      id,
      detail: 'restage skipped — protected originals not readable in this context',
      outcome: 'noop',
      note: 'launchd wrapper stages before Node; nothing for the Node pass to do',
    };
  }

  try {
    await exec('/bin/bash', [STAGE_SCRIPT], { timeout: 60_000 });
    // Verify the restage actually refreshed chat.db.
    const s = await stat(join(STAGING_DIR, 'chat.db'));
    if (Date.now() - s.mtimeMs <= STAGING_MAX_AGE_MS) {
      log('re-staged protected DBs (fresh copies written)');
      return { id, detail: 're-stage protected DBs', outcome: 'healed' };
    }
    return { id, detail: 're-stage produced no fresh copy', outcome: 'failed', note: 'cp likely denied' };
  } catch (err: any) {
    return { id, detail: 'run stage-protected.sh', outcome: 'failed', note: err?.message?.slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// 7. graph-auth — attempt a token refresh and classify the result. This step
//    CANNOT mint a new Azure client secret (portal/admin action, like FDA), so
//    an expired secret reports 'failed' with the correct rotate instruction
//    rather than pretending. A pending pre-expiry warning is surfaced as a note.
// ---------------------------------------------------------------------------
async function healGraphAuth(): Promise<HealAction> {
  const id = 'graph-auth';
  if (!isGraphConfigured()) {
    return { id, detail: 'graph not configured', outcome: 'noop' };
  }
  try {
    // getGraphTokenHealth() triggers a refresh attempt and returns a
    // cause-specific banner ('' when healthy, ⚠️ for pre-expiry, 🛑 for down).
    const banner = await getGraphTokenHealth();
    if (!banner) return { id, detail: 'graph token healthy', outcome: 'noop' };
    if (banner.startsWith('🛑')) {
      // A hard auth failure we can't self-fix (expired secret / dead refresh token).
      return { id, detail: 'graph auth down — needs manual action', outcome: 'failed', note: banner.replace(/^🛑\s*/, '') };
    }
    // ⚠️ pre-expiry warning — auth still works; surface as a heads-up, not a failure.
    return { id, detail: 'graph auth healthy (warning pending)', outcome: 'noop', note: banner.replace(/^⚠️\s*/, '') };
  } catch (err: any) {
    return { id, detail: 'probe graph auth', outcome: 'failed', note: err?.message?.slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all remediations in order. native-module-abi runs before restage so that
 * if iMessage was down purely due to ABI, it's fixed before we bother staging.
 * Never throws.
 */
export async function runSelfHeal(): Promise<SelfHealReport> {
  const actions: HealAction[] = [];
  const steps: Array<() => Promise<HealAction>> = [
    ensureDirs,
    clearStaleLocks,
    pruneOrphanTempDirs,
    repairGraphToken,
    healNativeModule,
    restageProtected,
    healGraphAuth,
  ];

  for (const step of steps) {
    try {
      actions.push(await step());
    } catch (err: any) {
      actions.push({ id: step.name, detail: step.name, outcome: 'failed', note: err?.message?.slice(0, 100) });
    }
  }

  const healed = actions.filter(a => a.outcome === 'healed').map(a => a.id);
  const failed = actions.filter(a => a.outcome === 'failed').map(a => a.id);
  const summary = healed.length
    ? `healed: ${healed.join(', ')}${failed.length ? ` | still failing: ${failed.join(', ')}` : ''}`
    : failed.length
      ? `nothing auto-healed | still failing: ${failed.join(', ')}`
      : 'all clear — nothing to heal';

  log(summary);
  return { actions, healed, failed, summary };
}
