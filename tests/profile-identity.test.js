import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyConnectIdentity, readSourceMemberId, is404Url } from '../src/profile-identity.js';

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

// ─────────────────────────────────────────────────────────────────────────
// v2.96.0 — PRE-SEND identity gate: strict mode + name matching.
//
// Background (2026-06-11 connect_only incident): encoded /in/ACwAA… lead URLs
// mis-loaded under LinkedIn rate-limiting and the (correctly-named) connect
// note was sent to the WRONG person — including people never in any sheet and
// an internal colleague ("Hi Divya" reached "Dion Kadriu"). The gate must
// POSITIVELY confirm the loaded profile is the intended lead before any
// Connect click, and skip-on-doubt. These tests pin that behaviour while the
// lenient (post-send write-back) default stays exactly as it was.
// ─────────────────────────────────────────────────────────────────────────

test('strict: member-number match still confirms', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '199140892',
    capturedUrn: 'ACoAAAvephwBrpfip6HuNSo8HdU1dQgxuAzg4Qg',
    capturedName: 'Rishi Pandey',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAvephwBEn2Cp1fWf9V7IoCZUXIlIsFLlsc',
    sourceMemberId: '199140892',
    sourceName: 'Rishi Pandey',
    strict: true,
  });
  assert.equal(v.ok, true);
});

test('strict: REAL INCIDENT — note for "Divya" loads "Dion Kadriu" → reject (name mismatch)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    capturedName: 'Dion Kadriu',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAsomeEncodedTokenForDivya',
    sourceMemberId: '',
    sourceName: 'Divya Sharma',
    strict: true,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /name-mismatch/);
});

test('strict: name mismatch HARD-rejects even when member-number matches (fully corrupt row)', () => {
  // The sheet paired the right note-name with a member id that is NOT that
  // person — so member# matches the loaded profile, but it is the wrong human.
  const v = verifyConnectIdentity({
    capturedMemberNumber: '111',
    capturedUrn: 'ACoAAADionDionDionDionDionDionDion',
    capturedName: 'Dion Kadriu',
    leadUrl: 'https://www.linkedin.com/in/ACwAAADionDionDionDionDionDionDion',
    sourceMemberId: '111',
    sourceName: 'Divya Sharma',
    strict: true,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /name-mismatch/);
});

test('strict: name match confirms a slug lead with no source member id', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '37007123',
    capturedUrn: 'ACoAAB1abcdEFGhijklmnopQRStuvwx',
    capturedName: 'Surya Suravarapu',
    leadUrl: 'https://www.linkedin.com/in/suryasuravarapu/',
    sourceMemberId: '',
    sourceName: 'Surya Suravarapu',
    strict: true,
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /name-match/);
});

test('strict: a vanity slug that STAYED on the same slug confirms even without a name', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    capturedName: '',
    leadUrl: 'https://www.linkedin.com/in/john-roman/',
    landedUrl: 'https://www.linkedin.com/in/john-roman/',
    sourceMemberId: '',
    sourceName: '',
    strict: true,
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /slug/);
});

test('strict: profile did not load (no number, no name) → reject', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    capturedName: '',
    leadUrl: 'https://www.linkedin.com/in/ACwAAAPdklQBPTRQQqLAaZSNksM36oFi4Wjc8ZQ',
    sourceMemberId: '64852564',
    sourceName: 'Pachaiyappan Varadhan',
    strict: true,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no-member-number|did not load/i);
});

// v2.103 — the 2026-06-15 mass-skip: encoded /in/ACwAA… leads on a rate-limited
// session. The Voyager member-number API was throttled (empty number), but the
// profile DID load the right person. Before waitForProfileRender, the <h1> name
// was read too early (empty) so name-match could never fire and the gate skipped
// healthy leads as "no-member-number-captured". Once the name renders and is
// captured, name-match must confirm WITHOUT any member number — that is the
// payoff this test guards.
test('strict: encoded URL, member-number throttled (empty), but rendered name matches → confirm via name-match (Paola)', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',                                          // Voyager throttled
    capturedUrn: 'ACoAAGUY1OsB8PCjf-rIJd5RsxV825VjWMb3GGw',            // real target URN
    capturedName: 'Paola Scala',                                       // now captured after render
    leadUrl: 'https://www.linkedin.com/in/ACwAAAKAh9cBM0NoEO_fpo4otHVxXytGloE31fM',
    landedUrl: 'https://www.linkedin.com/in/paolascala/',              // resolved to the vanity slug
    sourceMemberId: '',                                                // sheet had no number for this row
    sourceName: 'Paola Scala',
    strict: true,
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /name-match/);
});

