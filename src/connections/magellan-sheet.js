// Operation Magellan — the paper trail.
//
// The live card shows what is happening now; this writes what happened, to
// tabs anyone can open without the app running. Three tabs, refreshed as the
// sweep goes: one row per account, the full run log, and what the import did.
//
// Reuses the FG Apps Script's fgWriteList action (create-or-replace a tab and
// write header + rows) against the app's own Google Sheet — no new Apps Script
// action, so nothing needs redeploying.
import { writeFgList } from './fg-sync.js';

export const ACCOUNTS_TAB = 'Magellan Accounts';
export const LOG_TAB = 'Magellan Log';
export const IMPORT_TAB = 'Magellan Import';

export const ACCOUNTS_HEADER = ['Account', 'Status', 'Connections', 'With Member ID',
  'Hidden', 'Collected At', 'Problem', 'What to do'];
export const LOG_HEADER = ['Time', 'Event'];
export const IMPORT_HEADER = ['Account', 'Created', 'Updated', 'Extra Emails', 'Errors', 'Detail'];

const s = (v) => (v == null ? '' : String(v));

/**
 * One row per account. Finished accounts come from perAccount; the one being
 * read right now gets a live row with its running count, so the tab shows
 * movement on a 7,000-connection account instead of nothing for ten minutes.
 */
export function accountsRows(state = {}) {
  const rows = (state.perAccount || []).map((a) => {
    const d = a.diagnosis || null;
    return [
      s(a.account),
      a.error ? 'Failed' : 'Collected',
      a.error ? '' : s(a.total),
      a.error ? '' : s(a.withMemberId),
      a.error ? '' : s(a.hidden),
      s(a.collectedAt),
      d ? `${d.what} — ${d.why}` : s(a.error),
      d ? s(d.fix) : '',
    ];
  });
  // The account in flight — only when it hasn't already landed in perAccount.
  const cur = state.current;
  if (state.running && cur && cur.account
    && !(state.perAccount || []).some((a) => a.account === cur.account)) {
    rows.push([
      s(cur.account), 'Reading now', s(cur.count), '', '', '',
      cur.total ? `page ${s(cur.pages)} of about ${s(cur.total)} connections` : `page ${s(cur.pages)}`,
      '',
    ]);
  }
  return rows;
}

/** Log lines are stored as "[iso] text" — split them back into two columns. */
export function logRows(state = {}) {
  return (state.log || []).map((line) => {
    const m = /^\[([^\]]+)\]\s?([\s\S]*)$/.exec(line);
    return m ? [m[1], m[2]] : ['', s(line)];
  });
}

export function importRows(imported = null) {
  if (!imported) return [];
  return (imported.perAccount || []).map((a) => [
    s(a.account), s(a.created), s(a.updated), s(a.extraEmails), s((a.errors || []).length),
    (a.errors || []).slice(0, 5).map((e) => `${e.stage}: ${e.error}`).join(' | '),
  ]);
}

// One publish at a time. Callers fire this after every account; the guard means
// a slow Google round-trip throttles us naturally instead of queueing 300 writes.
let _inFlight = false;

/**
 * Push the current state to the sheet. Best-effort by design: the sheet is a
 * record, not the source of truth, so a Google hiccup must never stop a sweep.
 * @returns {Promise<{written:boolean, skipped?:string, error?:string}>}
 */
export async function publish(state = {}, { write = writeFgList, force = false } = {}) {
  if (_inFlight && !force) return { written: false, skipped: 'a write is already in flight' };
  _inFlight = true;
  try {
    await write(ACCOUNTS_TAB, accountsRows(state), { header: ACCOUNTS_HEADER });
    await write(LOG_TAB, logRows(state), { header: LOG_HEADER });
    const imp = importRows(state.imported);
    if (imp.length) await write(IMPORT_TAB, imp, { header: IMPORT_HEADER });
    return { written: true };
  } catch (err) {
    return { written: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}
