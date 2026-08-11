/**
 * Reply-engine heartbeat.
 *
 * The reply-engine lives in a separate repo (~/Desktop/Create/Reply/) and runs
 * under launchd. Brief had no integration with it, so the briefing kept asking
 * Jonathan to "manually verify it's firing." This source surfaces three signals
 * the assembler can use:
 *
 *   - launchd PID + exit code (is it currently running?)
 *   - Log file mtime (when did it last write?)
 *   - Tail of the log (any recent errors? paused?)
 */

import { stat, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const LOG_PATH = '/Users/jonathan.gitlin/Desktop/Create/Reply/reply-engine.log';
const SERVICE_NAME = 'com.create.reply-engine';

export async function fetchReplyEngineStatus(): Promise<string> {
  const lines: string[] = [];

  // 1. launchd status
  let pid: string | null = null;
  let exitCode: string | null = null;
  try {
    const { stdout } = await exec('launchctl', ['list', SERVICE_NAME], { timeout: 5000 });
    // Format: <plist with PID and LastExitStatus> — but `launchctl list <name>` returns plist text
    const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
    const exitMatch = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    pid = pidMatch?.[1] ?? null;
    exitCode = exitMatch?.[1] ?? null;
  } catch {
    // Fallback: short-form `launchctl list | grep`
    try {
      const { stdout } = await exec('bash', ['-c', `launchctl list | grep ${SERVICE_NAME} || true`], { timeout: 5000 });
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 3) {
        pid = parts[0] === '-' ? null : parts[0];
        exitCode = parts[1];
      }
    } catch {}
  }

  if (pid === null && exitCode === null) {
    lines.push('Reply-engine: NOT REGISTERED with launchd');
  } else if (pid === null) {
    lines.push(`Reply-engine: ⚠️ NOT RUNNING (last exit code: ${exitCode})`);
  } else {
    lines.push(`Reply-engine: ✓ running (PID ${pid}, last exit: ${exitCode ?? '?'})`);
  }

  // 2. Log mtime + tail
  try {
    const s = await stat(LOG_PATH);
    const ageMin = (Date.now() - s.mtimeMs) / 60000;
    const ageStr = ageMin < 60
      ? `${Math.round(ageMin)}m ago`
      : ageMin < 1440
        ? `${(ageMin / 60).toFixed(1)}h ago`
        : `${(ageMin / 1440).toFixed(1)}d ago`;
    const fresh = ageMin < 60 ? '✓ recent' : ageMin < 1440 ? '⚠️ stale' : '🛑 very stale';
    lines.push(`Last log write: ${ageStr} ${fresh}`);

    // Tail the last ~2KB of the log — works even on huge log files
    try {
      const { stdout } = await exec('tail', ['-c', '2048', LOG_PATH], { timeout: 5000 });
      const tailLines = stdout.trim().split('\n').slice(-6).filter(l => l.trim());
      // Look for paused / error markers
      const tailText = tailLines.join(' ').toLowerCase();
      if (tailText.includes('paused') || tailText.includes('pause flag')) {
        lines.push('Status: 🛑 PAUSED (pause flag detected in log) — run `npm run resume` in Reply repo');
      } else if (tailText.includes('error') || tailText.includes('failed') || tailText.includes('bad request')) {
        lines.push('Status: ⚠️ recent ERROR in log — investigate');
      }
      if (tailLines.length > 0) {
        lines.push(`Recent log:\n  ${tailLines.slice(-3).join('\n  ').slice(0, 400)}`);
      }
    } catch {}
  } catch {
    lines.push(`Last log write: 🛑 log file missing at ${LOG_PATH}`);
  }

  return lines.join('\n');
}
