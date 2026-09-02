import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStuck, messageTemplate, groupKeyOf, belongsToCampaign,
  healthForCampaign, groupStaleFollowUps, discardGroups, restoreDiscarded,
} from '../src/followup-groups.js';
import { selectDue } from '../src/primary-tasks.js';

const fu = (o) => ({
  type: 'follow-up', status: 'pending', createdAt: 1_700_000_000_000,
  dueAt: 1_700_000_000_000, id: `t${Math.random()}`, ...o,
});

// ── the message IS the campaign ────────────────────────────────────────────
test('two leads sent the same template group together despite different names', () => {
  const a = fu({ leadName: 'Michael Chen', primaryName: 'Antonio', body: 'Hi Michael, thanks for the intro, Antonio! Dinner on 4 September.' });
  const b = fu({ leadName: 'Nancy Okafor', primaryName: 'Antonio', body: 'Hi Nancy, thanks for the intro, Antonio! Dinner on 4 September.' });
  assert.equal(messageTemplate(a), messageTemplate(b));
  assert.equal(groupKeyOf(a), groupKeyOf(b));
});

test('a genuinely different campaign message does NOT group with it', () => {
  const a = fu({ leadName: 'Michael', body: 'Hi Michael, dinner on 4 September.' });
  const b = fu({ leadName: 'Michael', body: 'Hi Michael, roundtable on 26 August.' });
  assert.notEqual(groupKeyOf(a), groupKeyOf(b));
});

test('a longer name is stripped before the shorter one it contains', () => {
  // "Ann" replaced first would leave " Marie" behind and split the group.
  const a = fu({ leadName: 'Ann Marie', body: 'Hi Ann Marie, see you there.' });
  const b = fu({ leadName: 'Bob', body: 'Hi Bob, see you there.' });
  assert.equal(messageTemplate(a), messageTemplate(b));
});

test('a two-word name and a one-word name still group together', () => {
  // Found on the live queue, 2026-09-02: "Mohammad Mohtashim Khan" left "Hi {} {},"
  // where "Matthew Wootton" left "Hi {}," — same campaign, same week, split into
  // two groups. Adjacent placeholders are one name.
  const a = fu({ leadName: 'Mohammad Mohtashim Khan', body: "Hi Mohammad Mohtashim, following up on my colleague's note." });
  const b = fu({ leadName: 'Matthew Wootton', body: "Hi Matthew, following up on my colleague's note." });
  assert.equal(messageTemplate(a), messageTemplate(b));
  assert.equal(groupStaleFollowUps([{ ...a, status: 'failed' }, { ...b, status: 'failed' }]).length, 1);
});

test('collapsing placeholders does not merge genuinely different campaigns', () => {
  const a = fu({ leadName: 'Ann Marie Lee', body: 'Hi Ann Marie, dinner on 4 September.' });
  const b = fu({ leadName: 'Bob', body: 'Hi Bob, roundtable on 26 August.' });
  assert.notEqual(messageTemplate(a), messageTemplate(b));
});

test('a stamped campaignId wins over the message', () => {
  const a = fu({ campaignId: 'c1', body: 'Hi X, one thing.' });
  const b = fu({ campaignId: 'c2', body: 'Hi X, one thing.' });
  assert.notEqual(groupKeyOf(a), groupKeyOf(b), 'same words, different campaigns');
});

// ── stuck vs waiting ───────────────────────────────────────────────────────
test('only parked and failed follow-ups are stuck; a plain pending one is waiting', () => {
  assert.equal(isStuck(fu({ status: 'pending' })), false);
  assert.equal(isStuck(fu({ status: 'pending', blockedBySession: true })), true);
  assert.equal(isStuck(fu({ status: 'failed' })), true);
  assert.equal(isStuck(fu({ status: 'done' })), false);
  assert.equal(isStuck({ type: 'accept', status: 'failed' }), false, 'accepts are not follow-ups');
});

// ── the card counts its OWN campaign ───────────────────────────────────────
test("a card never reports another campaign's follow-ups", () => {
  const tasks = [
    fu({ campaignId: 'A', status: 'done' }),
    fu({ campaignId: 'B', status: 'done' }),
    fu({ campaignId: 'B', status: 'done' }),
    fu({ campaignId: 'B', status: 'failed', lastError: 'no message box' }),
  ];
  assert.deepEqual(
    (({ sent, failed, reason }) => ({ sent, failed, reason }))(healthForCampaign(tasks, { campaignId: 'A' })),
    { sent: 1, failed: 0, reason: '' },
  );
  const b = healthForCampaign(tasks, { campaignId: 'B' });
  assert.equal(b.sent, 2);
  assert.equal(b.failed, 1);
  assert.equal(b.lastError, 'no message box');
});

test('a campaign with no follow-ups of its own reports zero, not the app total', () => {
  const tasks = [fu({ campaignId: 'B', status: 'done' }), fu({ campaignId: 'B', status: 'failed' })];
  const h = healthForCampaign(tasks, { campaignId: 'NEW' });
  assert.deepEqual([h.sent, h.pending, h.blocked, h.failed], [0, 0, 0, 0]);
});

test('a task queued before campaignId existed is matched by its account', () => {
  const tasks = [fu({ campaignProfileId: 'p1', status: 'done' }), fu({ campaignProfileId: 'p9', status: 'done' })];
  assert.equal(healthForCampaign(tasks, { campaignId: 'A', profileIds: ['p1'] }).sent, 1);
});

