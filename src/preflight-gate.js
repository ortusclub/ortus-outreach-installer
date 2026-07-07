// src/preflight-gate.js
// Pure launch-gate decision for pre-flight findings. The ack token proves the
// operator saw EXACTLY these findings; blocklist rows are excluded regardless.
import crypto from 'node:crypto';

export function ackFor(findings) {
  const keys = (findings?.blockers || [])
    .map((f) => `${f.check}:${f.rowIndex}:${f.url || ''}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(keys).digest('hex').slice(0, 16);
}

export function decidePreflightGate({ findings, ackProvided, ackExpected }) {
  const blockers = findings?.blockers || [];
  const blocklistRows = blockers.filter((f) => f.check === 'blocklist_match');
  if (!blockers.length) return { allow: true, excludeRows: [], reason: 'clean' };
  if (!ackProvided || ackProvided !== ackExpected) {
    return { allow: false, excludeRows: [], reason: 'unacknowledged blockers — run pre-flight first' };
  }
  return { allow: true, excludeRows: blocklistRows, reason: 'acknowledged' };
}
