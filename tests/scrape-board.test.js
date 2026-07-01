import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EMAIL, mergeCampaignsWithJobs, campaignStatus, toggleDecision, fmtEta,
  groupJobsIntoCampaigns, baseTabName,
} from '../public/js/scrape-board.mjs';

test('baseTabName strips the trailing batch suffix', () => {
  assert.equal(baseTabName('Results'), 'Results');
  assert.equal(baseTabName('Results 3'), 'Results');
  assert.equal(baseTabName('London CFOs 12'), 'London CFOs');
  assert.equal(baseTabName(''), '');
});

test('groupJobsIntoCampaigns groups a launch across operators and marks ownership', () => {
  const jobs = [
    // Operator A — one launch, two URLs → tabs "Results", "Results 2"
    { userId: 'op_aaa', ownerEmail: 'a@ortus.com', campaignName: 'London CFOs', sheetUrl: 's1', tabName: 'Results', searchUrl: 'u1', profileId: 'p1', state: 'running', profiles: 10 },
    { userId: 'op_aaa', ownerEmail: 'a@ortus.com', campaignName: 'London CFOs', sheetUrl: 's1', tabName: 'Results 2', searchUrl: 'u2', profileId: 'p2', state: 'queued', position: 3, etaMs: 60000 },
    // Operator B — different install, no echoed email (engine dropped it)
    { userId: 'op_bbb', sheetUrl: 's2', tabName: 'Leads', searchUrl: 'u3', profileId: 'p3', state: 'done', profiles: 40 },
  ];
  const strips = groupJobsIntoCampaigns(jobs, { currentEmail: 'a@ortus.com', currentOperatorId: 'op_aaa' });
  assert.equal(strips.length, 2);
  const a = strips.find((s) => s.userId === 'op_aaa');
  const b = strips.find((s) => s.userId === 'op_bbb');
  // A: one strip, two jobs, named + owned by the viewer
  assert.equal(a.jobs.length, 2);
  assert.equal(a.name, 'London CFOs');
  assert.equal(a.owner, 'a@ortus.com');
  assert.equal(a.mine, true);
  assert.deepEqual(a.searchUrls, ['u1', 'u2']);
  assert.deepEqual(a.profileIds, ['p1', 'p2']);
  assert.equal(a.status, 'running');
  assert.equal(a.minPosition, 3);
  // B: someone else's — no email echoed, falls back to a short install tag, not mine
  assert.equal(b.mine, false);
  assert.equal(b.name, 'Leads');
  assert.match(b.owner, /^operator /);
});

test('mergeCampaignsWithJobs attaches jobs + computed fields (flat shape) per record', () => {
  const campaigns = [
    { id: 'sc_1', name: 'A', owner: 'a@b', searchUrls: ['u1', 'u2'], profileIds: ['p1', 'p2'] },
    { id: 'sc_2', name: 'B', owner: 'c@d', searchUrls: ['u3'], profileIds: ['p3'] },
  ];
  const jobs = [
    { id: 'j1', searchUrl: 'u1', state: 'running', profiles: 118, position: 0 },
    { id: 'j2', searchUrl: 'u2', state: 'done', profiles: 240, position: 0 },
    { id: 'j3', searchUrl: 'u3', state: 'queued', profiles: 0, position: 2, etaMs: 120000 },
  ];
  const merged = mergeCampaignsWithJobs(campaigns, jobs);
  const a = merged.find((m) => m.id === 'sc_1');
  const b = merged.find((m) => m.id === 'sc_2');
  // flat shape: record fields are spread at top level, not nested under `campaign`
  assert.equal(a.name, 'A');
  assert.equal(a.owner, 'a@b');
  assert.equal(a.jobs.length, 2);
  assert.equal(a.status, 'running');
  assert.equal(a.totalProfiles, 358);
  assert.equal(a.done, 1);
  assert.equal(b.status, 'queued');
  assert.equal(b.minPosition, 2);
  assert.equal(b.etaMs, 120000);
});

test('campaignStatus precedence: running > queued > error > done > idle', () => {
  assert.equal(campaignStatus([{ state: 'done' }, { state: 'running' }]), 'running');
  assert.equal(campaignStatus([{ state: 'queued' }, { state: 'done' }]), 'queued');
  assert.equal(campaignStatus([{ state: 'error' }, { state: 'cancelled' }]), 'error');
  assert.equal(campaignStatus([{ state: 'done' }, { state: 'done' }]), 'done');
  assert.equal(campaignStatus([]), 'idle');
});

test('toggleDecision: owner and admin skip confirm; stranger needs it', () => {
  assert.deepEqual(toggleDecision({ currentEmail: 'a@b', ownerEmail: 'a@b' }), { needsConfirm: false, isAdmin: false });
  assert.deepEqual(toggleDecision({ currentEmail: ADMIN_EMAIL, ownerEmail: 'a@b' }), { needsConfirm: false, isAdmin: true });
  assert.deepEqual(toggleDecision({ currentEmail: 'x@y', ownerEmail: 'a@b' }), { needsConfirm: true, isAdmin: false });
});

test('fmtEta formats minutes/hours and guards empties', () => {
  assert.equal(fmtEta(0), '—');
  assert.equal(fmtEta(-5), '—');
  assert.equal(fmtEta(120000), '~2m');
  assert.equal(fmtEta(3900000), '~1h 5m');
});
