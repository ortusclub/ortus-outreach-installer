import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CADENCE_MINUTES,
  MAX_CADENCE_MINUTES,
  clampCadenceMinutes,
} from '../public/js/campaign-modes.mjs';

test('min is 60 (1 hour), max is 720 (12 hours)', () => {
  assert.equal(MIN_CADENCE_MINUTES, 60);
  assert.equal(MAX_CADENCE_MINUTES, 720);
});

test('honors in-range values exactly', () => {
  assert.equal(clampCadenceMinutes(60), 60);
  assert.equal(clampCadenceMinutes(120), 120);
  assert.equal(clampCadenceMinutes(360), 360);
  assert.equal(clampCadenceMinutes(720), 720);
});

test('raises below-min values up to 60', () => {
  assert.equal(clampCadenceMinutes(15), 60);
  assert.equal(clampCadenceMinutes(30), 60);
  assert.equal(clampCadenceMinutes(1), 60);
});

test('lowers above-max values down to 720', () => {
  assert.equal(clampCadenceMinutes(9999), 720);
});

test('falls back to 60 on garbage / missing', () => {
  assert.equal(clampCadenceMinutes('banana'), 60);
  assert.equal(clampCadenceMinutes(undefined), 60);
  assert.equal(clampCadenceMinutes(null), 60);
  assert.equal(clampCadenceMinutes(NaN), 60);
});
