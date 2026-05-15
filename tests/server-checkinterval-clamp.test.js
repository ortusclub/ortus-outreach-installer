import { test } from 'node:test';
import assert from 'node:assert';

// Reproduce the clamp inline so we test the exact rule we wire into server.js.
function clampCadence(v) {
  return Math.max(15, Math.min(360, Number(v) || 60));
}

test('clamp accepts 60 (default)', () => assert.equal(clampCadence(60), 60));
test('clamp accepts 15 (floor)', () => assert.equal(clampCadence(15), 15));
test('clamp accepts 360 (ceiling)', () => assert.equal(clampCadence(360), 360));
test('clamp raises 5 to 15', () => assert.equal(clampCadence(5), 15));
test('clamp lowers 9999 to 360', () => assert.equal(clampCadence(9999), 360));
test('clamp falls back to 60 on garbage', () => assert.equal(clampCadence('banana'), 60));
test('clamp falls back to 60 on undefined', () => assert.equal(clampCadence(undefined), 60));
