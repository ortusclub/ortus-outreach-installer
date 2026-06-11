import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  opsLogEvent,
  flushOpsLog,
  campaignLogAppendRun,
  _setFetchImpl,
  _setEnvImpl,
  _setAlertImpl,
  _resetForTest,
  _peekBufferForTest,
} from '../src/log-writer.js';

function makeFakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const out = await responder({ url, init, callIndex: calls.length - 1 });
    return out;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(obj) {
  return {
    status: 200,
    headers: { get: () => null },
    async text() { return JSON.stringify(obj); },
  };
}

beforeEach(() => _resetForTest());

// ─────────────────────────────────────────────────────────────────────────
// opsLogEvent — buffer behavior
// ─────────────────────────────────────────────────────────────────────────

test('opsLogEvent buffers events when URL is configured', () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  opsLogEvent({ name: 'C1', startedAt: '2026-05-17T09:14:00Z', operator: 'a@o.io' },
              { severity: 'INFO', event: 'Connection sent', account: 'kenya5@o.io' });
  opsLogEvent({ name: 'C1', startedAt: '2026-05-17T09:14:00Z', operator: 'a@o.io' },
              { severity: 'ERROR', event: 'Browser launch failed', details: '404' });

  const buf = _peekBufferForTest();
  assert.equal(buf.length, 2);
  assert.equal(buf[0].campaign, 'C1');
  assert.equal(buf[0].severity, 'INFO');
  assert.equal(buf[1].severity, 'ERROR');
  assert.equal(buf[1].details, '404');
});

test('opsLogEvent silently no-ops when URL unset', () => {
  _setEnvImpl(() => ({})); // no OPS_LOG_WEBAPP_URL
  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'x' });
  assert.equal(_peekBufferForTest().length, 0);
});

test('opsLogEvent fills in defaults for missing fields', () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  opsLogEvent(null, null);
  const buf = _peekBufferForTest();
  assert.equal(buf.length, 1);
  assert.equal(buf[0].severity, 'INFO');
  assert.equal(buf[0].campaign, '');
  assert.equal(buf[0].operator, '');
  assert.ok(buf[0].ts.match(/^\d{4}-\d{2}-\d{2}T/));
});

test('opsLogEvent never throws when fed garbage', () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  assert.doesNotThrow(() => opsLogEvent(undefined, undefined));
  assert.doesNotThrow(() => opsLogEvent({ name: null }, { severity: undefined }));
});

// ─────────────────────────────────────────────────────────────────────────
// flushOpsLog — sends buffered events
// ─────────────────────────────────────────────────────────────────────────

test('flushOpsLog POSTs all buffered events in one call', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ success: true, appended: 3 }));
  _setFetchImpl(fetchImpl);

  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'a' });
  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'b' });
  opsLogEvent({ name: 'C2' }, { severity: 'ERROR', event: 'c' });

  const result = await flushOpsLog();
  assert.equal(result.ok, true);
  assert.equal(result.sent, 3);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://example.com/ops');

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.action, 'appendEvents');
  assert.equal(body.events.length, 3);
  assert.equal(body.events[0].event, 'a');
  assert.equal(body.events[2].severity, 'ERROR');
  assert.equal(_peekBufferForTest().length, 0);
});

test('flushOpsLog is a no-op when buffer is empty', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ success: true }));
  _setFetchImpl(fetchImpl);

  const result = await flushOpsLog();
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('flushOpsLog is a no-op when URL unset (even if buffer non-empty)', async () => {
  // Buffer should be empty because the URL was unset at push time, but
  // double-check the flush path is also URL-guarded.
  _setEnvImpl(() => ({}));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ success: true }));
  _setFetchImpl(fetchImpl);

  const result = await flushOpsLog();
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('flushOpsLog returns events to buffer on network failure', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const fetchImpl = makeFakeFetch(() => { throw new Error('ECONNRESET'); });
  _setFetchImpl(fetchImpl);

  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'a' });
  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'b' });

  const result = await flushOpsLog();
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
  assert.equal(_peekBufferForTest().length, 2, 'events kept for retry');
});

