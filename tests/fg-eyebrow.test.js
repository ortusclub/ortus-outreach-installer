import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fgEyebrowWithPage } from '../public/js/fg-eyebrow.mjs';

test('fgEyebrowWithPage appends the page label', () => {
  assert.equal(fgEyebrowWithPage('● Sending', 'Apex Guesting Partner'), '● Sending · Apex Guesting Partner');
});

test('fgEyebrowWithPage appends Ortus too — same treatment for every page, not just non-default ones', () => {
  assert.equal(fgEyebrowWithPage('● Sending', 'Ortus Club'), '● Sending · Ortus Club');
});

// Older runs whose config predates the page picker carry no pageLabel — must
// render exactly as today, no stray separator or "undefined".
test('fgEyebrowWithPage degrades to the plain eyebrow when pageLabel is absent', () => {
  assert.equal(fgEyebrowWithPage('● Sending', ''), '● Sending');
  assert.equal(fgEyebrowWithPage('● Sending', undefined), '● Sending');
  assert.equal(fgEyebrowWithPage('● Sending', null), '● Sending');
});
