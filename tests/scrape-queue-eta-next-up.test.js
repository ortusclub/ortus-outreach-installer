// A 2-job Sales Nav scrape on ONE account announced "starts in ~~3m" while
// nothing was waiting at all (operator, 2026-09-01).
//
// Two defects, one number:
//
//  1. The engine sets etaMs 0 for the job at the front of the line. Its own
//     test pins it: assert(J.jA.etaMs === 0, "job #1 ETA is 0 (next up)").
//     0 is falsy, so `jobs.find(j => j.state === 'queued' && j.etaMs)` skipped
//     the next-up job and returned the SECOND one, whose ETA became the whole
//     campaign's headline.
//  2. fmtEta() already returns "~3m", and the template prepended another "~".
//
// And the 3 itself is not a wait: it is DEFAULT_AVG_JOB_MS in the engine's
// redis-store.js, the placeholder for how long ONE scrape job takes before
// there are timing samples. No code sleeps on it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fmtEta } from '../public/js/scrape-board.mjs';

const app = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

// Lift the queueEta expression and the queued headline line out of app.js and
// run them, so this tests the shipped code rather than a copy of it.
function queueEtaFor(jobs) {
  const start = app.indexOf('queueEta: (() => {');
  assert.ok(start > 0, 'queueEta block not found');
  const end = app.indexOf('})(),', start) + '})()'.length;
  const expr = app.slice(start + 'queueEta: '.length, end);
  return new Function('jobs', 'fmtEta', `return (${expr});`)(jobs, fmtEta);
}

function headlineFor(queueEta) {
  const line = app.split('\n').find((l) => l.includes("else if (state === 'queued') l2 ="));
  assert.ok(line, 'queued headline line not found');
  const expr = line.slice(line.indexOf('l2 =') + 4).replace(/;$/, '');
  return new Function('s', `return (${expr});`)({ queueEta });
}

const front = { state: 'queued', position: 1, etaMs: 0 };
const second = { state: 'queued', position: 2, etaMs: 180000 };

test('THE BUG: a next-up job must not report the job behind it', () => {
  assert.equal(queueEtaFor([front, second]), '',
    'the campaign starts now; ~3m belongs to job #2, not to the campaign');
});

test('order in the array does not matter — position does', () => {
  assert.equal(queueEtaFor([second, front]), '');
});

test('a genuine wait is still reported', () => {
  // Nothing of ours is next up: the front of OUR queue is #2.
  assert.equal(queueEtaFor([second]), '~3m');
});

test('no queued jobs means no estimate', () => {
  assert.equal(queueEtaFor([{ state: 'running' }, { state: 'done' }]), '');
});

test('a queued job with no usable estimate says nothing rather than guessing', () => {
  assert.equal(queueEtaFor([{ state: 'queued', position: 4 }]), '');
  assert.equal(queueEtaFor([{ state: 'queued', position: 4, etaMs: null }]), '');
});

test('the headline no longer doubles the tilde', () => {
  const l2 = headlineFor('~3m');
  assert.equal(l2, 'starts in ~3m');
  assert.ok(!l2.includes('~~'), 'fmtEta already supplies the tilde');
});

test('a next-up campaign says so instead of going blank', () => {
  assert.match(headlineFor(''), /next up/i);
});

test('the board keeps 0 so the strip agrees with the card', () => {
  const board = fs.readFileSync(fileURLToPath(new URL('../public/js/scrape-board.mjs', import.meta.url)), 'utf8');
  assert.ok(!/filter\(\(j\) => j\.etaMs\)/.test(board), '0 must not be filtered out as falsy');
  assert.equal((board.match(/Number\.isFinite\(j\.etaMs\)/g) || []).length, 2,
    'both grouping functions must keep next-up jobs');
});
