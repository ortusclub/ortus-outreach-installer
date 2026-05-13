import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppendLogger,
  registerAppender,
  unregisterAppender,
  appendCampaignLog,
  clearAllAppenders,
} from '../src/campaign-log-bus.js';

test('buildAppendLogger appends ISO-prefixed line to provided logs array', () => {
  const logs = [];
  const appender = buildAppendLogger({ logs, capLines: 100 });
  appender('hello');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[\d{4}-\d{2}-\d{2}T/);
  assert.match(logs[0], /hello$/);
});

test('buildAppendLogger respects ring-buffer cap', () => {
  const logs = ['old-line'];
  const appender = buildAppendLogger({ logs, capLines: 2 });
  appender('a');
  appender('b');
  assert.equal(logs.length, 2);
  // After 'old-line' was pushed out, we should have 'a' and 'b' at the end
  assert.match(logs[0], /\] a$/);
  assert.match(logs[1], /\] b$/);
});

test('buildAppendLogger is a no-op when logs array is null/undefined', () => {
  const appender = buildAppendLogger({ logs: null, capLines: 100 });
  // Must not throw
  appender('hello');
});

test('bus: registerAppender + appendCampaignLog routes line to registered appender', () => {
  clearAllAppenders();
  const received = [];
  registerAppender('sheet-1', 'profile-A', (line) => received.push(line));
  appendCampaignLog('sheet-1', 'profile-A', 'test-line');
  assert.deepEqual(received, ['test-line']);
});

test('bus: appendCampaignLog with unregistered key is a no-op (does not throw)', () => {
  clearAllAppenders();
  // Must not throw
  appendCampaignLog('nonexistent-sheet', 'nonexistent-profile', 'silent');
});

test('bus: unregisterAppender removes the routing', () => {
  clearAllAppenders();
  const received = [];
  registerAppender('sheet-2', 'profile-B', (line) => received.push(line));
  appendCampaignLog('sheet-2', 'profile-B', 'first');
  unregisterAppender('sheet-2', 'profile-B');
  appendCampaignLog('sheet-2', 'profile-B', 'second');
  assert.deepEqual(received, ['first']);
});

test('bus: appender that throws does NOT crash appendCampaignLog', () => {
  clearAllAppenders();
  registerAppender('sheet-3', 'profile-C', () => { throw new Error('boom'); });
  // Must not throw
  appendCampaignLog('sheet-3', 'profile-C', 'will-trigger-throw');
});
