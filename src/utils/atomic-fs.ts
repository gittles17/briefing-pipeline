/**
 * Shared atomic filesystem helpers.
 *
 * The Brief pipeline writes to several files that are also touched by other
 * processes (Reply repo, maintenance subprocess, concurrent morning/afternoon
 * runs). Without atomic writes, concurrent writers race and produce
 * partially-written or merged-content files (which is exactly how the
 * graph-tokens.json `}\n}` corruption snuck in).
 *
 * Two primitives:
 *   - atomicWrite(path, content)      — atomic full-file replace via temp+rename
 *   - withFileLock(path, fn)           — directory-based mutex for read-modify-write
 *
 * Both use only fs/promises — no native dependencies.
 */

import { writeFile, rename, unlink, mkdir, rmdir, stat } from 'fs/promises';

/**
 * Write content to `path` atomically. Strategy: write to a unique temp file
 * (PID + timestamp) then `rename()` over the target. POSIX guarantees rename
 * is atomic, so concurrent writers can never observe a partially-written file.
 *
 * For JSON content, callers should serialize via JSON.stringify themselves
 * and ideally pre-validate (round-trip JSON.parse) before passing to this.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content, 'utf-8');
  try {
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Acquire a mutex on `path` for the duration of `fn()`, then release.
 * Uses a sibling `<path>.lock/` directory because mkdir is atomic on POSIX.
 *
 * If a stale lock from a crashed process is older than `staleMs`, it is
 * force-removed (locks shouldn't be held across runs).
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lockDir = path + '.lock';
  const retries = opts.retries ?? 50;
  const delayMs = opts.delayMs ?? 100;
  const staleMs = opts.staleMs ?? 60_000;

  let acquired = false;
  for (let i = 0; i < retries; i++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      // Stale-lock cleanup
      try {
        const s = await stat(lockDir);
        if (Date.now() - s.mtimeMs > staleMs) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  if (!acquired) {
    throw new Error(`failed to acquire lock on ${path} after ${retries} retries`);
  }

  try {
    return await fn();
  } finally {
    try { await rmdir(lockDir); } catch {}
  }
}
