import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountState } from '../public/js/account-guardrails.mjs';

const PASS = { cc: { active: false, label: 'in 2d' }, monthly: { active: false, label: 'in 4d' } };
const PASS_ACTIVE = { cc: { active: true, label: 'closes in 3d' }, monthly: { active: true, label: 'closes in 10d' } };

test('blocked wins over everything', () => {
  const s = classifyAccountState({ Status: 'Identity Restricted', Assignee: 'Cathy', linkedinCredits: 'In Use' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
});

test('in use by someone else → in-use + who', () => {
  const s = classifyAccountState({ linkedinCredits: 'In Use', linkedinUser: 'Cathy' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'in-use');
  assert.equal(s.who, 'Cathy');
});

test('CC in use falls back to linkedinUser for who', () => {
  const s = classifyAccountState({ ccCredits: 'In Use', linkedinUser: 'Cathy' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'in-use');
  assert.equal(s.who, 'Cathy');
});

test('who is cleaned: SoO log string → just the person (email local part)', () => {
  assert.equal(classifyAccountState({ ccCredits: 'In Use', linkedinUser: 'ivy@ortusclub.com, 2026-06-17 07:05, In Use' }, 'alecx', 'connect_only', PASS).who, 'ivy');
});

test('in use by me → free (not flagged)', () => {
  const s = classifyAccountState({ linkedinCredits: 'In Use', linkedinUser: 'alecx' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('assigned to other + channel resting → assigned (blue) with frees label', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'assigned');
  assert.equal(s.who, 'Cathy');
  assert.equal(s.frees, 'in 2d');
});

test('assigned to other + channel ACTIVE (after passover) → free', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'connect_only', PASS_ACTIVE);
  assert.equal(s.state, 'free');
});

test('open_profile_only uses the monthly schedule', () => {
  const resting = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'open_profile_only', PASS);
  assert.equal(resting.state, 'assigned');
  assert.equal(resting.frees, 'in 4d');
  const active = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'open_profile_only', PASS_ACTIVE);
  assert.equal(active.state, 'free');
});

test('assigned to me → free', () => {
  const s = classifyAccountState({ Assignee: 'alecx', section: 'Team A' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('pool section → free even if Assignee set', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Pool Accounts Unassigned' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('null-channel mode (message_only): assigned-to-other stays assigned, no frees', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'message_only', PASS);
  assert.equal(s.state, 'assigned');
  assert.equal(s.frees, '');
});

test('missing soo / missing me → free', () => {
  assert.equal(classifyAccountState(null, 'me', 'connect_only', PASS).state, 'free');
  assert.equal(classifyAccountState({ Assignee: 'Cathy' }, '', 'connect_only', PASS).state, 'free');
});
