// tests/preflight-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePreflightGate, ackFor } from '../src/preflight-gate.js';

const BL = { check: 'blocklist_match', severity: 'blocker', rowIndex: 44, stampText: 'Skipped: blocklist — IBM', url: 'https://x/in/a' };
const NM = { check: 'name_url_mismatch', severity: 'blocker', rowIndex: 413, stampText: 'Skipped: name≠URL', url: 'https://x/in/b' };

test('no blockers → allow, nothing excluded', () => {
  const d = decidePreflightGate({ findings: { blockers: [] }, ackProvided: '', ackExpected: '' });
  assert.equal(d.allow, true);
  assert.deepEqual(d.excludeRows, []);
});

test('blockers without ack → refuse', () => {
  const findings = { blockers: [NM] };
  const d = decidePreflightGate({ findings, ackProvided: '', ackExpected: ackFor(findings) });
  assert.equal(d.allow, false);
});

test('blockers with matching ack → allow, but blocklist rows ALWAYS excluded', () => {
  const findings = { blockers: [BL, NM] };
  const ack = ackFor(findings);
  const d = decidePreflightGate({ findings, ackProvided: ack, ackExpected: ack });
  assert.equal(d.allow, true);
  // ack acknowledges name-mismatch (operator chose launch-anyway) but blocklist is never overridable
  assert.deepEqual(d.excludeRows, [BL]);
});

test('stale ack (findings changed) → refuse', () => {
  const findings = { blockers: [BL, NM] };
  const d = decidePreflightGate({ findings, ackProvided: ackFor({ blockers: [NM] }), ackExpected: ackFor(findings) });
  assert.equal(d.allow, false);
});
