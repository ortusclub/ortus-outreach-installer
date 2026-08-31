import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLatestMonitoringSweep, monitoringRecovery } from '../public/js/monitor-sweep-summary.mjs';

test('an unavailable sender does not count as successfully checked', () => {
  const result = summarizeLatestMonitoringSweep([
    "Check started — this campaign's accounts (3 accounts) · 18:01",
    'sean@ortus.solutions — 1 newly accepted, 22 lead row(s) updated · 18:01',
    'Juan C. Rojas · introduced · 18:01',
    'cindy@ortus.solutions — 0 newly accepted, 42 lead row(s) updated · 18:03',
    'manoj@ortus.solutions — needs re-login in GoLogin, skipped · 18:04',
    'Check finished with an error — Action required: manoj@ortus.solutions: log back in, then Retry · 18:04',
  ], ['sean@ortus.solutions', 'cindy@ortus.solutions', 'manoj@ortus.solutions']);
  assert.equal(result.checked, 2);
  assert.equal(result.expected, 3);
  assert.equal(result.accepted, 1);
  assert.equal(result.introduced, 1);
  assert.equal(result.incomplete, true);
  assert.equal(result.accounts.find((a) => a.account === 'manoj@ortus.solutions').action, 'Log back in, then Retry');
});

test('session expiry becomes concise operator copy and keeps the raw URL out of the card text', () => {
  const recovery = monitoringRecovery('damiano@ortus.solutions: Recent-connections data was not retrieved: session-expired (redirected to https://www.linkedin.com/uas/login?session_redirect=x)');
  assert.equal(recovery.headline, 'Damiano’s LinkedIn session expired');
  assert.equal(recovery.result, 'Damiano needs login');
  assert.equal(recovery.action, 'Log in, then retry');
  assert.doesNotMatch(recovery.detail, /https?:\/\//);
});

test('the reported SAS sweep preserves its one acceptance and one introduction', () => {
  const result = summarizeLatestMonitoringSweep([
    "Check started — this campaign's accounts (3 accounts) · 11:13",
    'zhelenandriushz@gmail.com — 0 newly accepted, 37 lead row(s) updated · 11:13',
    'damiano@ortus.solutions — session expired, needs re-login in GoLogin · 11:14',
    'emanuele.circi@ortus.solutions — 1 newly accepted, 12 lead row(s) updated · 11:14',
    'Camila Ferrari · connection accepted · 11:15',
    'Camila Ferrari · introduced · 11:15',
    'Check finished with an error — Incomplete check: 2/3 available accounts retrieved valid recent-connections data. damiano@ortus.solutions: session-expired (redirected to https://www.linkedin.com/uas/login) · 11:15',
  ], ['zhelenandriushz@gmail.com', 'damiano@ortus.solutions', 'emanuele.circi@ortus.solutions']);
  assert.equal(result.checked, 2);
  assert.equal(result.accepted, 1);
  assert.equal(result.introduced, 1);
});

test('profile IDs and logged emails do not double the expected account count', () => {
  const result = summarizeLatestMonitoringSweep([
    "Check started — this campaign's accounts (3 accounts) · 18:01",
    'sean@ortus.solutions — 1 newly accepted, 22 lead row(s) updated · 18:01',
    'cindy@ortus.solutions — 0 newly accepted, 42 lead row(s) updated · 18:03',
    'manoj@ortus.solutions — needs re-login in GoLogin, skipped · 18:04',
    'Check finished with an error — Action required: manoj@ortus.solutions: log back in, then Retry · 18:04',
  ], ['profile-sean', 'profile-cindy', 'profile-manoj']);
  assert.equal(result.checked, 2);
  assert.equal(result.expected, 3);
  assert.equal(result.incomplete, true);
});
