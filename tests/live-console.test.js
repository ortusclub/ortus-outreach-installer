import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePillState, shouldShowConsole } from '../public/js/live-console.mjs';

test('module exports both helpers', () => {
  assert.equal(typeof computePillState, 'function');
  assert.equal(typeof shouldShowConsole, 'function');
});
