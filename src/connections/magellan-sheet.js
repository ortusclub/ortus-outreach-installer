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
// Magellan gets its OWN spreadsheet, created on first use and remembered in
// data/magellan-sheet.json. It is not the FG sheet: that one is locked by the
// Follower Growth jobs, and a 400,000-row connections tab has no business in it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEETS_WEBAPP_URL } from '../sheets-webapp-url.js';
import { readForPlan } from './magellan-pull.js';
import { syntheticEmail } from './magellan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
const SHEET_REF = path.join(REPO, 'data/magellan-sheet.json');

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
  if (!SHEETS_WEBAPP_URL) return { error: 'SHEETS_WEBAPP_URL not configured' };
  try {
    const initial = await fetch(SHEETS_WEBAPP_URL, {
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

export function readSheetRef() {
  try { return JSON.parse(fs.readFileSync(SHEET_REF, 'utf8')); } catch { return null; }
}
function writeSheetRef(ref) {
  fs.mkdirSync(path.dirname(SHEET_REF), { recursive: true });
  fs.writeFileSync(`${SHEET_REF}.tmp`, JSON.stringify(ref, null, 2));
  fs.renameSync(`${SHEET_REF}.tmp`, SHEET_REF);
}

/**
 * The Magellan spreadsheet, created once and reused. createLeadTab makes it,
 * shares it anyone-with-link, and gives back its id.
 */
export async function ensureSheet({ post = postWebApp } = {}) {
  const ref = readSheetRef();
  if (ref && ref.spreadsheetId) return ref;
  const r = await post({
    action: 'createLeadTab', name: 'Operation Magellan',
    header: CONNECTIONS_HEADER, rows: [],
  }, { timeoutMs: 90000 });
  if (!r || r.error || !r.spreadsheetId) {
    throw new Error(`Could not create the Magellan sheet — ${(r && r.error) || 'no id came back'}`);
  }
  const made = { spreadsheetId: r.spreadsheetId, url: r.url, createdAt: new Date().toISOString() };
  writeSheetRef(made);
  return made;
}

async function writeTab(sheetId, tab, header, rows, { post = postWebApp } = {}) {
  const r = await post({ action: 'writeTab', sheetId, tab, header, rows }, { timeoutMs: 120000 });
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
  const { write = writeTab, ensure = ensureSheet, read = readForPlan, force = false } = deps;
  if (_inFlight && !force) return { written: false, skipped: 'a write is already in flight' };
  _inFlight = true;
  try {
    const ref = await ensure(deps);
    const id = ref.spreadsheetId;
    // Accounts and Log first: on a long run those are what someone watching
    // actually needs, and the Connections tab is the slow one.
    await write(id, ACCOUNTS_TAB, ACCOUNTS_HEADER, accountsRows(state), deps);
    await write(id, LOG_TAB, LOG_HEADER, logRows(state), deps);
    await write(id, CONNECTIONS_TAB, CONNECTIONS_HEADER, connectionsRows(state, { read }), deps);
    const imp = importRows(state.imported);
    if (imp.length) await write(id, IMPORT_TAB, IMPORT_HEADER, imp, deps);
    return { written: true, url: ref.url };
  } catch (err) {
    return { written: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}
