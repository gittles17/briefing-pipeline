import { copyFile, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join, basename } from 'path';

// Staged copies written by stage-protected.sh (sourced by the launchd bash
// wrapper immediately before the pipeline starts). Under launchd, node cannot
// read the protected originals directly — the node binary carries a stale
// per-binary TCC deny that overrides the /bin/bash Full Disk Access grant and
// poisons node's whole subtree (even /bin/cp spawned from node is denied). So
// bash stages the copies first, and we read those.
const STAGING_DIR = join(homedir(), 'briefing-data', 'staging');
// Anything older than this is a leftover from a previous run, not this run's
// staging pass — fall back to the original path (interactive contexts have
// their own FDA and read the originals fine).
const STAGING_MAX_AGE_MS = 30 * 60 * 1000;

/** Return the fresh staged copy of sourcePath, or null if absent/stale. */
async function stagedSourceFor(sourcePath: string): Promise<string | null> {
  try {
    const candidate = join(STAGING_DIR, basename(sourcePath));
    const s = await stat(candidate);
    if (Date.now() - s.mtimeMs > STAGING_MAX_AGE_MS) return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Copy a live macOS user SQLite DB (chat.db, Calendar.sqlitedb, etc.) into a
 * temporary directory so we can read it without contending with the app that's
 * holding WAL/SHM locks. Returns the path to the copied main DB; the caller
 * should call the returned `cleanup` when done to remove the temp directory.
 *
 * Prefers a fresh staged copy (see STAGING_DIR above) over the protected
 * original. Copies the main file plus its -wal and -shm sidecars when present.
 * Missing sidecars are not an error — they're only there when SQLite has
 * uncommitted journal data.
 */
export async function copyDbForReading(
  sourcePath: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const staged = await stagedSourceFor(sourcePath);
  const src = staged ?? sourcePath;
  if (staged) console.log(`[db-copy] using staged copy for ${basename(sourcePath)}`);

  const dir = await mkdtemp(join(tmpdir(), 'brief-db-'));
  const name = basename(sourcePath);
  const dest = join(dir, name);

  await copyFile(src, dest);
  for (const suffix of ['-wal', '-shm']) {
    try { await copyFile(`${src}${suffix}`, `${dest}${suffix}`); } catch {}
  }

  return {
    path: dest,
    cleanup: async () => { try { await rm(dir, { recursive: true, force: true }); } catch {} },
  };
}
