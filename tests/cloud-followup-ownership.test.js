import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollOnce } from '../src/cloud-followup-poller.js';
import { enqueuePrimaryTask, loadTasks, markTask, stopTaskOwner, selectDue } from '../src/primary-tasks.js';

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-cloud-ownership-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  const offered = { taskId: '17', campaignId: 'cloud-campaign', campaignRunId: 'cloud-run',
    profileId: 'account', leadUrl: 'fixture-lead', body: 'fixture-body', threadUrl: 'fixture-thread', ...extra };
  let acks = 0;
  const deps = {
    getOperatorEmail: () => 'fixture@example.test', getLocalFollowups: async () => ({ followups: [offered] }),
    enqueuePrimaryTask: task => enqueuePrimaryTask(task, file),
    loadDrained: async () => [], saveDrained: async () => {},
    ackLocalFollowups: async ids => { acks++; return { delegated: ids.length }; }, log() {}, now: () => 10,
  };
  return { file, offered, deps, acks: () => acks };
}

test('handoff preserves captured ownership, and a completed task survives a lost receipt', async t => {
  const f = await fixture(t);
  await pollOnce(f.deps);
  const [stored] = await loadTasks(f.file);
  assert.equal(stored.campaignRunId, 'cloud-run');
  assert.equal(selectDue([stored], 10).length, 1);
  await markTask(stored.id, 'done', {}, f.file);
  await pollOnce({ ...f.deps, now: () => 20 });
  const tasks = await loadTasks(f.file);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'done');
});

test('legacy cloud tasks remain review-held on repeated handoffs', async t => {
  const f = await fixture(t, { campaignRunId: '' });
  await pollOnce(f.deps);
  await pollOnce(f.deps);
  const tasks = await loadTasks(f.file);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'needs-review');
  assert.deepEqual(selectDue(tasks, 10), []);
});

test('a locally recorded Stop blocks late cloud handoff for that run only', async t => {
  const f = await fixture(t);
  await stopTaskOwner(f.offered, f.file);
  await pollOnce(f.deps);
  f.offered.taskId = '18'; f.offered.campaignRunId = 'other-run';
  await pollOnce(f.deps);
  const tasks = await loadTasks(f.file);
  assert.equal(tasks.find(t => t.sourceTaskId === '17').status, 'cancelled');
  assert.deepEqual(selectDue(tasks, 10).map(t => t.sourceTaskId), ['18']);
});

test('failed receipt persistence prevents acknowledgement; retry retains one task', async t => {
  const f = await fixture(t);
  const first = await pollOnce({ ...f.deps, saveDrained: async () => { throw new Error('fixture disk failure'); } });
  assert.equal(first.acked, 0);
  assert.equal(f.acks(), 0);
  await pollOnce(f.deps);
  assert.equal((await loadTasks(f.file)).length, 1);
  assert.equal(f.acks(), 1);
});

test('failed acknowledgement is not reported as successful', async t => {
  const f = await fixture(t);
  const result = await pollOnce({ ...f.deps, ackLocalFollowups: async () => { throw new Error('fixture network failure'); } });
  assert.equal(result.acked, 0);
});

test('HTTP error responses and missing receipts are not acknowledgement evidence', async t => {
  const f = await fixture(t);
  for (const response of [{ error: 'HTTP 503' }, {}, undefined, { delegated: 0 }]) {
    const result = await pollOnce({ ...f.deps, ackLocalFollowups: async () => response });
    assert.equal(result.acked, 0);
  }
});