// ── the strip: only campaigns that left the board ──────────────────────────
test('a live campaign is not in the strip — its card already shows it', () => {
  const tasks = [
    fu({ campaignId: 'LIVE', status: 'failed', body: 'Hi A, live one.' }),
    fu({ campaignId: 'OLD', status: 'failed', body: 'Hi A, old one.' }),
  ];
  const groups = groupStaleFollowUps(tasks, { liveCampaignIds: ['LIVE'] });
  assert.deepEqual(groups.map((g) => g.campaignId), ['OLD']);
});

test('an unstamped task is held back by its account, so it cannot appear twice', () => {
  const tasks = [fu({ campaignProfileId: 'p1', status: 'failed', body: 'Hi A, x.' })];
  assert.equal(groupStaleFollowUps(tasks, { liveProfileIds: ['p1'] }).length, 0);
  assert.equal(groupStaleFollowUps(tasks, { liveProfileIds: ['p2'] }).length, 1);
});

test('a group carries the message verbatim, the dates, the accounts and the leads', () => {
  const tasks = [
    fu({ id: '1', createdAt: 100, status: 'failed', campaignProfileName: 'liza@ortus', leadName: 'Michael', body: 'Hi Michael, dinner on 4 September.' }),
    fu({ id: '2', createdAt: 300, status: 'failed', campaignProfileName: 'liza@ortus', leadName: 'Nancy', body: 'Hi Nancy, dinner on 4 September.' }),
  ];
  const [g] = groupStaleFollowUps(tasks);
  assert.equal(g.count, 2);
  assert.equal(g.firstQueuedAt, 100);
  assert.equal(g.lastQueuedAt, 300);
  assert.deepEqual(g.accounts, ['liza@ortus']);
  assert.deepEqual(g.leadNames, ['Michael', 'Nancy']);
  // Verbatim: the operator has to read the real date out of it.
  assert.match(g.message, /dinner on 4 September/);
});

test('signed-out outranks an error within a group, because only it has a one-click fix', () => {
  const tasks = [
    fu({ campaignId: 'A', status: 'failed', lastError: 'no message box', body: 'Hi Michael, x.', leadName: 'Michael' }),
    fu({ campaignId: 'A', status: 'pending', blockedBySession: true, body: 'Hi Nancy, x.', leadName: 'Nancy' }),
  ];
  const groups = groupStaleFollowUps(tasks);
  assert.equal(groups.length, 1, 'same campaignId is one group');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].reason, 'signed-out');
});

test('a name too short to strip safely is left alone', () => {
  // Two characters is not a name we can remove from prose without hitting real
  // words, so those tasks simply do not template-match. Documented, not hidden.
  const a = fu({ leadName: 'Al', body: 'Hi Al, see you there.' });
  const b = fu({ leadName: 'Jo', body: 'Hi Jo, see you there.' });
  assert.notEqual(groupKeyOf(a), groupKeyOf(b));
});

test('groups come back newest first', () => {
  const tasks = [
    fu({ createdAt: 100, status: 'failed', body: 'old' }),
    fu({ createdAt: 900, status: 'failed', body: 'new' }),
  ];
  assert.deepEqual(groupStaleFollowUps(tasks).map((g) => g.message), ['new', 'old']);
});

// ── discard, and the undo behind it ────────────────────────────────────────
test('a discarded follow-up can never be sent', () => {
  const tasks = [fu({ id: 'x', status: 'pending', blockedBySession: true, dueAt: 1, body: 'Hi A, x.' })];
  assert.equal(selectDue(tasks, 2).length, 1, 'it was sendable before');
  const { tasks: after } = discardGroups(tasks, [groupKeyOf(tasks[0])]);
  assert.equal(after[0].status, 'discarded');
  assert.equal(selectDue(after, 2).length, 0, 'the runner must never pick it up');
});

test('discard touches only the group asked for', () => {
  const keep = fu({ id: 'k', status: 'failed', body: 'Hi A, keep this.' });
  const drop = fu({ id: 'd', status: 'failed', body: 'Hi A, drop this.' });
  const { tasks: after, discarded } = discardGroups([keep, drop], [groupKeyOf(drop)]);
  assert.deepEqual(discarded.map((d) => d.id), ['d']);
  assert.equal(after.find((t) => t.id === 'k').status, 'failed');
});

test('undo puts a discarded follow-up back exactly as it was', () => {
  const tasks = [fu({ id: 'x', status: 'pending', blockedBySession: true, body: 'Hi A, x.' })];
  const { tasks: after, discarded } = discardGroups(tasks, [groupKeyOf(tasks[0])]);
  const back = restoreDiscarded(after, discarded);
  assert.equal(back[0].status, 'pending');
  assert.equal(back[0].blockedBySession, true, 'it is parked again, not silently revived');
  assert.equal(back[0].discardedAt, undefined);
});

test('a discarded group is gone from the strip', () => {
  const tasks = [fu({ status: 'failed', body: 'Hi A, x.' })];
  const { tasks: after } = discardGroups(tasks, [groupKeyOf(tasks[0])]);
  assert.equal(groupStaleFollowUps(after).length, 0);
});

test('discarding an unknown key changes nothing', () => {
  const tasks = [fu({ status: 'failed', body: 'Hi A, x.' })];
  const { tasks: after, discarded } = discardGroups(tasks, ['msg:nothing like this']);
  assert.deepEqual(discarded, []);
  assert.equal(after[0].status, 'failed');
});
