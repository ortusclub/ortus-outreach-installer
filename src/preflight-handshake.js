/**
 * Pure decision logic for the pre-flight primary handshake. No Puppeteer, no
 * campaign import — fully unit-testable. The campaign orchestrator wires these
 * decisions to the real browser helpers.
 */

// States that mean "this account's link is already done — no connect needed".
const DONE_STATES = new Set(['connected', 'already_connected']);

/** Accounts that still need a connect-to-primary request: non-local, not already done. */
export function planAccountsNeedingConnect(participating, primaryConn) {
  const conn = primaryConn instanceof Map ? primaryConn : new Map(Object.entries(primaryConn || {}));
  return (participating || []).filter((id) => {
    if (!id || id === 'local-browser') return false;
    return !DONE_STATES.has(conn.get(id));
  });
}

/** Accepted-vs-expected progress. done = all expected accepted (or nothing expected). */
export function handshakeProgress(primaryConn, expectedIds) {
  const conn = primaryConn instanceof Map ? primaryConn : new Map(Object.entries(primaryConn || {}));
  const total = (expectedIds || []).length;
  const accepted = (expectedIds || []).filter((id) => conn.get(id) === 'connected').length;
  return { accepted, total, done: accepted >= total };
}

/** Proceed to outreach when every link is accepted OR the bounded poll cap has elapsed. */
export function shouldProceed({ startedAt, now, capMs, accepted, total }) {
  if (accepted >= total) return true;
  return (now - startedAt) >= capMs;
}

const ROWS = {
  connected:         { icon: '✓', label: 'accepted by primary' },
  accepting:         { icon: '↻', label: 'accepting…' },
  sent:              { icon: '•', label: 'request sent — waiting' },
  already_connected: { icon: '–', label: 'already connected' },
  unverified:        { icon: '•', label: 'could not verify' },
};

/** Map one account's state to a checklist row for the UI. */
export function checklistRow(name, state) {
  const r = ROWS[state] || { icon: '•', label: '' };
  return { name, state, icon: r.icon, label: r.label };
}
