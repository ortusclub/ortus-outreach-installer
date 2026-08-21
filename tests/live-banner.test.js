import { test } from 'node:test';
import assert from 'node:assert';
import { bannerFor } from '../public/js/runpanel.mjs';

test('a sweep in flight gets the checking banner', () => {
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true,
    liveAccount: 'camillec@ortus.solutions', accountsDone: 1, accountsTotal: 3, elapsedSec: 41 });
  assert.equal(b.tone, 'check');
  assert.equal(b.l1, 'Checking right now');
  assert.equal(b.big, '2 of 3');
  assert.match(b.l2, /camillec@ortus\.solutions/);
});

test('monitoring between checks gets NO banner', () => {
  // By design. A card that shouts continuously stops being heard.
  assert.equal(bannerFor({ state: 'monitoring', monitoringCheckInProgress: false }), null);
});

test('sending names the person before the account', () => {
  const b = bannerFor({ running: true, live: true, liveAccount: 'camillec@ortus.solutions',
    currentAction: { leadName: 'Rina Chandran', company: 'Reuters' },
    batchDone: 5, batchSize: 8, elapsedSec: 12, runsOn: 'local' });
  assert.equal(b.tone, 'send');
  assert.equal(b.l1, 'Sending right now');
  assert.equal(b.big, '6 of 8');
  assert.match(b.l2, /^Rina Chandran/, 'the person comes first, the account second');
  assert.match(b.l2, /on this Mac/);
});

test('a cloud run says so', () => {
  const b = bannerFor({ running: true, live: true, liveAccount: 'karen.d@ortus.solutions',
    currentAction: { leadName: 'Rina Chandran' }, batchDone: 5, batchSize: 8, runsOn: 'vm' });
  assert.match(b.l2, /on the Cloud VM/);
});

test('a stopping check outranks everything and says so plainly', () => {
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, checkStopping: true });
  assert.equal(b.tone, 'stopping');
  assert.equal(b.l1, 'Stopping the check');
  assert.match(b.l2, /closing/i);
});

test('an idle campaign gets no banner', () => {
  assert.equal(bannerFor({ running: false }), null);
  assert.equal(bannerFor(null), null);
});

test('a due check with no worker yet says the machine is starting up', () => {
  // The scale-to-zero worker boots in ~2 min. Same banner family as checking, so
  // the run never looks like it collapsed into a small line while it is alive.
  const b = bannerFor({ state: 'monitoring', monitorTaskStatus: 'pending',
    monitorTaskDueAt: new Date(Date.now() - 30000).toISOString() });
  assert.equal(b.tone, 'wake');
  assert.equal(b.l1, 'Starting the cloud machine');
  assert.match(b.l2, /nothing is lost/i);
});

test('a check in flight outranks the waking copy', () => {
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true,
    monitorTaskStatus: 'pending', monitorTaskDueAt: new Date(Date.now() - 30000).toISOString() });
  assert.equal(b.tone, 'check');
});

test('the counters are optional, the banner still shows without them', () => {
  // The local status payload carries no accountsDone / accountsTotal / elapsedSec.
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true });
  assert.equal(b.tone, 'check');
  assert.equal(b.big, '');
  assert.equal(b.cap, '');
  assert.ok(!b.l2.includes('undefined'));
});

test('no copy contains an em dash', () => {
  const all = [
    bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, liveAccount: 'a@b.c', accountsDone: 0, accountsTotal: 2 }),
    bannerFor({ running: true, live: true, liveAccount: 'a@b.c', currentAction: { leadName: 'X' }, batchDone: 1, batchSize: 8 }),
    bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, checkStopping: true }),
    bannerFor({ state: 'monitoring', monitorTaskStatus: 'pending', monitorTaskDueAt: new Date(Date.now() - 30000).toISOString() }),
  ];
  for (const b of all) {
    assert.ok(!`${b.l1}${b.l2}${b.cap || ''}`.includes('—'), `em dash in: ${b.l1}`);
  }
});
