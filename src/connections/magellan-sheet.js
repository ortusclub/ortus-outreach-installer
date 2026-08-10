// Operation Magellan — the paper trail.
//
// The live card shows what is happening now; this writes what happened, to a
// Google Sheet anyone can open without the app running. Four tabs:
//
//   Connections  the collected people in the cleaned LinkedHelper layout —
//                the columns that go straight into HubSpot
//   Accounts     one row per Ortus account: counts, or the failure and its fix
//   Log          the same timestamped lines the card shows
//   Import       what actually went into HubSpot, per account
//
// Magellan has its own sheet and its own Apps Script deployment
// (magellan-apps-script.js, MAGELLAN_WEBAPP_URL) — not the outreach sheet, and
// not the Follower Growth one, whose script lock is held for minutes by the FG
// jobs. That contention is what made the first run's tabs come back empty.
import { MAGELLAN_WEBAPP_URL } from '../sheets-webapp-url.js';
import { readForPlan } from './magellan-pull.js';
import { syntheticEmail } from './magellan.js';

export const CONNECTIONS_TAB = 'Connections';
export const ACCOUNTS_TAB = 'Accounts';
export const LOG_TAB = 'Log';
export const IMPORT_TAB = 'Import';

// Abygael's cleaned-sheet layout, verbatim. This is what gets imported, so the
// names must match the HubSpot property labels exactly — including
// "Linkedin First Connections", which is spelled that way in the portal.
export const CONNECTIONS_HEADER = ['LinkedIn Membership ID', 'Location', 'First Name',
  'Last Name', 'LinkedIn Bio', 'Company Name', 'Job Title', 'Email',
  'Linkedin First Connections'];
export const ACCOUNTS_HEADER = ['Account', 'Status', 'Connections', 'With Member ID',
  'Hidden', 'Collected At', 'Problem', 'What to do'];
export const LOG_HEADER = ['Time', 'Event'];
export const IMPORT_HEADER = ['Account', 'Created', 'Updated', 'Extra Emails', 'Errors', 'Detail'];

const s = (v) => (v == null ? '' : String(v));

// ── The spreadsheet ────────────────────────────────────────────────────────

/** Mirrors drive-sync's postWebApp: Apps Script answers POST with a 302. */
async function postWebApp(payload, { timeoutMs = 60000 } = {}) {
  if (!MAGELLAN_WEBAPP_URL) {
    return { error: 'The Magellan sheet is not set up yet — deploy magellan-apps-script.js and put its /exec URL in src/sheets-webapp-url.js (MAGELLAN_WEBAPP_URL).' };
  }
  try {
    const initial = await fetch(MAGELLAN_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      res = await fetch(initial.headers.get('location'), { signal: AbortSignal.timeout(timeoutMs) });
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        return { error: 'The Apps Script returned a login page — redeploy it' };
      }
      return { error: 'Unexpected non-JSON response from the Apps Script' };
    }
  } catch (err) {
    return { error: err.message };
  }
}

/** The Apps Script's own spreadsheet — the one the tabs land in. */
export async function sheetUrl({ post = postWebApp } = {}) {
  const r = await post({ action: 'getSheetUrl' }, { timeoutMs: 30000 });
  if (!r || r.error || !r.url) {
    throw new Error((r && r.error) || 'The Apps Script did not return its sheet URL — redeploy it.');
  }
  return r.url;
}

// No sheetId: the Apps Script writes into the spreadsheet it is bound to.
async function writeTab(tab, header, rows, { post = postWebApp } = {}) {
  const r = await post({ action: 'writeTab', tab, header, rows }, { timeoutMs: 120000 });
  if (!r || r.error) throw new Error((r && r.error) || 'no reply');
  return r;
}

// ── The rows ───────────────────────────────────────────────────────────────

/**
 * The cleaned-sheet rows for one account, straight from its collected CSV.
 *
 * Email is the synthetic <memberId>@linkedinmembership.id — the key HubSpot
 * dedupes on, exactly as the manual process does it. People with no member id
 * have no key, so they are left out rather than written as a half-row.
 *
 * Location is blank: neither the archive export nor the connections API carries
 * it. Nothing is invented to fill the column.
 */
export function connectionsRowsForAccount(account, rows) {
  return (rows || [])
    .filter((r) => r && r.memberId)
    .map((r) => [
      s(r.memberId),
      '',                                   // Location — not collected, see above
      s(r.firstName),
      s(r.lastName),
      r.slug ? `https://www.linkedin.com/in/${r.slug}` : '',
      s(r.company),
      s(r.jobTitle),
      syntheticEmail(r.memberId),
      s(account),
    ]);
}

/** Every collected account's rows, in the order they were collected. */
export function connectionsRows(state = {}, { read = readForPlan } = {}) {
  const out = [];
  for (const a of state.perAccount || []) {
    if (a.error) continue;
    try { out.push(...connectionsRowsForAccount(a.account, read(a.account))); } catch { /* unreadable file */ }
  }
  return out;
}

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

// ── Publishing ─────────────────────────────────────────────────────────────

// One publish at a time. Callers fire this after every account; the guard means
// a slow Google round-trip throttles us naturally instead of queueing 300 writes.
let _inFlight = false;

/**
 * Push the current state to the sheet. Best-effort by design: the sheet is a
 * record, not the source of truth, so a Google hiccup must never stop a sweep.
 * @returns {Promise<{written:boolean, url?:string, skipped?:string, error?:string}>}
 */
export async function publish(state = {}, deps = {}) {
  const { write = writeTab, read = readForPlan, force = false } = deps;
  if (_inFlight && !force) return { written: false, skipped: 'a write is already in flight' };
  _inFlight = true;
  try {
    // Accounts and Log first: on a long run those are what someone watching
    // actually needs, and the Connections tab is the slow one.
    await write(ACCOUNTS_TAB, ACCOUNTS_HEADER, accountsRows(state), deps);
    await write(LOG_TAB, LOG_HEADER, logRows(state), deps);
    const last = await write(CONNECTIONS_TAB, CONNECTIONS_HEADER, connectionsRows(state, { read }), deps);
    const imp = importRows(state.imported);
    if (imp.length) await write(IMPORT_TAB, IMPORT_HEADER, imp, deps);
    return { written: true, url: (last && last.url) || '' };
  } catch (err) {
    return { written: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}
