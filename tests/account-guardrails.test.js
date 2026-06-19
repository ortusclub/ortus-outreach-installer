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

import { mapModeToChannel, passoverWarning, summarizeSelection } from '../public/js/account-guardrails.mjs';

const PO = { monthly: { active: true, label: 'ACTIVE — closes in 12d' }, cc: { active: false, label: 'in 3d' } };

test('mapModeToChannel', () => {
  assert.equal(mapModeToChannel('connect_only'), 'cc');
  assert.equal(mapModeToChannel('connect_and_introduce'), 'cc');
  assert.equal(mapModeToChannel('open_profile_only'), 'monthly');
  assert.equal(mapModeToChannel('inmail_only'), 'monthly');
  assert.equal(mapModeToChannel('check_status'), null);
});
test('passoverWarning: CC closed for a connect campaign', () => {
  const w = passoverWarning('connect_only', PO);
  assert.equal(w.channel, 'cc'); assert.equal(w.label, 'in 3d');
});
test('passoverWarning: monthly active → no warning', () => {
  assert.equal(passoverWarning('open_profile_only', PO), null);
});
test('passoverWarning: mode with no channel → null', () => {
  assert.equal(passoverWarning('check_status', PO), null);
});
test('summarizeSelection: counts flagged + passover, hasWarnings', () => {
  const sel = [
    { email: 'a@x', soo: { Assignee: 'Marigona', section: 'Team A' } },
    { email: 'b@x', soo: { Assignee: 'Antonio', section: 'Team A' } },
  ];
  const s = summarizeSelection(sel, 'antonio', 'connect_only', PO);
  assert.equal(s.flagged.length, 1);
  assert.equal(s.flagged[0].email, 'a@x');
  assert.equal(s.passover.channel, 'cc');
  assert.equal(s.hasWarnings, true);
});
test('summarizeSelection: nothing flagged + active channel → no warnings', () => {
  const s = summarizeSelection([{ email: 'b@x', soo: { Assignee: 'Antonio', section: 'Team A' } }], 'antonio', 'open_profile_only', PO);
  assert.equal(s.hasWarnings, false);
});

// The banner must MIRROR the account tile (classifyAccountState): passover-aware
// and channel-aware. Regression for luigic — tile FREE (passover lifted) yet the
// banner still warned, because summarizeSelection used to ignore mode+passover.
const PO_LIFTED = { monthly: { active: true, label: '' }, cc: { active: true, label: '' } };

test('summarizeSelection: assigned but passover lifted → NOT flagged (mirrors FREE tile)', () => {
  const sel = [{ email: 'luigic@ortus.solutions', soo: { Assignee: 'Someone Else', section: 'Team B' } }];
  const s = summarizeSelection(sel, 'antonio', 'connect_only', PO_LIFTED);
  assert.equal(s.flagged.length, 0);
  assert.equal(s.hasWarnings, false);
});

test('summarizeSelection: cross-channel in-use ignored — only the campaign channel matters', () => {
  // Connect campaign gates on CC; a DIFFERENT channel (InMail) is In Use by someone
  // else, but CC is free → tile is FREE → banner must not flag.
  const sel = [{ email: 'x@y', soo: { section: 'pool', ccCredits: 'Available', inmailCredits: 'In Use', inmailUser: 'marco@x.com' } }];
  const s = summarizeSelection(sel, 'antonio', 'connect_only', PO_LIFTED);
  assert.equal(s.flagged.length, 0);
});

test('summarizeSelection: campaign channel in use by another → still flagged with name', () => {
  const sel = [{ email: 'x@y', soo: { section: 'pool', ccCredits: 'In Use', 'CC User': 'marco@x.com' } }];
  const s = summarizeSelection(sel, 'antonio', 'connect_only', PO_LIFTED);
  assert.equal(s.flagged.length, 1);
  assert.equal(s.flagged[0].label, 'in use by marco');
});

test('summarizeSelection: assigned + passover NOT lifted → still flagged', () => {
  // monthly locked (active:false) → tile shows ASSIGNED → banner must warn.
  const PO_LOCKED = { monthly: { active: false, label: 'in 5d' }, cc: { active: false, label: 'in 2d' } };
  const sel = [{ email: 'z@y', soo: { Assignee: 'Marigona', section: 'Team A' } }];
  const s = summarizeSelection(sel, 'antonio', 'open_profile_only', PO_LOCKED);
  assert.equal(s.flagged.length, 1);
  assert.equal(s.flagged[0].label, 'assigned to Marigona');
});
