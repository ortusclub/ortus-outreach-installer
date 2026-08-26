import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLatestMonitoringSweep } from '../public/js/monitor-sweep-summary.mjs';

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
