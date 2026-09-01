import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// Operator, 2026-09-01: a campaign whose sending had paused showed
// "vinson.sena 0/50" and "mj.petete 0/50". The engine's own /accounts payload
// said 50/50 (daily limit reached — the REASON it paused) and 15/50 + weekly
// cap. "I might assume that it sent zero connections."
test('the accounts fetch runs while monitoring, not only while running', () => {
  const i = APP.indexOf('const _liveStatus =');
  assert.ok(i > 0, 'the gate moved');
  const gate = APP.slice(i, i + 900);
  const m = gate.match(/const _live = (\[[^\]]*\])\.includes/);
  assert.ok(m, 'the gate is no longer a list of live statuses');
  const states = JSON.parse(m[1].replace(/'/g, '"'));
  for (const st of ['running', 'paused', 'monitoring']) {
    assert.ok(states.includes(st), `${st} must fetch accounts`);
  }
});

test('the placeholder that produced 0/50 is only a fallback', () => {
  const i = APP.indexOf('function _cloudAccountPanel');
  const body = APP.slice(i, i + 1200);
  assert.ok(/snapshot\.length \? snapshot :/.test(body),
    'the real payload must win over the placeholder rows');
  assert.ok(/dailyCount: 0/.test(body), 'the placeholder still exists for a genuinely unknown account');
});

test('the pill number comes from the engine count, not from a tally', () => {
  const VJ = readFileSync(new URL('../public/js/vjcard.mjs', import.meta.url), 'utf8');
  const i = VJ.indexOf('export function acctPillCount');
  const body = VJ.slice(i, i + 400);
  assert.match(body, /Number\(account\.dailyCount\)/);
});
