// statusFromItem is a whitelist, so every new field has to be added by hand or the
// board silently drops it. Yesterday's adaptive-cadence work shipped with exactly
// this bug. A dropped runsOn is worse: the board would show the VM/Mac control in
// its default position on a campaign that is running on the other side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statusFromItem } from '../public/js/vjcard.mjs';

test('runsOn survives the whitelist', () => {
  const s = statusFromItem({ id: 'c1', state: 'monitoring', runsOn: 'local' });
  assert.equal(s.runsOn, 'local');
});

test('a campaign with no runsOn reads as the VM, never as undefined', () => {
  const s = statusFromItem({ id: 'c1', state: 'monitoring' });
  assert.equal(s.runsOn, 'vm',
    'an absent value must not leave the control unrendered or half-lit');
});

// The whitelist half of this bug is easy to fix and easy to re-test. The half
// that actually shipped the bug yesterday was the BOARD's item builder in
// app.js dropping the field before it ever reached statusFromItem — a test
// that only exercises statusFromItem would have passed all through that bug,
// because it hand-builds the item it feeds in rather than reading the real
// builder. Assert on the builder's SOURCE instead (no DOM in this runner —
// see tests/board-tick-selector.test.js for the same pattern), so this fails
// if either push site in _renderCampaignsBoardInner stops carrying runsOn.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(root, 'public/js/app.js'), 'utf8');

function pushBlock(marker) {
  const idx = appJs.indexOf(marker);
  assert.notEqual(idx, -1, `${marker} must exist — the board item builder moved or was renamed`);
  const start = appJs.lastIndexOf('items.push({', idx);
  assert.notEqual(start, -1, `${marker} must be inside an items.push({...}) block`);
  const end = appJs.indexOf('});', idx);
  return appJs.slice(start, end);
}

test("the board's LOCAL running item carries runsOn/handoverAt to statusFromItem", () => {
  const block = pushBlock("id: 'local-active'");
  assert.match(block, /runsOn:\s*s\.runsOn/, 'local board item must forward the local status\'s runsOn, defaulting to local');
  assert.match(block, /handoverAt:\s*s\.handoverAt/);
});

test("the board's CLOUD item carries runsOn/handoverAt to statusFromItem", () => {
  const block = pushBlock("where: 'cloud', id: c.id");
  assert.match(block, /runsOn:\s*c\.runs_on/, 'cloud board item must bridge the engine\'s snake_case runs_on');
  assert.match(block, /handoverAt:\s*c\.handover_at/);
});
