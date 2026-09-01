import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const HELPER = APP.slice(APP.indexOf('function _pushCloudEventNow('), APP.indexOf('window._pushCloudEventNow'));

test('logging an operator action also repaints the card', () => {
  assert.match(HELPER, /renderActiveCard\(s\)/,
    'the log line alone left the card untouched until the next poll');
});

test('it only repaints the campaign the card is actually showing', () => {
  assert.match(HELPER, /String\(s\.id\) === String\(id\)/);
});

test('it appends to the log instead of rebuilding it', () => {
  // Rebuilding from the event log alone drops every per-lead line.
  assert.match(HELPER, /\.concat\(\[\{ t: Date\.now\(\), line \}\]\)/);
  assert.ok(!/_mergeCloudLog\(\[\]/.test(HELPER), 'no empty-lead rebuild');
});

test('a repaint failure never breaks the action', () => {
  assert.match(HELPER, /catch \(_\)/);
});

test('every pre-answer operator line uses it — stop and resume, success and failure', () => {
  for (const needle of [
    '_pushCloudEventNow(id, keepMonitoring',                       // stop requested
    '_pushCloudEventNow(id, `⚠️ The VM did not confirm the stop',  // stop rejected
    '_pushCloudEventNow(id, fromStart',                            // resume requested
    '_pushCloudEventNow(id, `⚠️ The VM did not accept the restart',// resume rejected
    '_pushCloudEventNow(id, `⚠️ Could not reach the VM to resume', // resume unreachable
  ]) assert.ok(APP.includes(needle), `missing: ${needle}`);
});

test('the plain logger still exists for lines that are not operator actions', () => {
  assert.match(APP, /window\._pushCloudEvent = _pushCloudEvent;/);
  assert.ok(APP.includes("_pushCloudEvent(id, `⏰ Scheduled to restart"),
    'a scheduled restart has not resumed anything — it must not repaint as live');
});