// Safety: the render fix must NOT weaken the wrong-person guard. Same throttled
// number, but the rendered name belongs to someone else → still hard-reject.
test('strict: encoded URL, empty number, rendered name is a DIFFERENT person → still reject', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: 'ACoAAGUY1OsB8PCjf-rIJd5RsxV825VjWMb3GGw',
    capturedName: 'Dion Kadriu',                                       // wrong person rendered
    leadUrl: 'https://www.linkedin.com/in/ACwAAAKAh9cBM0NoEO_fpo4otHVxXytGloE31fM',
    landedUrl: 'https://www.linkedin.com/in/dion-kadriu/',
    sourceMemberId: '',
    sourceName: 'Paola Scala',
    strict: true,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /name-mismatch/);
});

test('strict: bare member-number with no corroboration → reject (lenient would accept)', () => {
  const args = {
    capturedMemberNumber: '37007123',
    capturedUrn: 'ACoAAB1abcdEFGhijklmnopQRStuvwx',
    capturedName: '',                                              // name not captured
    leadUrl: 'https://www.linkedin.com/in/uwe-martin-wiesler-37007b4', // no AC token
    sourceMemberId: '',
    sourceName: '',
  };
  assert.equal(verifyConnectIdentity({ ...args, strict: false }).ok, true);  // lenient unchanged
  assert.equal(verifyConnectIdentity({ ...args, strict: true }).ok, false);  // strict rejects
});

test('name matching strips credentials/emoji and is order/diacritic tolerant', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    capturedName: 'Renée O’Brien, MBA 🔔 · 2nd',
    leadUrl: 'https://www.linkedin.com/in/renee-obrien',
    landedUrl: 'https://www.linkedin.com/in/renee-obrien',
    sourceMemberId: '',
    sourceName: "Renee O'Brien",
    strict: true,
  });
  assert.equal(v.ok, true);
});

test('partial name overlap (first matches, last missing) is inconclusive — slug-stay rescues it', () => {
  const v = verifyConnectIdentity({
    capturedMemberNumber: '',
    capturedUrn: '',
    capturedName: 'Surya',                                        // truncated capture
    leadUrl: 'https://www.linkedin.com/in/suryasuravarapu/',
    landedUrl: 'https://www.linkedin.com/in/suryasuravarapu/',
    sourceMemberId: '',
    sourceName: 'Surya Suravarapu',
    strict: true,
  });
  assert.equal(v.ok, true);   // not hard-rejected by partial name; slug-stay confirms
});

// ── is404Url (v2.112.26, #4) ──────────────────────────────────────────────
// A dead LinkedIn profile either lands on /404 or redirects to /in/unavailable.
// The identity gate must skip-terminally on these instead of burning 5 retries.

test('is404Url: linkedin.com/404 → true', () => {
  assert.equal(is404Url('https://www.linkedin.com/404'), true);
  assert.equal(is404Url('https://www.linkedin.com/404/'), true);
  assert.equal(is404Url('https://www.linkedin.com/404?trk=x'), true);
});

test('is404Url: /in/unavailable redirect → true', () => {
  assert.equal(is404Url('https://www.linkedin.com/in/unavailable/'), true);
  assert.equal(is404Url('https://www.linkedin.com/in/unavailable'), true);
});

test('is404Url: a healthy profile URL → false', () => {
  assert.equal(is404Url('https://www.linkedin.com/in/surya-suravarapu/'), false);
  assert.equal(is404Url('https://www.linkedin.com/in/ACwAAAemNeMBJ1_bBWZ9kuosC20s54oAGTG4haA'), false);
});

test('is404Url: "404"/"unavailable" inside a vanity slug → false (not a path segment)', () => {
  assert.equal(is404Url('https://www.linkedin.com/in/john404smith/'), false);
  assert.equal(is404Url('https://www.linkedin.com/in/marie-unavailable/'), false);
});

test('is404Url: empty / nullish → false', () => {
  assert.equal(is404Url(''), false);
  assert.equal(is404Url(null), false);
  assert.equal(is404Url(undefined), false);
});
