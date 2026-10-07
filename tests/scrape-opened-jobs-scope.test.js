// openedScrapeJobs scopes the opened-scrape console to ONE scrape's jobs from the
// board cache. It returns null when the cache is cold / lacks that scrape, which
// is the signal for pollScrapeJobs to fetch the scrape's own record instead of
// falling back to the unscoped session jobs — the fix for "opening a running
// scrape shows the setup form until you refresh a few times".

import test from 'node:test';
import assert from 'node:assert/strict';
import { openedScrapeJobs } from '../public/js/scrape-board.mjs';

const JOBS = [{ id: 'j1', state: 'running' }, { id: 'j2', state: 'done' }];

test('cold cache (null) returns null → caller fetches the scoped record', () => {
  assert.equal(openedScrapeJobs(null, 'c1'), null);
  assert.equal(openedScrapeJobs(undefined, 'c1'), null);
});

test('cache without this scrape returns null (not another scrape\'s jobs)', () => {
  const campaigns = [{ id: 'other', jobs: JOBS }];
  assert.equal(openedScrapeJobs(campaigns, 'c1'), null);
});

test('cache with the scrape + jobs returns exactly that scrape\'s jobs', () => {
  const campaigns = [{ id: 'other', jobs: [] }, { id: 'c1', jobs: JOBS }];
  assert.deepEqual(openedScrapeJobs(campaigns, 'c1'), JOBS);
});

test('scrape present but no jobs array yet returns null (treat as cold)', () => {
  assert.equal(openedScrapeJobs([{ id: 'c1' }], 'c1'), null);
  assert.equal(openedScrapeJobs([{ id: 'c1', jobs: 'nope' }], 'c1'), null);
});

test('no cid returns null (a brand-new scrape uses the session jobs path)', () => {
  assert.equal(openedScrapeJobs([{ id: 'c1', jobs: JOBS }], ''), null);
  assert.equal(openedScrapeJobs([{ id: 'c1', jobs: JOBS }], null), null);
});
