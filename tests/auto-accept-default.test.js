// Auto-accept the primary's invitation is ON by default (operator, 2026-08-27).
// The accept-ALL sub-toggle stays OFF: it accepts every pending invite in the
// primary's inbox, strangers included, and its own hint says to leave it off.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const app = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

const tagFor = (id) => {
  const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  assert.ok(m, `${id} input not found`);
  return m[0];
};

test('the primary auto-accept box ships checked, with its intent seeded', () => {
  const tag = tagFor('auto-accept-toggle');
  assert.match(tag, /\schecked\b/);
  assert.match(tag, /data-wanted="1"/);
});

test('accept-ALL-pending stays off by default', () => {
  assert.doesNotMatch(tagFor('auto-accept-all-toggle'), /\schecked\b/);
});

// The gate blanks `checked` whenever no primary URL is set, so the default has
// to be re-applied from the remembered intent once the control is usable —
// otherwise it is lost on the wizard's very first render.
function gate({ hasUrl, checked, disabled, wanted }) {
  const toggle = { checked, disabled, dataset: wanted === undefined ? {} : { wanted } };
  if (hasUrl && !toggle.disabled) toggle.dataset.wanted = toggle.checked ? '1' : '0';
  toggle.disabled = !hasUrl;
  toggle.checked = hasUrl ? toggle.dataset.wanted !== '0' : false;
  return toggle;
}

test('typing a primary URL turns it on, and an explicit off survives', () => {
  // First render, no URL yet: blanked but the intent is kept.
  const blank = gate({ hasUrl: false, checked: true, disabled: true, wanted: '1' });
  assert.equal(blank.checked, false);
  assert.equal(blank.dataset.wanted, '1');

  // URL arrives: default applied.
  const on = gate({ hasUrl: true, checked: false, disabled: true, wanted: '1' });
  assert.equal(on.checked, true);

  // Operator switches it off: the change handler re-runs the gate.
  const off = gate({ hasUrl: true, checked: false, disabled: false, wanted: '1' });
  assert.equal(off.checked, false, 'an explicit off must not be re-enabled');
  assert.equal(off.dataset.wanted, '0');

  // Clearing then retyping the URL keeps that off.
  const cleared = gate({ hasUrl: false, checked: false, disabled: false, wanted: '0' });
  const retyped = gate({ hasUrl: true, checked: false, disabled: true, wanted: cleared.dataset.wanted });
  assert.equal(retyped.checked, false);
});

test('a saved campaign outranks the default', () => {
  assert.match(app, /_aaEl\.dataset\.wanted = t\.autoAcceptPrimary \? '1' : '0';/);
});
