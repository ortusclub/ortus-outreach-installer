import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/resource-monitor.js';

const ALL_KEYS = [
  'RAM_THROTTLE_PCT',
  'RAM_RELEASE_PCT',
  'CPU_THROTTLE_LOAD_FACTOR',
  'CPU_RELEASE_LOAD_FACTOR',
  'THROTTLE_MULTIPLIER',
  'PARK_PAGE',
  'IDLE_PARKING_ENABLED',
];

function clearEnv() {
  for (const k of ALL_KEYS) delete process.env[k];
}

test('defaults when no env vars set', () => {
  clearEnv();
  const cfg = loadConfig();
  assert.equal(cfg.RAM_THROTTLE_PCT, 90);
  assert.equal(cfg.RAM_RELEASE_PCT, 80);
  assert.equal(cfg.CPU_THROTTLE_LOAD_FACTOR, 0.9);
  assert.equal(cfg.CPU_RELEASE_LOAD_FACTOR, 0.7);
  assert.equal(cfg.THROTTLE_MULTIPLIER, 2);
  assert.equal(cfg.PARK_PAGE, 'about:blank');
  assert.equal(cfg.IDLE_PARKING_ENABLED, true);
});

test('overrides from env', () => {
  clearEnv();
  process.env.RAM_THROTTLE_PCT = '75';
  process.env.THROTTLE_MULTIPLIER = '3';
  process.env.PARK_PAGE = 'https://www.google.com';
  process.env.IDLE_PARKING_ENABLED = 'false';
  const cfg = loadConfig();
  assert.equal(cfg.RAM_THROTTLE_PCT, 75);
  assert.equal(cfg.THROTTLE_MULTIPLIER, 3);
  assert.equal(cfg.PARK_PAGE, 'https://www.google.com');
  assert.equal(cfg.IDLE_PARKING_ENABLED, false);
  clearEnv();
});

test('invalid numeric env falls back to default (Number || default)', () => {
  clearEnv();
  process.env.RAM_THROTTLE_PCT = 'not-a-number';
  process.env.CPU_THROTTLE_LOAD_FACTOR = '';
  const cfg = loadConfig();
  assert.equal(cfg.RAM_THROTTLE_PCT, 90);
  assert.equal(cfg.CPU_THROTTLE_LOAD_FACTOR, 0.9);
  clearEnv();
});
