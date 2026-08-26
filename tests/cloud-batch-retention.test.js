import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('cloud sending cards share a retained verified turn counter', () => {
  assert.match(src, /function _cloudSendingTurn\(id, d\)/);
  assert.match(src, /line\.match\(\/\(\\d\+\)\\s\+of\\s\+\(\\d\+\)\\s\+this turn\/i\)/);
  assert.match(src, /done = Math\.max\(done, Number\(remembered\.done\) \|\| 0\)/);
  assert.match(src, /window\.__cloudActiveStatus\.batchDone = activeTurn\.done/);
  assert.match(src, /batchDone: _cloudSendingTurn\(c\.id, d\)\.done/);
});

test('Open sheet is rendered only in the canonical campaign control row', () => {
  assert.match(src, /if \(txt\.includes\('open sheet'\)\) \{ b\.style\.display = 'none'; return; \}/);
});
