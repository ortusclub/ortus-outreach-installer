import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAwaitingAccept, sendersToAcceptTasks, computeAcceptedIds } from '../src/cloud-primary-handshake.js';

const DETAIL = {
  campaign: { id: 'cmp_1', state: 'awaiting_primary_accept', mode: 'connect_and_introduce',
    primary: { name: 'Antonio Varlese', url: 'https://www.linkedin.com/in/antoniovarlese/' },
    senders: [
      { profileId: 'gl_a', name: 'Alex Sheeraz', url: 'https://linkedin.com/in/alex', accepted: false },
      { profileId: 'gl_b', name: 'Marco Rossi',  url: 'https://linkedin.com/in/marco', accepted: true },
    ],
    acceptAllPending: false } };

test('isAwaitingAccept true only for the awaiting state', () => {
  assert.equal(isAwaitingAccept(DETAIL), true);
  assert.equal(isAwaitingAccept({ campaign: { state: 'running' } }), false);
  assert.equal(isAwaitingAccept({}), false);
});

test('sendersToAcceptTasks maps unaccepted senders to pickInvitation shape', () => {
  const tasks = sendersToAcceptTasks(DETAIL);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].account, { name: 'Alex Sheeraz', profileUrl: 'https://linkedin.com/in/alex' });
  assert.equal(tasks[0].profileId, 'gl_a');
});

test('computeAcceptedIds returns ids whose accept succeeded', () => {
  const ids = computeAcceptedIds(DETAIL, [{ profileId: 'gl_a', accepted: true }, { profileId: 'gl_c', accepted: false }]);
  assert.deepEqual(ids, ['gl_a']);
});
