import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyConnectIdentity, readSourceMemberId } from '../src/profile-identity.js';

// Real data from the 2026-06-08 connect_and_introduce campaign that produced
// false "Already Connected" stamps. The lead URLs are the encoded member-URN
// (/in/ACwAA…) form. When the profile failed to load (rate-limit / session
// degradation), captureProfileMeta read a junk fallback page: it grabbed a
// stray URN but COULD NOT resolve a numeric member number — that empty
// member-number is the fingerprint of the false positive.

// ── False positives: profile didn't load, no numeric member id captured ──

test('rejects a stamp when no numeric member id was captured (Tassos)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',                                   // ← empty = junk page
    capturedUrn: 'ACoAAB9F5KEBC-1MAq-hnj_RPockFTjEVb4Ab4Q',     // stray fallback URN
    leadUrl: 'https://www.linkedin.com/in/ACwAAAemNeMBJ1_bBWZ9kuosC20s54oAGTG4haA',
    sourceMemberId: '128333283',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /member.?number/i);
});

test('rejects the SAME stray URN captured for a different lead/account (Christoph)', () => {
  // Different person, different sender, yet the run captured the identical
  // fallback URN as Tassos — proof it is not the lead's real identity.
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: 'ACoAAB9F5KEBC-1MAq-hnj_RPockFTjEVb4Ab4Q',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAieeocB8f7UHdGc7ZUYhhFiFC2DXB2tqkU',
    sourceMemberId: '144603783',
  });
  assert.equal(v.ok, false);
});

// ── True connections: numeric member id captured AND matches the lead ──

test('accepts a stamp when captured member id matches the source id (Mehmet)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '80924858',
    capturedUrn: 'ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: '80924858',
  });
  assert.equal(v.ok, true);
});

test('accepts a stamp when captured member id matches the source id (Barbara)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '86032425',
    capturedUrn: 'ACoAAAUgwCkBjNAp8L6aHQIES_93XVY65PegYIE',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAUgwCkBBC72BRoRrC3ZRHlG1DPCt6G_HBM',
    sourceMemberId: '86032425',
  });
  assert.equal(v.ok, true);
});

// ── Wrong-but-present: junk page yielded a numeric id, but not the lead's ──

test('rejects when a numeric id was captured but does not match the lead', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '999999999',
    capturedUrn: 'ACoAAB9F5KEBC-1MAq-hnj_RPockFTjEVb4Ab4Q',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAemNeMBJ1_bBWZ9kuosC20s54oAGTG4haA',
    sourceMemberId: '128333283',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /mismatch/i);
});

// ── Fallback when the sheet has no source member id: corroborate via the
//    AC**AA URN token. Same person ⇒ token bodies share a long prefix. ──

test('accepts via URN-token corroboration when no source id is present (same person)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '80924858',
    capturedUrn: 'ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: '',
  });
  assert.equal(v.ok, true);
});

test('rejects via URN-token corroboration when no source id is present (different person)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '555555555',                          // a real-looking number…
    capturedUrn: 'ACoAAB9F5KEBC-1MAq-hnj_RPockFTjEVb4Ab4Q',     // …but the wrong person
    leadUrl: 'https://www.linkedin.com/in/ACwAAAemNeMBJ1_bBWZ9kuosC20s54oAGTG4haA',
    sourceMemberId: '',
  });
  assert.equal(v.ok, false);
});

// ── Robustness: genuine lead RESCUED when the numeric id momentarily fails
//    to resolve but the captured URN still matches the lead (don't over-skip) ──

test('rescues a genuine lead: empty captured number but URN matches the lead', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',                                   // Voyager hiccup, no number
    capturedUrn: 'ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',     // …but URN is the right person
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: '80924858',
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /urn-prefix-match/);
});

// ── A numeric mismatch is a HARD reject — a coincidental URN overlap must not
//    rescue a wrong-person capture. ──

test('hard-rejects on numeric mismatch even if the URN token happens to overlap', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '999999999',                          // wrong number…
    capturedUrn: 'ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',     // …same body as the lead URL
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: '80924858',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /mismatch/);
});

// ── Real-world input variations seen in the actual sheets/logs ──

test('handles http:// lead URLs (legacy rows) the same as https', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: 'ACoAAB9F5KEBC-1MAq-hnj_RPockFTjEVb4Ab4Q',
    leadUrl: 'http://www.linkedin.com/in/ACwAAAemNeMBJ1_bBWZ9kuosC20s54oAGTG4haA',
    sourceMemberId: '',
  });
  assert.equal(v.ok, false); // no number + wrong URN
});

test('extracts the token when capturedUrn is a full urn:li:fsd_profile string', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '80924858',
    capturedUrn: 'urn:li:fsd_profile:ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: '',
  });
  assert.equal(v.ok, true);
});

test('normalizes a noisy source id (urn:li:member:NNN / spaces)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '80924858',
    capturedUrn: 'ACoAAATS0LoB47kMd7lBTR9dZ73thhhKuJW1UDg',
    leadUrl: 'https://www.linkedin.com/in/ACwAAATS0LoBsOJrZ4qQQWRAtrWMiiZIO8nW3pU',
    sourceMemberId: 'urn:li:member:80924858',
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /member-number-match/);
});

test('vanity-slug lead with a real captured number and no anchor → accept (nothing refutes)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '37007123',
    capturedUrn: 'ACoAAB1abcdEFGhijklmnopQRStuvwx',
    leadUrl: 'https://www.linkedin.com/in/uwe-martin-wiesler-37007b4',  // no AC**AA token
    sourceMemberId: '',
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /unverified/);
});

test('vanity-slug lead with no captured number → reject (profile did not load)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    leadUrl: 'https://www.linkedin.com/in/uwe-martin-wiesler-37007b4',
    sourceMemberId: '',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no-member-number/);
});

test('empty/garbage input rejects rather than throwing', () => {
  assert.equal(verifyConnectIdentity({}).ok, false);
  assert.equal(verifyConnectIdentity().ok, false);
});

// ── readSourceMemberId: source column wins over the empty run-stamped one ──

test('readSourceMemberId reads the source id even when the run-stamped column is empty', () => {
  const row = {
    'First Name': 'Tassos',
    'Linkedin Membership ID': '128333283',   // source column (populated)
    'LinkedIn URN': 'ACoAAB9F5KEB...',
    'LinkedIn Membership ID': '',            // run-stamped column (empty on first run)
  };
  assert.equal(readSourceMemberId(row), '128333283');
});

test('readSourceMemberId falls back across header spellings', () => {
  assert.equal(readSourceMemberId({ 'Member ID': '42' }), '42');
});

test('readSourceMemberId returns empty when nothing usable is present', () => {
  assert.equal(readSourceMemberId({ 'First Name': 'Nobody' }), '');
  assert.equal(readSourceMemberId({ 'Linkedin Membership ID': '' }), '');
  assert.equal(readSourceMemberId(null), '');
});
