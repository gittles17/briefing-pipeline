/**
 * withTimeout — race a promise against a wall-clock deadline.
 *
 * WHY THIS EXISTS: some source fetches shell out to `osascript` against Apple
 * Mail / Reminders. When the target app is hung or showing a modal, the
 * osascript child blocks in a synchronous Apple Event that IGNORES SIGTERM —
 * so `execFile`'s own `timeout` fires, fails to kill the child, and the promise
 * NEVER settles. In a `Promise.allSettled` batch that means ONE stuck source
 * freezes the entire briefing indefinitely (observed: an 8-hour hang).
 *
 * This wrapper guarantees the caller gets an answer within `ms` regardless of
 * whether the underlying work ever finishes. The orphaned child may linger, but
 * the pipeline moves on and the source degrades to its normal fallback via the
 * existing allSettled `status === 'rejected'` handling.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'source'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