test('flushOpsLog returns events to buffer on Apps Script error envelope', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ error: 'Unknown action: x' }));
  _setFetchImpl(fetchImpl);

  opsLogEvent({ name: 'C1' }, { severity: 'INFO', event: 'a' });
  const result = await flushOpsLog();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unknown action: x');
  assert.equal(_peekBufferForTest().length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// campaignLogAppendRun — immediate send
// ─────────────────────────────────────────────────────────────────────────

test('campaignLogAppendRun POSTs entry to campaign log URL', async () => {
  _setEnvImpl(() => ({ CAMPAIGN_LOG_WEBAPP_URL: 'https://example.com/campaigns' }));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ success: true, row: 12 }));
  _setFetchImpl(fetchImpl);

  const result = await campaignLogAppendRun({
    name: 'UK CFO Spring 26',
    operator: 'a@o.io',
    totalLeads: 320,
    processed: 47
  });
  assert.equal(result.ok, true);
  assert.equal(result.row, 12);
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.action, 'appendRun');
  assert.equal(body.entry.name, 'UK CFO Spring 26');
  assert.equal(body.entry.totalLeads, 320);
});

test('campaignLogAppendRun returns skipped:true when URL unset', async () => {
  _setEnvImpl(() => ({}));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ success: true }));
  _setFetchImpl(fetchImpl);

  const result = await campaignLogAppendRun({ name: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(fetchImpl.calls.length, 0);
});

test('campaignLogAppendRun returns ok:false on network failure (does not throw)', async () => {
  _setEnvImpl(() => ({ CAMPAIGN_LOG_WEBAPP_URL: 'https://example.com/campaigns' }));
  const fetchImpl = makeFakeFetch(() => { throw new Error('timeout'); });
  _setFetchImpl(fetchImpl);

  const result = await campaignLogAppendRun({ name: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
});

test('campaignLogAppendRun returns ok:false on Apps Script error envelope', async () => {
  _setEnvImpl(() => ({ CAMPAIGN_LOG_WEBAPP_URL: 'https://example.com/campaigns' }));
  const fetchImpl = makeFakeFetch(() => jsonResponse({ error: 'Bad shape' }));
  _setFetchImpl(fetchImpl);

  const result = await campaignLogAppendRun({ name: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Bad shape');
});

// ─────────────────────────────────────────────────────────────────────────
// 302 redirect handling — mirrors src/sheets-writer.js's pattern
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// v2.93 — structured payload + failure alert
// ─────────────────────────────────────────────────────────────────────────

test('opsLogEvent buffers structured phase/outcome/reason fields', () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  opsLogEvent(
    { name: 'C', startedAt: 't', operator: 'op' },
    { event: 'Outcome', account: 'kyra', phase: 'DM', outcome: 'sent', reason: '', leadUrl: '/in/x' },
  );
  const row = _peekBufferForTest()[0];
  assert.equal(row.phase, 'DM');
  assert.equal(row.outcome, 'sent');
  assert.equal(row.account, 'kyra');
  assert.equal(row.leadUrl, '/in/x');
});

test('repeated flush failures invoke the alert hook once past the threshold', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const alerts = [];
  _setAlertImpl((msg) => alerts.push(msg));
  _setFetchImpl(makeFakeFetch(() => jsonResponse({ error: 'boom' })));
  for (let i = 0; i < 4; i++) {
    opsLogEvent({ name: 'C', startedAt: 't', operator: 'op' }, { event: 'X' });
    await flushOpsLog();
  }
  assert.equal(alerts.length, 1, 'alert fires exactly once after the streak crosses the threshold');
});

test('a successful flush resets the failure streak', async () => {
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.com/ops' }));
  const alerts = [];
  _setAlertImpl((msg) => alerts.push(msg));
  let ok = false;
  _setFetchImpl(makeFakeFetch(() => ok ? jsonResponse({ success: true }) : jsonResponse({ error: 'boom' })));
  // two failures (below threshold of 3)
  for (let i = 0; i < 2; i++) {
    opsLogEvent({ name: 'C' }, { event: 'X' });
    await flushOpsLog();
  }
  // one success resets the streak
  ok = true;
  await flushOpsLog();
  // two more failures — still below threshold because the streak reset
  ok = false;
  for (let i = 0; i < 2; i++) {
    opsLogEvent({ name: 'C' }, { event: 'X' });
    await flushOpsLog();
  }
  assert.equal(alerts.length, 0, 'no alert: the success reset the streak');
});

test('POST handles Apps Script 302 redirect chain', async () => {
  _setEnvImpl(() => ({ CAMPAIGN_LOG_WEBAPP_URL: 'https://example.com/campaigns' }));
  const fetchImpl = makeFakeFetch(({ callIndex }) => {
    if (callIndex === 0) {
      return {
        status: 302,
        headers: { get: (h) => h === 'location' ? 'https://example.com/redirected' : null },
        async text() { return ''; },
      };
    }
    return jsonResponse({ success: true, row: 5 });
  });
  _setFetchImpl(fetchImpl);

  const result = await campaignLogAppendRun({ name: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.row, 5);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].url, 'https://example.com/redirected');
});
