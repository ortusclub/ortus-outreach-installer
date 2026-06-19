import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountState, mapModeToCreditField } from '../public/js/account-guardrails.mjs';

const PASS = { cc: { active: false, label: 'in 2d' }, monthly: { active: false, label: 'in 4d' } };

// --- mapModeToCreditField: mode → the specific SoO credit column it consumes ---

test('CC-family modes (Connect Only, CC+IC, CC+DM, IB) all consume CC credits', () => {
  assert.equal(mapModeToCreditField('connect_only'), 'ccCredits');
  assert.equal(mapModeToCreditField('connect_and_introduce'), 'ccCredits');
  assert.equal(mapModeToCreditField('connect_and_message'), 'ccCredits');
  assert.equal(mapModeToCreditField('introduce_back'), 'ccCredits');
});

test('open profile (Message Campaign) consumes Linkedin OP credits', () => {
  assert.equal(mapModeToCreditField('open_profile_only'), 'linkedinCredits');
});

test('inmail mode consumes InMail credits', () => {
  assert.equal(mapModeToCreditField('inmail_only'), 'inmailCredits');
});

test('credit-free modes map to null', () => {
  assert.equal(mapModeToCreditField('message_only'), null);
  assert.equal(mapModeToCreditField('check_status'), null);
  assert.equal(mapModeToCreditField(''), null);
  assert.equal(mapModeToCreditField(undefined), null);
});

test('IB (introduce_back) → in-use when CC (Credits) = In Use', () => {
  const s = classifyAccountState({ ccCredits: 'In Use', 'CC User': 'ivy' }, 'me', 'introduce_back', PASS);
  assert.equal(s.state, 'in-use');
  assert.equal(s.who, 'ivy');
});

// --- classifyAccountState: NA on the campaign's channel → blocked (unusable) ---

test('connect campaign + CC=NA → blocked with reason na', () => {
  const s = classifyAccountState({ ccCredits: 'NA' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
  assert.equal(s.reason, 'na');
});

test('NA match is case-insensitive and tolerates N/A', () => {
  assert.equal(classifyAccountState({ ccCredits: 'na' }, 'me', 'connect_only', PASS).state, 'blocked');
  assert.equal(classifyAccountState({ ccCredits: 'N/A' }, 'me', 'connect_only', PASS).state, 'blocked');
});

test('connect campaign + CC Available → not blocked (free)', () => {
  const s = classifyAccountState({ ccCredits: 'Available' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('channel-aware: open-profile campaign ignores CC=NA when OP is Available', () => {
  const s = classifyAccountState({ linkedinCredits: 'Available', ccCredits: 'NA' }, 'me', 'open_profile_only', PASS);
  assert.equal(s.state, 'free');
});

test('channel-aware: connect campaign blocks on CC=NA even if OP is Available', () => {
  const s = classifyAccountState({ linkedinCredits: 'Available', ccCredits: 'NA' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
  assert.equal(s.reason, 'na');
});

test('open-profile campaign + OP=NA → blocked', () => {
  const s = classifyAccountState({ linkedinCredits: 'NA' }, 'me', 'open_profile_only', PASS);
  assert.equal(s.state, 'blocked');
  assert.equal(s.reason, 'na');
});

test('NA on the campaign channel beats cross-channel in-use', () => {
  // Connect campaign cares about CC. CC=NA → blocked, even though SalesNav is in use by someone else.
  const s = classifyAccountState({ ccCredits: 'NA', salesNavCredits: 'In Use', salesNavUser: 'Bob' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
  assert.equal(s.reason, 'na');
});

test('credit-free mode never blocks on NA', () => {
  const s = classifyAccountState({ ccCredits: 'NA', linkedinCredits: 'NA', inmailCredits: 'NA', salesNavCredits: 'NA' }, 'me', 'message_only', PASS);
  assert.equal(s.state, 'free');
});

test('restricted status still wins over NA', () => {
  const s = classifyAccountState({ Status: 'Identity Restricted', ccCredits: 'NA' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
});
