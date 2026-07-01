import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EMAIL, mergeCampaignsWithJobs, campaignStatus, toggleDecision, fmtEta,
} from '../public/js/scrape-board.mjs';

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
