import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestReadback } from '../public/js/manifest-readback.mjs';

const BASE = {
  mode: 'connect_and_introduce', primaryName: 'Antonio Varlese',
  primarySource: 'local-browser', autoAcceptPrimary: true, autoAcceptAllPending: false,
  primaryCheckTiming: 'after_connections', checkCadenceMinutes: 60, autoChecksEnabled: true,
  followUpEnabled: true, followUpDelayMinutes: 10, runTarget: 'local',
};

test('standard CC+IC renders three ✓ lines and STANDARD state', () => {
  const r = buildManifestReadback(BASE);
  assert.equal(r.state, 'standard');
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.every((l) => l.on));
  assert.match(r.lines[0].html, /Antonio Varlese/);
  assert.match(r.lines[0].html, /local browser/i);
  assert.equal(r.cloudNotice, null);
});

test('follow-up off → third line off with "No automated follow-up"', () => {
  const r = buildManifestReadback({ ...BASE, followUpEnabled: false });
  assert.equal(r.state, 'customized');
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, false);
  assert.match(fu.html, /No automated follow-up/i);
});

test('accept-all on → appended to line 1 + customized', () => {
  const r = buildManifestReadback({ ...BASE, autoAcceptAllPending: true });
  assert.equal(r.state, 'customized');
  assert.match(r.lines[0].html, /all other pending/i);
});

test('cloud + local primary → follow-up replaced by handshake line + cloudNotice set', () => {
  const r = buildManifestReadback({ ...BASE, runTarget: 'cloud' });
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, false);
  assert.match(fu.html, /Your Mac accepts once/i);
  assert.ok(r.cloudNotice && /follow-up is off/i.test(r.cloudNotice));
});

test('cloud + GoLogin primary → no handshake downgrade, follow-up stays', () => {
  const r = buildManifestReadback({ ...BASE, runTarget: 'cloud', primarySource: 'gl_abc123' });
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, true);
  assert.match(fu.html, /follow-up/i);
  assert.equal(r.cloudNotice, null);
});

test('introduce_back → identity only, zero readback lines', () => {
  const r = buildManifestReadback({ ...BASE, mode: 'introduce_back' });
  assert.equal(r.lines.length, 0);
});

test('connect_and_message → cadence line only, no accept/follow-up', () => {
  const r = buildManifestReadback({ ...BASE, mode: 'connect_and_message' });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].key, 'cadence');
});
