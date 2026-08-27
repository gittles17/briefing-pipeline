/**
 * redaction.test.ts — assertions for the secret-redaction pass that scrubs
 * Cursor transcript text before it reaches the LLM or a committed PR
 * (src/sources/cursor-transcripts.ts → redact).
 *
 * This repo has no test framework, so this runs directly under tsx and exits
 * non-zero if any case fails:
 *
 *   npm run test:redaction
 */

import { strict as assert } from 'node:assert';
import { redact } from './sources/cursor-transcripts';

const REDACTED = '[redacted]';
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err: any) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) });
  }
}

// --- secrets that MUST be scrubbed -----------------------------------------

check('OpenAI sk- key', () => {
  const out = redact('the key is sk-abcdefghijklmnopqrstuvwxyz0123 ok').text;
  assert.ok(!out.includes('sk-abcdefghijklmnop'), out);
  assert.ok(out.includes(REDACTED), out);
});

check('Anthropic sk-ant- key', () => {
  const out = redact('use sk-ant-api03-AbCdEf0123456789_ghijklmnopq here').text;
  assert.ok(!out.includes('sk-ant-api03'), out);
  assert.ok(out.includes(REDACTED), out);
});

check('GitHub ghp_ token', () => {
  const out = redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 set').text;
  assert.ok(!out.includes('ghp_ABCDEF'), out);
});

check('GitHub gho_ token', () => {
  const out = redact('creds gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ok').text;
  assert.ok(!out.includes('gho_ABCDEF'), out);
});

check('GitHub fine-grained github_pat_ token', () => {
  const out = redact('github_pat_11ABCDEFG0123456789abcdefghijQ done').text;
  assert.ok(!out.includes('github_pat_11ABCDEFG'), out);
});

check('AWS AKIA access key id', () => {
  const out = redact('aws key AKIAIOSFODNN7EXAMPLE rotated').text;
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), out);
  assert.ok(out.includes(REDACTED), out);
});

check('JWT triplet', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const out = redact(`session ${jwt} expired`).text;
  assert.ok(!out.includes('eyJhbGci'), out);
  assert.ok(out.includes(REDACTED), out);
});

check('Bearer token keeps label, redacts token', () => {
  const out = redact('Authorization: Bearer abcdef.ghijkl.mnopqrstuv').text;
  assert.equal(out, 'Authorization: Bearer [redacted]');
});

check('URL with embedded credentials keeps scheme + host', () => {
  const out = redact('conn postgres://admin:sup3rSecret@db.example.com:5432/app').text;
  assert.equal(out, 'conn postgres://[redacted]@db.example.com:5432/app');
});

check('DATABASE_URL assignment redacts value', () => {
  const out = redact('DATABASE_URL=postgres://u:p@host:5432/db here').text;
  assert.ok(out.startsWith('DATABASE_URL=[redacted]'), out);
  assert.ok(!out.includes('postgres://u:p@host'), out);
});

check('quoted API_KEY assignment redacts value + quotes', () => {
  const out = redact('API_KEY="abcd1234efgh5678" loaded').text;
  assert.equal(out, 'API_KEY=[redacted] loaded');
});

check('key containing SECRET redacts value', () => {
  const out = redact('MY_SECRET=hunter2wowsecret next').text;
  assert.equal(out, 'MY_SECRET=[redacted] next');
});

check('key containing TOKEN with colon redacts value', () => {
  const out = redact('AUTH_TOKEN: xyz123abc456 done').text;
  assert.equal(out, 'AUTH_TOKEN: [redacted] done');
});

check('key containing PASSWORD redacts value', () => {
  const out = redact('DB_PASSWORD=p@ssw0rd!value ok').text;
  assert.equal(out, 'DB_PASSWORD=[redacted] ok');
});

check('_KEY-suffixed names redact short values', () => {
  for (const s of ['ENCRYPTION_KEY=short1', 'SIGNING_KEY: shortkey123abcdefghij', 'MASTER_KEY=short1', 'SESSION_KEY=abc123']) {
    const out = redact(`${s} ok`).text;
    assert.ok(out.includes(REDACTED), `${s} -> ${out}`);
    assert.ok(!out.includes(s.split(/[:=]\s*/)[1]), `${s} -> ${out}`);
  }
});

check('_KEY mid-name still redacts (trailing wildcard preserved)', () => {
  const out = redact('API_KEY_PROD=abc123def next').text;
  assert.equal(out, 'API_KEY_PROD=[redacted] next');
});

check('KEY without underscore is untouched (MONKEY/TURKEY safe)', () => {
  const s = 'MONKEY=banana and TURKEY=dinner are fine';
  const r = redact(s);
  assert.equal(r.text, s);
  assert.equal(r.redactedChars, 0);
});

check('long base64 run (>=40) redacted', () => {
  const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw';
  assert.ok(blob.length >= 40);
  const out = redact(`blob ${blob} end`).text;
  assert.ok(!out.includes(blob), out);
  assert.ok(out.includes(REDACTED), out);
});

check('long hex run (>=40) redacted', () => {
  const hex = 'a3f5b2'.repeat(8).slice(0, 40); // 40 hex chars
  assert.equal(hex.length, 40);
  const out = redact(`sha ${hex} committed`).text;
  assert.ok(!out.includes(hex), out);
});

check('multiple secrets collapse, benign text preserved', () => {
  const s = `a sk-${'A'.repeat(20)} and ghp_${'B'.repeat(30)}`;
  assert.equal(redact(s).text, 'a [redacted] and [redacted]');
});

// --- benign text that must NOT be touched (correction signal must survive) --

check('correction words untouched', () => {
  const s = "No, that's wrong — please revert your change";
  const r = redact(s);
  assert.equal(r.text, s);
  assert.equal(r.redactedChars, 0);
});

check('frustration words untouched', () => {
  const s = 'undo that and stop, you broke the build again';
  const r = redact(s);
  assert.equal(r.text, s);
  assert.equal(r.redactedChars, 0);
});

check('short hash (<40) and plain URL untouched', () => {
  const s = 'commit a3f5b2 on https://github.com/CREATE-LA/AurisFilmSeries looks fine';
  const r = redact(s);
  assert.equal(r.text, s);
  assert.equal(r.redactedChars, 0);
});

check('empty string is safe', () => {
  const r = redact('');
  assert.equal(r.text, '');
  assert.equal(r.redactedChars, 0);
});

// --- redactedChars powers the ">50% ⇒ drop candidate" decision --------------

check('mostly-secret text reports >50% redacted', () => {
  const s = `sk-${'A'.repeat(60)}`;
  const r = redact(s);
  assert.ok(r.redactedChars / s.length > 0.5, `fraction=${r.redactedChars / s.length}`);
});

check('mostly-prose text reports <50% redacted', () => {
  const s = `please fix the failing test, the key was sk-${'A'.repeat(20)} but ignore that`;
  const r = redact(s);
  assert.ok(r.redactedChars / s.length < 0.5, `fraction=${r.redactedChars / s.length}`);
  assert.ok(r.redactedChars > 0, 'expected some redaction');
});

// --- report -----------------------------------------------------------------

const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
console.log(`\nredaction.test: ${results.length - failed.length}/${results.length} passed`);

if (failed.length > 0) {
  process.exit(1);
}
