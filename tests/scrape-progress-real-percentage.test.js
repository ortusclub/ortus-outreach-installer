// The scrape percentage counted only FINISHED searches, so a one-search scrape
// read "0% · 0 of 1 searches done" through 1,270 leads and 51 pages, and the
// operator's 2,494-lead run sat on 0% for seventeen minutes. The engine now
// reports each job's page ceiling, so a running job counts by its pages.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');

/** Lift a top-level function out of app.js so it can be called in isolation. */
function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in app.js`);
  let i = SRC.indexOf('{', SRC.indexOf(')', start));
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${SRC.slice(start, i + 1)}; return ${name};`)();
}

const scrapeProgressUnits = lift('scrapeProgressUnits');

test('a finished search counts as a whole one', () => {
  assert.equal(scrapeProgressUnits([{ state: 'done' }, { state: 'done' }]), 2);
});

test('a running search counts by its pages, not as zero', () => {
  const u = scrapeProgressUnits([{ state: 'running', pages: 50, maxPages: 100 }]);
  assert.ok(u > 0.49 && u < 0.51, `expected about half a search, got ${u}`);
});

test("the operator's stuck run now moves: page 17 of 100 is no longer 0%", () => {
  const jobs = [{ state: 'running', pages: 17, maxPages: 100 }];
  const units = scrapeProgressUnits(jobs);
  const pct = Math.min(100, Math.round((Math.max(units, 0) / jobs.length) * 100));
  assert.equal(pct, 17);
});

test('a running search never reads as finished, even on its last page', () => {
  const u = scrapeProgressUnits([{ state: 'running', pages: 100, maxPages: 100 }]);
  assert.ok(u < 1, `a running job must stay under a whole search, got ${u}`);
  assert.ok(u > 0.9);
});

test('no page ceiling means no invented fraction', () => {
  // maxPages 0 = LinkedIn never gave a total. The scrape log says so out loud;
  // the bar must not make a number up.
  assert.equal(scrapeProgressUnits([{ state: 'running', pages: 40, maxPages: 0 }]), 0);
  assert.equal(scrapeProgressUnits([{ state: 'running', pages: 40 }]), 0);
});

test('queued, errored and cancelled searches contribute nothing', () => {
  assert.equal(scrapeProgressUnits([
    { state: 'queued', pages: 0, maxPages: 100 },
    { state: 'error', pages: 5, maxPages: 100 },
    { state: 'cancelled', pages: 5, maxPages: 100 },
  ]), 0);
});

test('mixed run: one done, one half way', () => {
  const u = scrapeProgressUnits([
    { state: 'done' },
    { state: 'running', pages: 25, maxPages: 50 },
  ]);
  assert.ok(u > 1.49 && u < 1.51, `got ${u}`);
});

test('junk in the job list never throws', () => {
  assert.equal(scrapeProgressUnits([null, undefined, {}]), 0);
  assert.equal(scrapeProgressUnits(null), 0);
  assert.equal(scrapeProgressUnits([]), 0);
});

test('both cards use the fractional progress, not just finished searches', () => {
  // Card #1 (dashboard strip) and card #2 (#active-card) both compute pct.
  const pcts = SRC.match(/const pct = [^\n]*\n/g) || [];
  const scrapePcts = pcts.filter((l) => /units/.test(l));
  assert.ok(scrapePcts.length >= 2, `expected both scrape cards to use units, found ${scrapePcts.length}`);
});

test('indeterminate is only for a scrape with genuinely nothing to measure', () => {
  const i = SRC.indexOf('const indeterminate =');
  assert.ok(i !== -1);
  const line = SRC.slice(i, SRC.indexOf('\n', i));
  assert.match(line, /units === 0/, 'a scrape with page progress must not show an indeterminate bar');
});
