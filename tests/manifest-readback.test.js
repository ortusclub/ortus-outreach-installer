import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestReadback } from '../public/js/manifest-readback.mjs';

const BASE = {
  mode: 'connect_and_introduce', primaryName: 'Antonio Varlese',
  primarySource: '', autoAcceptPrimary: true, autoAcceptAllPending: false,
  primaryCheckTiming: 'after_connections', checkCadenceMinutes: 360, autoChecksEnabled: true,
  followUpEnabled: true, followUpDelayMinutes: 10, runTarget: 'local',
};

test('standard CC+IC renders three ✓ lines and STANDARD state', () => {
  const r = buildManifestReadback(BASE);
  assert.equal(r.state, 'standard');
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.every((l) => l.on));
  assert.match(r.lines[0].html, /Antonio Varlese/);
  assert.match(r.lines[0].html, /GoLogin profile/i);
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
  assert.match(fu.html, /Choose.*GoLogin profile/i);
  assert.match(r.cloudNotice, /accept connections manually/i);
});

test('manual primary retains introduction checks while primary automation is off', () => {
  const r = buildManifestReadback({ ...BASE, runTarget: 'cloud', primarySource: '', autoAcceptPrimary: false, followUpEnabled: false });
  assert.equal(r.lines.find(l => l.key === 'accept').on, false);
  assert.equal(r.lines.find(l => l.key === 'followup').on, false);
  const cadence = r.lines.find(l => l.key === 'cadence');
  assert.equal(cadence.on, true);
  assert.match(cadence.html, /intros fire/);
  assert.match(r.cloudNotice, /Introductions can use the primary’s name and URL/);
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

test('empty input () is consistent — standard AND renders default "on" lines', () => {
  const r = buildManifestReadback();
  assert.equal(r.state, 'standard');
  const accept = r.lines.find((l) => l.key === 'accept');
  assert.equal(accept.on, true);
  const cad = r.lines.find((l) => l.key === 'cadence');
  assert.match(cad.html, /every 6 hours/);        // no "every  min" glitch
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, true);
});

test('string-typed cadence "360" is still STANDARD (DOM <select>.value is a string)', () => {
  const r = buildManifestReadback({ mode: 'connect_and_introduce', checkCadenceMinutes: '360', followUpDelayMinutes: '10' });
  assert.equal(r.state, 'standard');
});

test('cloud + local primary on a mode with no follow-up line → no cloudNotice', () => {
  const ccdm = buildManifestReadback({ mode: 'connect_and_message', runTarget: 'cloud', primarySource: '' });
  assert.equal(ccdm.cloudNotice, null);
  assert.equal(ccdm.lines.length, 1);
  const icb = buildManifestReadback({ mode: 'introduce_back', runTarget: 'cloud', primarySource: '' });
  assert.equal(icb.cloudNotice, null);
});
