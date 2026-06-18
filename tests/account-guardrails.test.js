import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountFlag } from '../public/js/account-guardrails.mjs';

test('assigned to another operator → flagged', () => {
  const r = classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A' }, 'antonio');
  assert.equal(r.flagged, true); assert.equal(r.reason, 'assigned');
  assert.equal(r.label, 'assigned to Marigona');
});
test('assigned to me → not flagged (substring match)', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Antonio Varlese', section: 'Team A' }, 'antonio').flagged, false);
});
test('pool account is never "assigned"', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Marigona', section: 'Unassigned Pool' }, 'antonio').flagged, false);
});
test('in use by another (with reserver) → flagged with name', () => {
  const r = classifyAccountFlag({ section: 'pool', salesNavCredits: 'In Use', salesNavUser: 'marco@x.com' }, 'antonio');
  assert.equal(r.reason, 'in-use'); assert.equal(r.label, 'in use by marco@x.com');
});
test('CC in use (no reserver field) → flagged, no name', () => {
  const r = classifyAccountFlag({ section: 'pool', ccCredits: 'In Use' }, 'antonio');
  assert.equal(r.reason, 'in-use'); assert.equal(r.label, 'in use');
});
test('in use by me → not flagged', () => {
  assert.equal(classifyAccountFlag({ section: 'pool', linkedinCredits: 'In Use', linkedinUser: 'antonio@x.com' }, 'antonio').flagged, false);
});
test('me empty → not flagged', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A' }, '').flagged, false);
});
test('assigned wins over in-use for the label', () => {
  const r = classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A', ccCredits: 'In Use' }, 'antonio');
  assert.equal(r.reason, 'assigned');
});
