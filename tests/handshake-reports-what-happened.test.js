// The handshake wizard told an operator:
//
//   "6a5f1605f264c576fd2fcabf sent the invitation but the primary did not
//    accept it here"
//
// Three separate lies in one sentence (2026-09-01):
//   1. No invitation was sent. somnath.mandal@ortus.solutions was logged out, so
//      checkAndConnectPrimary could not read the page and deliberately did not
//      send a connect — its own log says "leaving unverified, not sending a
//      connect". The handshake then emitted 'sent' anyway, from a catch-all
//      `else` that reported 'sent' for every leftover case.
//   2. The primary did not fail. There was nothing to accept, which is why the
//      operator's "accept all pending" correctly accepted nothing — and looked
//      broken for it.
//   3. That is a GoLogin profile id, not a name.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handshakeOutcome, handshakeRowView } from '../public/js/handshake-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HS = fs.readFileSync(path.join(HERE, '..', 'src', 'cloud-preflight-handshake.js'), 'utf8');
const APP = fs.readFileSync(path.join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');

test('an unreadable sender is reported as nothing-sent, not as sent', () => {
  assert.match(HS, /} else if \(primaryConn\.get\(profileId\) === 'unverified'\) \{/,
    'the unverified case must be split out of the catch-all');
  const i = HS.indexOf("primaryConn.get(profileId) === 'unverified'");
  const branch = HS.slice(i, i + 900);
  assert.match(branch, /emit\(profileId, 'not-sent'/);
  assert.doesNotMatch(branch, /emit\(profileId, 'sent'\)/);
});

test('the log says which account and why, in words', () => {
  const i = HS.indexOf("primaryConn.get(profileId) === 'unverified'");
  const branch = HS.slice(i, i + 900);
  assert.match(branch, /log\(why/, 'the reason has to reach the operator log, not just the banner');
  assert.match(branch, /no invitation was sent/i);
  assert.match(branch, /Reconnect this account in GoLogin/i, 'tell the operator what to do');
});

test('a logged-out account is named as logged out, not as a mystery', () => {
  assert.match(HS, /const whyUnreadable = async \(page\) => \{/);
  assert.match(HS, /authwall/, 'the sign-in wall is the case that actually happens');
  assert.match(HS, /checkpoint/);
});

test('the reason travels to the wizard', () => {
  const JOB = fs.readFileSync(path.join(HERE, '..', 'src', 'cloud-handshake-job.js'), 'utf8');
  assert.match(JOB, /reason: evt\.reason \|\| cur\.reason \|\| '',/,
    'the job must carry the reason or the wizard cannot show it');
});

test('the row for a nothing-sent sender does not read as sent', () => {
  const view = handshakeRowView('not-sent');
  assert.equal(view.done, false);
  assert.match(view.label, /nothing sent/i);
  assert.doesNotMatch(view.label, /accept/i, 'nothing is waiting to be accepted');
});

test('the outcome stops blaming the primary when nothing was sent', () => {
  const out = handshakeOutcome({
    senders: [
      { profileId: '6a5f1605f264c576fd2fcabf', state: 'not-sent', reason: 'logged out' },
      { profileId: 'b2', state: 'connected', name: 'Carl Cabico' },
    ],
    summary: { connected: 1, accepted: 1, pending: 0 },
    nameFor: (id) => (id === '6a5f1605f264c576fd2fcabf' ? 'somnath.mandal@ortus.solutions' : ''),
  });
  assert.equal(out.kind, 'partial');
  assert.doesNotMatch(out.detail, /sent the invitation/,
    'no invitation was sent, so the copy must not say one was');
  assert.doesNotMatch(out.detail, /did not accept/,
    'the primary did nothing wrong');
  assert.match(out.detail, /No invitation was sent/i);
  assert.match(out.detail, /logged out/);
  assert.match(out.detail, /somnath\.mandal@ortus\.solutions/, 'name the account');
  assert.doesNotMatch(out.detail, /6a5f1605f264c576fd2fcabf/, 'never show the id');
});

test('a genuinely-unaccepted invitation still reads the old way', () => {
  // The 2026-08-28 case must not regress: invites went out, the primary never
  // accepted them here, and the background runner picks them up.
  const out = handshakeOutcome({
    senders: [{ profileId: 'x', state: 'sent', name: 'Nepal' }],
    summary: { connected: 0, accepted: 0, pending: 1 },
  });
  assert.match(out.detail, /sent the invitation but the primary did not accept it here/);
});

test('a mixed run describes both halves', () => {
  const out = handshakeOutcome({
    senders: [
      { profileId: 'a', state: 'sent', name: 'Nepal' },
      { profileId: 'b', state: 'not-sent', name: 'Somnath', reason: 'logged out' },
    ],
    summary: { connected: 0, accepted: 0, pending: 1 },
  });
  assert.match(out.detail, /Somnath sent nothing \(logged out\)/);
  assert.match(out.detail, /the primary will accept it in the background/i);
});

test('the wizard never falls back to a raw profile id for a name', () => {
  assert.doesNotMatch(APP, /const nameOf = \(id\) => \(typeof selectedProfileNames[^\n]*\|\| id;/,
    'the id-as-name fallback is back');
  assert.match(APP, /return \(label && label !== id\) \? label : 'this account';/);
});

test('the outcome copy is given the name resolver', () => {
  assert.match(APP, /handshakeOutcome\(\{ senders: snap\.senders, summary: snap\.summary, error: snap\.error, nameFor: nameOf \}\)/);
});

test('the sender browser really is put off-screen, as the wizard promises', () => {
  // The wizard says "an off-screen GoLogin browser" and an operator watched one
  // open on their screen. The launch flag alone is not enough: GoLogin's SDK
  // passes its own --window-position=0,0 and appends --restore-last-session,
  // which restores the previous run's window bounds. campaign.js has always
  // followed the flag with a CDP setWindowBounds for that reason.
  assert.match(HS, /const tuckAway = async \(page\) => \{/);
  assert.match(HS, /Browser\.setWindowBounds/);
  assert.match(HS, /left: -2400, top: -2400/);
  assert.match(HS, /if \(page\) await tuckAway\(page\);/);
});

test('the PRIMARY browser is left visible', () => {
  // The wizard tells the operator "Your primary Chrome is open, accepting …
  // Leave it alone, it closes itself." Hiding it would contradict that and make
  // an accept that needs watching invisible.
  const i = HS.indexOf('primaryPage = launched && launched.page;');
  assert.ok(i > 0);
  assert.doesNotMatch(HS.slice(i, i + 200), /tuckAway/,
    'the primary must stay on screen');
});
