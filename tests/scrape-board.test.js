import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EMAIL, groupJobsIntoCampaigns, campaignStatus, toggleDecision, fmtEta,
} from '../public/js/scrape-board.mjs';

test('groups engine jobs under the campaign whose searchUrls contain them', () => {
  const campaigns = [
    { id: 'sc_1', name: 'A', owner: 'a@b', searchUrls: ['u1', 'u2'], profileIds: ['p1', 'p2'] },
    { id: 'sc_2', name: 'B', owner: 'c@d', searchUrls: ['u3'], profileIds: ['p3'] },
  ];
  const jobs = [
    { id: 'j1', searchUrl: 'u1', state: 'running', profiles: 118, position: 0 },
    { id: 'j2', searchUrl: 'u2', state: 'done', profiles: 240, position: 0 },
    { id: 'j3', searchUrl: 'u3', state: 'queued', profiles: 0, position: 2, etaMs: 120000 },
  ];
  const groups = groupJobsIntoCampaigns(campaigns, jobs);
  const a = groups.find((g) => g.campaign.id === 'sc_1');
  const b = groups.find((g) => g.campaign.id === 'sc_2');
  assert.equal(a.jobs.length, 2);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'queued');
  assert.equal(b.minPosition, 2);
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
