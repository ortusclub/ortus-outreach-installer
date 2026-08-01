// The board countdown ticker has to find the DASHBOARD's cards.
//
// There are two boards in index.html: the dashboard renders into
// #campaigns-board, the Sales Nav Scraper page into #sn-board. Both carry
// class="sn-board". The 1-second countdown ticker was written with the ID
// selector `#sn-board ...`, so on the dashboard it matched nothing and the
// strip countdown never ticked — what looked like a 5-second tick was the board
// poll redrawing the strip, and the "frozen" report was that redraw being
// skipped by the anti-jank guard.
//
// There's no DOM in this test runner (pure-helper convention, no jsdom), so
// this asserts the contract at the source level: the ticker must select by the
// shared CLASS, and both containers must actually carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(root, 'public/js/app.js'), 'utf8');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');

// The ticker body, isolated so these assertions can't be satisfied by some
// unrelated selector elsewhere in a 20k-line file.
const ticker = (() => {
  const start = appJs.indexOf('function _tickVjCards(');
  assert.notEqual(start, -1, '_tickVjCards must exist — it is the board countdown ticker');
  return appJs.slice(start, appJs.indexOf('\n}', start));
})();

test('the ticker selects boards by CLASS, not by the scraper board id', () => {
  // Assert on the SELECTOR STRING, not the function text — the surrounding
  // comment legitimately names #sn-board while explaining the bug.
  const sel = ticker.match(/querySelectorAll\('([^']*sn-strip[^']*)'\)/);
  assert.ok(sel, 'the ticker must query for board strips');
  assert.match(sel[1], /^\.sn-board /, 'must select .sn-board (class) so it matches both boards');
  assert.doesNotMatch(sel[1], /#sn-board/, 'the id selector only matches the scraper page — the dashboard would never tick');
});

test('both board containers carry the class the ticker relies on', () => {
  for (const id of ['campaigns-board', 'sn-board']) {
    const tag = indexHtml.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `#${id} must exist in index.html`);
    assert.match(tag[0], /class="[^"]*\bsn-board\b/, `#${id} must carry class="sn-board"`);
  }
});

test('the ticker runs on its own interval, not from the render path', () => {
  // The freeze this replaced: _startVjTick was reachable only from
  // _fillVjCards, and the board's anti-jank skip returns before that call.
  assert.match(appJs, /setInterval\(_tickVjCards, 1000\)/, 'must be a plain module-level 1s interval');
  assert.doesNotMatch(appJs, /_startVjTick|_stopVjTick/, 'no render-path start/stop — that is what deadlocked');
});

test('a tick with nothing on screen does not tear down the interval', () => {
  // The old body did `if (!cards.length) { _stopVjTick(); return; }`, which
  // destroyed the ticker one second after load whenever every strip was
  // collapsed — and nothing restarted it.
  assert.match(ticker, /if \(!cards\.length\) return;/, 'empty match must be a no-op, never a stop');
});
