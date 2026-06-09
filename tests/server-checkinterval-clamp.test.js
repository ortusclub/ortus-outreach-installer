import { test } from 'node:test';
import assert from 'node:assert';
// The server intake MUST use the shared policy clamp — no inline duplicate.
import { clampCadenceMinutes } from '../public/js/campaign-modes.mjs';

test('server clamp accepts 1 hour (default/floor)', () => assert.equal(clampCadenceMinutes(60), 60));
test('server clamp accepts 12 hours (ceiling)', () => assert.equal(clampCadenceMinutes(720), 720));
test('server clamp raises old 15-min setting to 60', () => assert.equal(clampCadenceMinutes(15), 60));
test('server clamp raises old 30-min setting to 60', () => assert.equal(clampCadenceMinutes(30), 60));
test('server clamp lowers 9999 to 720', () => assert.equal(clampCadenceMinutes(9999), 720));
test('server clamp falls back to 60 on garbage', () => assert.equal(clampCadenceMinutes('banana'), 60));
