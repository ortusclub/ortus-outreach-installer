import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function body(name, nextName) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? src.indexOf(`async function ${nextName}(`, start + 1) : src.length;
  return src.slice(start, end);
}

test('VM check paints the requested state before awaiting the engine', () => {
  const fn = body('cloudCheckNow', 'cloudCheckLocal');
  const mark = fn.indexOf('_cloudCheckAsked.set(id, askedAt)');
  const render = fn.indexOf('renderCampaignsBoard()', mark);
  const request = fn.indexOf('await fetch(', render);
  assert.ok(mark >= 0 && render > mark && request > render,
    'the banner changes immediately, before the slow check-now request resolves');
});

test('local check paints immediately and clears its optimistic marker when done', () => {
  const fn = body('cloudCheckLocal', null);
  const mark = fn.indexOf('_cloudCheckAsked.set(id, askedAt)');
  const render = fn.indexOf('renderCampaignsBoard()', mark);
  const request = fn.indexOf("fetch('/api/bulk-check-now'", render);
  assert.ok(mark >= 0 && render > mark && request > render);
  assert.match(fn, /finally\s*\{[\s\S]*?_cloudCheckAsked\.get\(id\) === askedAt[\s\S]*?_cloudCheckAsked\.delete\(id\)[\s\S]*?renderCampaignsBoard\(\)/);
});
