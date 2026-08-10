/**
 * heal.ts — run the self-heal pass on demand.
 *
 *   npm run heal        (or: npx tsx src/heal.ts)
 *
 * Prints each remediation's outcome and exits 0 if nothing is still failing,
 * else 1. The pipeline runs this same pass automatically at the start of every
 * briefing; this CLI is for manual/ad-hoc repair and verification.
 */

import { config } from 'dotenv';
config({ override: true });
import { runSelfHeal } from './sources/self-heal';

async function main(): Promise<void> {
  console.log('Self-heal — repairing briefing environment...\n');
  const report = await runSelfHeal();

  for (const a of report.actions) {
    const mark = a.outcome === 'healed' ? '✓ FIXED ' : a.outcome === 'failed' ? '✗ FAILED' : '· ok    ';
    console.log(`  ${mark}  ${a.detail}${a.note ? `  — ${a.note}` : ''}`);
  }
  console.log('');
  console.log(`Summary: ${report.summary}`);

  process.exit(report.failed.length ? 1 : 0);
}

main().catch((err: any) => {
  console.log(`heal encountered an unexpected error: ${err?.message?.slice(0, 120) || 'unknown'}`);
  process.exit(1);
});
