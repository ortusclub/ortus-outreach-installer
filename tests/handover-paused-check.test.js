import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('moving a paused campaign starts no acceptance check on either machine', async () => {
  const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function _startHandoverCheck(');
  const end = source.indexOf('// Both card surfaces repaint', start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  const check = new Function('showCampaignToast', 'fetch', 'cloudCheckLocal', 'cloudCheckNow',
    `${source.slice(start, end)}; return _startHandoverCheck;`)(
    () => {}, () => { calls++; }, () => { calls++; }, () => { calls++; },
  );
  assert.equal(await check('c1', 'local', 'paused', {}), true);
  assert.equal(await check('c1', 'vm', '', { phase: 'paused' }), true);
  assert.equal(calls, 0);
});
