import { test } from 'node:test';
import assert from 'node:assert/strict';

import { degreeToConnected, primaryConnState, normalizePrimaryUrl, classifyConnectError } from '../src/linkedin/primary-connection.js';
import { _shouldHoldIntros } from '../src/linkedin/auto-intro.js';

// ─────────────────────────────────────────────────────────────────────────
// 2026-06-15 incident (Sam): a CC+IC run badged nearly EVERY account "NO
// PRIMARY" and fired no introductions — including accounts genuinely connected
// to the primary. Root cause: when the degree read failed (Voyager 429 under a
// rate-limited session, and/or an encoded /in/ACwAA… primary URL whose publicId
// Voyager can't resolve and whose slug the DOM-badge fallback rejects),
// readPrimaryDegree returned 'unknown' → checkAndConnectPrimary coerced that to
// connected:false → 'pending' → "No primary" badge + a connect fired at the
// primary + intros held. A READ FAILURE was indistinguishable from a confirmed
// non-connection.
//
// The fix distinguishes the three cases. These pure helpers carry that logic.
// ─────────────────────────────────────────────────────────────────────────

// ── degreeToConnected: 1st => true, confirmed 2nd/3rd => false, anything we
//    couldn't read => null (NOT false) ──
test('degreeToConnected: 1st-degree is connected', () => {
  assert.equal(degreeToConnected('1st'), true);
  assert.equal(degreeToConnected('self'), true);
});

test('degreeToConnected: a CONFIRMED 2nd/3rd is genuinely not connected', () => {
  assert.equal(degreeToConnected('2nd'), false);
  assert.equal(degreeToConnected('3rd'), false);
});

test('degreeToConnected: an unreadable degree is null (couldn\'t determine), NOT false', () => {
  // This is the whole fix: 'unknown' must not masquerade as "definitely not connected".
  assert.equal(degreeToConnected('unknown'), null);
  assert.equal(degreeToConnected(''), null);
  assert.equal(degreeToConnected(null), null);
  assert.equal(degreeToConnected(undefined), null);
});

// ── primaryConnState: maps the connected tri-state to the per-account status
//    the UI badge + intro gate read ──
test('primaryConnState: connected => "connected"', () => {
  assert.equal(primaryConnState(true), 'connected');
});

test('primaryConnState: confirmed not-connected => "pending" (badge + connect sent)', () => {
  assert.equal(primaryConnState(false), 'pending');
});

test('primaryConnState: unreadable => "unverified" (distinct from pending — no connect, no scary badge)', () => {
  assert.equal(primaryConnState(null), 'unverified');
  assert.equal(primaryConnState(undefined), 'unverified');
});

// ── normalizePrimaryUrl: a Sales-Nav primary URL must be rewritten to /in/ so
//    getVoyagerDegree can extract a publicId; vanity + encoded /in/ pass through
//    (LinkedIn redirects encoded ones on navigation). ──
test('normalizePrimaryUrl: rewrites /sales/lead/<urn> to /in/<urn>', () => {
  assert.equal(
    normalizePrimaryUrl('https://www.linkedin.com/sales/lead/ACwAAAvephwBEn2Cp1fWf9V7IoCZUXIlIsFLlsc'),
    'https://www.linkedin.com/in/ACwAAAvephwBEn2Cp1fWf9V7IoCZUXIlIsFLlsc',
  );
});

test('normalizePrimaryUrl: leaves a vanity /in/ URL unchanged', () => {
  assert.equal(normalizePrimaryUrl('https://www.linkedin.com/in/john-roman/'), 'https://www.linkedin.com/in/john-roman/');
});

test('normalizePrimaryUrl: leaves an encoded /in/ACwAA… URL unchanged (LinkedIn redirects it)', () => {
  const enc = 'https://www.linkedin.com/in/ACwAAAvephwBEn2Cp1fWf9V7IoCZUXIlIsFLlsc';
  assert.equal(normalizePrimaryUrl(enc), enc);
});

test('normalizePrimaryUrl: trims, tolerates empty/garbage', () => {
  assert.equal(normalizePrimaryUrl('  https://www.linkedin.com/in/x  '), 'https://www.linkedin.com/in/x');
  assert.equal(normalizePrimaryUrl(''), '');
  assert.equal(normalizePrimaryUrl(null), '');
  assert.equal(normalizePrimaryUrl(undefined), '');
});

// ── _shouldHoldIntros: the activated path. A read-failure (connected:null) must
//    NOT hold intros (let the self-validating intro attempt decide), while a
//    CONFIRMED non-connection still holds. ──
test('_shouldHoldIntros: a read-failure (connected:null) does NOT hold intros', () => {
  // The incident regression: this used to be connected:false → held everything.
  assert.equal(_shouldHoldIntros({ connected: null, degree: 'unknown' }), false);
});

test('_shouldHoldIntros: a CONFIRMED not-connected (connected:false) still holds', () => {
  assert.equal(_shouldHoldIntros({ connected: false, degree: '2nd' }), true);
});

test('_shouldHoldIntros: connected (1st) proceeds', () => {
  assert.equal(_shouldHoldIntros({ connected: true, degree: '1st' }), false);
});

// ── classifyConnectError: when sendConnectionRequest throws, distinguish "an
//    invite to the primary is ALREADY pending" (a pending invite the primary can
//    still accept) from a genuine send failure (nothing pending to accept). The
//    'already_pending' verdict is what lets the pre-flight handshake auto-accept
//    a request the account sent in a PRIOR run that was never accepted. ──
test('classifyConnectError: INVITATION_ALREADY_PENDING => already_pending', () => {
  assert.equal(classifyConnectError('INVITATION_ALREADY_PENDING'), 'already_pending');
});

test('classifyConnectError: any other error => failed', () => {
  assert.equal(classifyConnectError('Connect button not found'), 'failed');
  assert.equal(classifyConnectError('Navigation timeout'), 'failed');
  assert.equal(classifyConnectError(''), 'failed');
  assert.equal(classifyConnectError(undefined), 'failed');
});
