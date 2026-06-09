/**
 * check-access.ts
 * Verify that Full Disk Access (TCC) is granted for the local data sources the
 * briefing pipeline reads (Reminders, iMessage/chat.db, local Calendar.sqlitedb).
 *
 * Run manually:  npm run check-access   (or: npx tsx src/check-access.ts)
 *
 * IMPORTANT NUANCE: this command probes access IN THE CURRENT (Terminal) PROCESS
 * CONTEXT — which usually ALREADY has Full Disk Access. So it may show all ✅
 * even while the *scheduled launchd* job is still denied. The authoritative
 * signal is the next briefing run: if the 🛑 banner / alert email clears, the
 * grant worked.
 *
 * This script never throws — any internal failure is reported, not raised.
 * Exit code: 0 if every source is ✅ in the current context, else 1.
 */

import { exec } from 'child_process';
import { probeProtectedAccess, type ProbeResult } from './sources/local-health';

/** Best-effort: open the macOS Full Disk Access settings pane. Ignores errors. */
function openFullDiskAccessPane(): void {
  try {
    exec(
      'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
      () => {
        /* best-effort; ignore any error */
      },
    );
  } catch {
    /* ignore */
  }
}

function statusLine(label: string, state: 'ok' | 'denied'): string {
  const padded = label.padEnd(11, ' ');
  if (state === 'ok') {
    return `${padded}: ✅ readable`;
  }
  return `${padded}: ❌ DENIED — Full Disk Access not granted to this context`;
}

async function main(): Promise<void> {
  console.log('Full Disk Access check — probing local data sources...');
  console.log('');

  let probe: ProbeResult;
  try {
    probe = await probeProtectedAccess();
  } catch (err: any) {
    // probeProtectedAccess is designed to never throw, but stay defensive.
    console.log(
      `Could not run access probe: ${err?.message?.slice(0, 120) || 'unknown error'}`,
    );
    probe = { reminders: 'denied', imessage: 'denied', calendar: 'denied' };
  }

  console.log(statusLine('Reminders', probe.reminders));
  console.log(statusLine('iMessage', probe.imessage)); // chat.db
  console.log(statusLine('Calendar', probe.calendar)); // local Calendar.sqlitedb
  console.log('');

  const allOk =
    probe.reminders === 'ok' &&
    probe.imessage === 'ok' &&
    probe.calendar === 'ok';

  // Open the settings pane for convenience (best-effort, non-blocking).
  openFullDiskAccessPane();

  console.log('────────────────────────────────────────────────────────────');
  console.log('IMPORTANT — what this check does and does NOT prove:');
  console.log('');
  console.log('  This tests the CURRENT (Terminal) context, which usually');
  console.log('  ALREADY has Full Disk Access. So you may see all ✅ here');
  console.log('  while the *scheduled launchd* job is still DENIED.');
  console.log('');
  console.log('  The authoritative signal is the NEXT briefing run: if the');
  console.log('  🛑 banner at the top of the brief (and the alert email)');
  console.log('  clears, the grant worked.');
  console.log('');
  console.log('  The grant target is /bin/bash — the launchd jobs run');
  console.log('  /bin/bash -c "...tsx...". Grant Full Disk Access to');
  console.log('  /bin/bash in System Settings → Privacy & Security →');
  console.log('  Full Disk Access (use Cmd+Shift+G to navigate to /bin/bash).');
  console.log('  Granting to /bin/bash is stable across `brew upgrade node`.');
  console.log('────────────────────────────────────────────────────────────');
  console.log('');

  if (allOk) {
    console.log('Result: ✅ All sources readable in this (Terminal) context.');
  } else {
    console.log('Result: ❌ One or more sources DENIED in this context.');
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err: any) => {
  // Final safety net — should never reach here.
  console.log(
    `check-access encountered an unexpected error: ${err?.message?.slice(0, 120) || 'unknown'}`,
  );
  process.exit(1);
});
