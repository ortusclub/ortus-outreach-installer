// Sales Nav scrape logging: the board-diff event source, the derived board id,
// and the durable writer (levels + rotation + the id it reads back under).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  diffBoardEvents, scrapeCampaignId, groupJobsIntoCampaigns,
} from '../public/js/scrape-board.mjs';
import {
  appendScrapeLog, appendAction, readScrapeLog, __setDirForTests,
} from '../src/scrape-campaign-logs.js';

const camp = (id, jobs, extra = {}) => ({
  id, jobs, status: 'running',
  totalProfiles: jobs.reduce((n, j) => n + (j.profiles || 0), 0), ...extra,
});
const msgs = (evs) => evs.map((e) => e.message);

test('a campaign seen for the first time emits nothing', () => {
  const next = [camp('c1', [{ id: 'j1', state: 'running' }])];
  assert.deepEqual(diffBoardEvents([], next), []);
});

test('job state transitions become log lines', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'queued', tabName: 'Results', profileId: 'p1234567890' }])];
  const next = [camp('c1', [{ id: 'j1', state: 'running', tabName: 'Results', profileId: 'p1234567890' }])];
  const out = diffBoardEvents(prev, next);
  assert.equal(out.length, 1);
  assert.equal(out[0].campaignId, 'c1');
  assert.match(out[0].message, /^▶ {2}Started — Results · p1234567/);
});

test('a finished job reports its lead and page totals at ok level', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }])];
  const next = [camp('c1', [{ id: 'j1', state: 'done', profiles: 42, pages: 3 }])];
  const [ev] = diffBoardEvents(prev, next);
  assert.match(ev.message, /42 lead\(s\) · 3 page\(s\)/);
  assert.equal(ev.level, 'ok');
});

test("a failed job surfaces the engine's reason, and says so when there isn't one", () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }, { id: 'j2', state: 'running' }])];
  const next = [camp('c1', [
    { id: 'j1', state: 'error', error: 'sheet not shared' },
    { id: 'j2', state: 'error' },
  ])];
  const out = diffBoardEvents(prev, next);
  assert.equal(out.length, 2);
  assert.match(out[0].message, /sheet not shared/);
  assert.match(out[1].message, /no reason reported by the engine/);
  assert.ok(out.every((e) => e.level === 'err'));
});

test('a cancelled job records what it collected before it was killed', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }])];
  const next = [camp('c1', [{ id: 'j1', state: 'cancelled', profiles: 7 }])];
  const [ev] = diffBoardEvents(prev, next);
  assert.match(ev.message, /Cancelled.*7 lead\(s\) collected/);
  assert.equal(ev.level, 'warn');
});

test('a newly queued job is logged; a job that vanishes is not', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }])];
  const next = [camp('c1', [{ id: 'j1', state: 'running' }, { id: 'j2', state: 'queued', tabName: 'Results 2' }])];
  const out = diffBoardEvents(prev, next);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /Queued — Results/);
});

test('progress is logged only when the lead count actually moves', () => {
  const stall = diffBoardEvents(
    [camp('c1', [{ id: 'j1', state: 'running', profiles: 10 }])],
    [camp('c1', [{ id: 'j1', state: 'running', profiles: 10 }])],
  );
  assert.deepEqual(stall, [], 'a stalled scrape must leave a visible gap, not a heartbeat');

  const moved = diffBoardEvents(
    [camp('c1', [{ id: 'j1', state: 'running', profiles: 10 }])],
    [camp('c1', [{ id: 'j1', state: 'running', profiles: 25 }])],
  );
  assert.match(moved[0].message, /25 lead\(s\) so far \(\+15\)/);
});

test('completion emits the total line the scrape never had', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }], { status: 'running' })];
  const next = [camp('c1', [{ id: 'j1', state: 'done', profiles: 60, pages: 4 }], { status: 'done' })];
  const out = diffBoardEvents(prev, next);
  const total = out.find((e) => e.message.startsWith('Σ'));
  assert.ok(total, 'expected a Σ total line');
  assert.match(total.message, /60 lead\(s\) · 4 page\(s\) · 1 account-run\(s\)/);
  assert.equal(total.level, 'ok');
});

test('completion is emitted once, not on every subsequent poll', () => {
  const done = [camp('c1', [{ id: 'j1', state: 'done', profiles: 60 }], { status: 'done' })];
  assert.deepEqual(diffBoardEvents(done, done), []);
});

test('a campaign that ends with no successful run says so', () => {
  const prev = [camp('c1', [{ id: 'j1', state: 'running' }], { status: 'running' })];
  const next = [camp('c1', [{ id: 'j1', state: 'error', error: 'x' }], { status: 'error' })];
  const out = diffBoardEvents(prev, next);
  assert.ok(out.some((e) => /ended with no successful runs/.test(e.message)));
});

test('the derived board id matches the id the board itself groups under', () => {
  const jobs = [{
    id: 'j1', userId: 'op_abc', sheetUrl: 'https://sheet/1',
    campaignName: 'Growth EU', tabName: 'Growth EU 2', state: 'running',
  }];
  const [strip] = groupJobsIntoCampaigns(jobs, {});
  const derived = scrapeCampaignId({ userId: 'op_abc', sheetUrl: 'https://sheet/1', base: 'Growth EU' });
  assert.equal(derived, strip.id, 'dispatch-time logging would land on an orphan strip');
});

test('the derived id falls back to the same default the grouping uses', () => {
  assert.equal(
    scrapeCampaignId({ userId: 'u', sheetUrl: 's', base: '   ' }),
    scrapeCampaignId({ userId: 'u', sheetUrl: 's', base: 'Sales Nav scrape' }),
  );
});

test('levels round-trip, and info is not stored (it is the default)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapelog-'));
  __setDirForTests(dir);
  await appendScrapeLog('eng_x', { message: 'plain', level: 'info' });
  await appendScrapeLog('eng_x', { message: 'boom', level: 'err', actor: 'a@b.c' });
  const lines = await readScrapeLog('eng_x');
  assert.equal(lines[0].level, undefined);
  assert.equal(lines[1].level, 'err');
  assert.equal(lines[1].actor, 'a@b.c');
});

test('engine-derived ids are readable back — the board id is the key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapelog-'));
  __setDirForTests(dir);
  await appendAction('eng_126clg5', { actor: 'antonio@ortusclub.com', admin: true, action: 'toggled OFF' });
  const lines = await readScrapeLog('eng_126clg5');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'toggled OFF by antonio@ortusclub.com (admin)');
});

test('the log rotates instead of growing without bound', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapelog-'));
  __setDirForTests(dir);
  const big = 'x'.repeat(2000);
  for (let i = 0; i < 400; i++) await appendScrapeLog('eng_r', { message: `${i} ${big}` });
  const size = (await fs.stat(path.join(dir, 'eng_r.ndjson'))).size;
  assert.ok(size < 512 * 1024 * 2, `expected rotation, file is ${size} bytes`);
  const lines = await readScrapeLog('eng_r', { limit: 10 });
  assert.match(lines[lines.length - 1].message, /^399 /, 'rotation must keep the most recent lines');
});
