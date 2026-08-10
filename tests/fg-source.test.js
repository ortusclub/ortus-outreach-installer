import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fgActiveDoor, fgActivePayload } from '../public/js/fg-source.mjs';

const URL_ = 'https://docs.google.com/spreadsheets/d/abc/edit';

// [stored state, expected door]
const cases = [
  ['activeDoor build is honoured', { activeDoor: 'build', sheetUrl: URL_, tab: 'TAB_X' }, 'build'],
  ['activeDoor have is honoured', { activeDoor: 'have', sheetUrl: URL_, tab: 'TAB_X' }, 'have'],
  // Legacy storage — written before activeDoor existed. Tab-only is exactly
  // what "Build one for me" left behind; defaulting it to 'have' showed an
  // empty URL box and refused to launch a list the operator already had.
  ['legacy tab only infers build', { tab: 'TAB_X' }, 'build'],
  ['legacy sheetUrl only stays have', { sheetUrl: URL_ }, 'have'],
  ['legacy both stays have', { sheetUrl: URL_, tab: 'TAB_X' }, 'have'],
  ['fresh install stays have', {}, 'have'],
  ['garbage activeDoor falls back', { activeDoor: 'nonsense', tab: 'TAB_X' }, 'build'],
];

for (const [name, saved, door] of cases) {
  test(`fgActiveDoor: ${name}`, () => {
    assert.equal(fgActiveDoor(saved), door);
  });

  test(`fgActivePayload sends only the active door's value: ${name}`, () => {
    const p = fgActivePayload(saved);
    if (door === 'build') {
      assert.deepEqual(p, { sheetUrl: '', tab: saved.tab || '' });
    } else {
      assert.deepEqual(p, { sheetUrl: saved.sheetUrl || '', tab: '' });
    }
    // Never both — the server gives sheetUrl precedence over tab, so two
    // non-empty fields would let it silently contradict the visible door.
    assert.ok(!(p.sheetUrl && p.tab), 'only one field may be non-empty');
  });
}
