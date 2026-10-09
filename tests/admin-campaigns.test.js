import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_EMAILS, isAdminEmail } from '../public/js/admin-policy.mjs';
import { buildAdminOverview } from '../src/admin-campaigns.js';
import { createConnectionHistory } from '../src/connection-run-history.js';
import { canViewCampaign } from '../src/campaign-visibility.js';
import { adminOnly } from '../src/admin-access.js';

test('admin API guard rejects ordinary operators before data handlers can run', () => {
  const guard = adminOnly(req => isAdminEmail(req.user));
  for (const email of ['person@ortusclub.com', 'antonio@ortusclub.com', 'antoniov@ortusclub.com', '']) {
    let status, payload, reachedData = false;
    const res = { status(code) { status = code; return this; }, json(value) { payload = value; } };
    guard({ user: email, operatorEmail: 'sam@ortusclub.com' }, res, () => { reachedData = true; });
    assert.equal(status, 403);
    assert.equal(payload.error, 'Admin only');
    assert.equal(reachedData, false);
  }
  for (const email of ADMIN_EMAILS) {
    let reachedData = false;
    guard({ user: email, operatorEmail: 'sam@ortusclub.com' }, {}, () => { reachedData = true; });
    assert(reachedData);
  }
});

test('the eleven admins can access only campaigns belonging to their login company', () => {
  assert.equal(ADMIN_EMAILS.size, 11);
  for (const email of ['sam', 'mickey', 'stevenj', 'ej', 'mara', 'anya', 'ina', 'jerimiah', 'andrrim.krenzi'].map(n => n + '@ortusclub.com').concat('info@linkedvelocity.com', 'info@apexstrategy.io')) {
    assert(isAdminEmail(email.toUpperCase()));
    const domain = email.split('@')[1];
    assert(canViewCampaign({ owner: `staff@${domain}`, config: { matureWarm: true } }, { email, admin: isAdminEmail(email) }));
    for (const other of ['ortusclub.com', 'linkedvelocity.com', 'apexstrategy.io'].filter(d => d !== domain)) {
      assert(!canViewCampaign({ owner: `staff@${other}`, config: { matureWarm: true } }, { email, admin: true }));
    }
  }
  for (const email of ['antonio@ortusclub.com', 'antoniov@ortusclub.com', 'someone@ortusclub.com', 'sam@ortusclub.com.evil']) {
    assert(!isAdminEmail(email));
    assert(!canViewCampaign({ owner: 'staff@linkedvelocity.com', config: { matureWarm: true } }, { email, admin: isAdminEmail(email) }));
  }
});
test('reruns share a permanent campaign ID; names alone never merge campaigns', () => {
  const result = buildAdminOverview({ cloud: [
    { id: 'old', name: 'Same', owner: 'a', status: 'done', config: { campaignId: 'permanent' } },
    { id: 'new', name: 'Same', owner: 'a', status: 'running', config: { campaignId: 'permanent' } },
    { id: 'other', name: 'Same', owner: 'b', status: 'queued' },
    { id: 'paused', name: 'Paused', owner: 'a', status: 'paused' },
  ], history: [{ runId: 'old', name: 'Same', campaignId: 'permanent' }] });
  assert.equal(result.campaigns.length, 3);
  assert.equal(result.campaigns.find(c => c.id === 'outreach:permanent').runs.length, 2);
  assert.deepEqual(result.categories[0], { id: 'outreach', total: 3, scheduled: 0, running: 1, haveRun: 2, waiting: 2, finishedRuns: 1 });
});
test('maturing and Sales Nav counts reflect campaigns rather than account jobs', () => {
  const result = buildAdminOverview({ cloud: [{ id: 'm', status: 'running', config: { matureWarm: true } }],
    scrapes: [{ id: 's', owner: 'sam', jobs: [
      { id: 'j1', runId: 'a', state: 'done', profiles: 10 },
      { id: 'j2', runId: 'a', state: 'done', profiles: 20 },
      { id: 'j3', runId: 'b', state: 'running' },
    ] }] });
  assert.equal(result.categories.find(c => c.id === 'maturing').running, 1);
  assert.equal(result.categories.find(c => c.id === 'salesnav').running, 1);
  const scrape = result.campaigns.find(c => c.category === 'salesnav');
  assert.equal(scrape.runs.length, 2);
  assert.equal(scrape.runs.find(r => r.id === 's:a').processed, 30);
});
test('Connection DB history survives restart with its original actor and interrupted state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-history-'));
  try {
    const path = join(dir, 'history.json');
    const store = createConnectionHistory(path);
    store.start({ startedAt: '2026-10-09T12:00:00Z', total: 2 }, 'sam@ortusclub.com', 'Collect');
    store.update({ running: true, total: 2, done: 1, log: ['one collected'] });
    const restored = createConnectionHistory(path);
    assert.equal(restored.list()[0].status, 'interrupted');
    assert.equal(restored.list()[0].owner, 'sam@ortusclub.com');
    assert.deepEqual(restored.get(restored.list()[0].id).log, ['one collected']);
    restored.start({ total: 1 }, 'ej@ortusclub.com', 'Check');
    restored.update({ running: false, total: 1, done: 1, log: ['done'] });
    assert.equal(createConnectionHistory(path).list()[1].status, 'done');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
