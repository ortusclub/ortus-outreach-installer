import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdownAssignee } from '../public/js/account-guardrails.mjs';

const LOCKED = { monthly: { active: false }, cc: { active: false } };   // before passover
const FREED  = { monthly: { active: true },  cc: { active: true } };    // after passover (16th)

test('assigned to someone else + before monthly passover → returns the assignee', () => {
  assert.equal(breakdownAssignee({ Assignee: 'Dafina', section: 'Team A' }, 'antonio', LOCKED), 'Dafina');
});

test('after monthly passover (freed) → no assignee shown', () => {
  assert.equal(breakdownAssignee({ Assignee: 'Dafina', section: 'Team A' }, 'antonio', FREED), '');
});

test('pool / unassigned section → no assignee', () => {
  assert.equal(breakdownAssignee({ Assignee: 'Dafina', section: 'Pool Accounts Unassigned' }, 'antonio', LOCKED), '');
});

test('assigned to me → no assignee shown', () => {
  assert.equal(breakdownAssignee({ Assignee: 'Antonio', section: 'Team A' }, 'antonio', LOCKED), '');
});

test('no assignee / dash → empty', () => {
  assert.equal(breakdownAssignee({ Assignee: '', section: 'Team A' }, 'antonio', LOCKED), '');
  assert.equal(breakdownAssignee({ Assignee: '-', section: 'Team A' }, 'antonio', LOCKED), '');
});

test('assignee log-string is cleaned to the person', () => {
  assert.equal(breakdownAssignee({ Assignee: 'dafina@ortusclub.com, 2026-06-10, In Use', section: 'Team A' }, 'antonio', LOCKED), 'dafina');
});

test('null soo / missing passover → empty', () => {
  assert.equal(breakdownAssignee(null, 'antonio', LOCKED), '');
  assert.equal(breakdownAssignee({ Assignee: 'Dafina', section: 'Team A' }, 'antonio', undefined), '');
});
