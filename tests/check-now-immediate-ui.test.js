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
  const paint = fn.indexOf("_paintAcceptanceCheckStartingNow(id, 'vm')", mark);
  const request = fn.indexOf('await fetch(', paint);
  assert.ok(mark >= 0 && paint > mark && request > paint,
    'the banner changes immediately, before the slow check-now request resolves');
});

test('VM check is single-flight and keeps the button locked while queued', () => {
  const fn = body('cloudCheckNow', 'cloudCheckLocal');
  assert.match(fn, /_cloudCheckAsked\.get\(id\)[\s\S]*?return false/,
    'a second click is rejected before another request or poller is created');
  assert.match(fn, /finally\s*\{\s*if \(btn && !queued\) btn\.disabled = false;\s*\}/,
    'a successfully queued check must not immediately re-enable its original button');
  assert.match(fn, /_cloudCheckAsked\.delete\(id\)[\s\S]*?VM check complete/,
    'the lock is released when the observed sweep finishes');
});

test('manual check lock covers the full worker recovery window', () => {
  assert.match(src, /const CLOUD_CHECK_ASK_TTL_MS = 15 \* 60 \* 1000/);
});

test('local check paints immediately and clears its optimistic marker when done', () => {
  const fn = body('cloudCheckLocal', null);
  const mark = fn.indexOf('_cloudCheckAsked.set(id, askedAt)');
  const paint = fn.indexOf("_paintAcceptanceCheckStartingNow(id, 'local')", mark);
  const request = fn.indexOf("fetch('/api/bulk-check-now'", paint);
  assert.ok(mark >= 0 && paint > mark && request > paint);
  assert.match(fn, /finally\s*\{[\s\S]*?_cloudCheckAsked\.get\(id\) === askedAt[\s\S]*?_cloudCheckAsked\.delete\(id\)[\s\S]*?renderCampaignsBoard\(\)/);
});

test('the immediate check painter updates both full card and dashboard copy', () => {
  const start = src.indexOf('function _paintAcceptanceCheckStartingNow');
  const end = src.indexOf('// Task 3 Part B', start);
  const fn = src.slice(start, end);
  assert.match(fn, /monitoringCheckInProgress: true/);
  assert.match(fn, /renderActiveCard\(window\.__cloudActiveStatus\)/);
  assert.match(fn, /renderCampaignsBoard\(\)/);
  assert.match(fn, /Sending stays stopped/);
});
