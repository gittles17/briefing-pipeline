/**
 * Shared validity rule for the staged copies of TCC-protected stores
 * (chat.db, Calendar.sqlitedb, the Reminders stores) that `stage-protected.sh`
 * writes into ~/briefing-data/staging before the pipeline starts.
 *
 * WHY THIS EXISTS — the bug it kills:
 * Every consumer used to apply its own `Date.now() - mtime <= 30 min` gate, with
 * the constant duplicated in four places. That is a RACE, not a freshness check.
 * The launchd wrapper stages the copies once, immediately before node boots, and
 * launchd will not start another instance while one is running — so on any run
 * that takes longer than 30 minutes the copies "expire" MID-RUN even though they
 * are exactly the snapshot this run was given. Consumers then fall back to the
 * protected originals, which node cannot read under launchd BY DESIGN (a stale
 * per-binary TCC deny on the node binary overrides the /bin/bash FDA grant —
 * that is the entire reason staging exists). The result was a cascade of EPERM
 * "denied" probes and a 🛑 banner blaming Full Disk Access on a run whose data
 * had actually loaded fine. Observed 2026-08-14: a 40-minute run (stalled
 * assembler call) tripped this and alerted on all three sources at once.
 *
 * THE RULE: a staged copy is valid if it was written for THIS run — i.e. at or
 * after this process started (minus slack, since the wrapper stages just before
 * node boots). Such a copy stays valid for the whole run no matter how long the
 * run takes. The wall-clock window is kept only as a secondary allowance for
 * long-lived or interactive contexts where staging legitimately happened earlier.
 */

/** Epoch ms at which this node process started. */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

/**
 * Slack before process start that still counts as "this run": the bash wrapper
 * sources stage-protected.sh and then spawns `npx tsx`, so the copies predate
 * node's start by however long npm/tsx took to boot.
 */
const RUN_SLACK_MS = 5 * 60 * 1000;

/** Secondary wall-clock allowance for interactive / long-lived processes. */
const RECENT_MAX_AGE_MS = 30 * 60 * 1000;

/** True if a staged copy with this mtime is usable for the current run. */
export function isStagedCopyValid(mtimeMs: number): boolean {
  // Staged for this run — valid for the entire run, however long it lasts.
  if (mtimeMs >= PROCESS_START_MS - RUN_SLACK_MS) return true;
  // Otherwise fall back to "staged recently" (interactive runs, repeat reads).
  return Date.now() - mtimeMs <= RECENT_MAX_AGE_MS;
}

/** Human-readable age of a staged copy, for logs. */
export function stagedAgeLabel(mtimeMs: number): string {
  const mins = Math.round((Date.now() - mtimeMs) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
