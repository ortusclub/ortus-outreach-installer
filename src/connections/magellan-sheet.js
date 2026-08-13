// Operation Magellan — the paper trail.
//
// The live card shows what is happening now; this writes what happened, to a
// Google Sheet anyone can open without the app running.
//
// One tab per Ortus account, named after the account's email, holding that
// account's people in the cleaned LinkedHelper layout — collect Nikki, Antonio
// and Milee and you get three tabs. Plus three tabs about the run itself:
//
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
import { syntheticEmail, isHidden } from './magellan.js';

export const ACCOUNTS_TAB = 'Accounts';
export const LOG_TAB = 'Log';
export const IMPORT_TAB = 'Import';
export const PLAN_TAB = 'Plan';

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
// What Import would do, one row per person. The reviewer is not the operator —
// this is the only artifact a second person can open without the app running.
export const PLAN_HEADER = ['Account', 'First Name', 'Last Name', 'LinkedIn', 'What happens'];

const s = (v) => (v == null ? '' : String(v));

// ── The spreadsheet ────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One attempt. Apps Script answers a POST with a 302 to a googleusercontent
 * "echo" URL, and that URL intermittently 404s — measured 13 Aug over ten
 * consecutive getSheetUrl calls, four came back as Google's "Pagina non
 * trovata" HTML instead of the reply. It is a Google-side flap, not a
 * deployment problem: the same URL answers correctly seconds later.
 *
 * fetch is left to follow the redirect itself. Handling it by hand — read the
 * Location, fetch it as a second bare request — spends a one-time URL outside
 * its own redirect and can only add failures on top of the flap.
 */
async function postOnce(payload, timeoutMs) {
  try {
    const res = await fetch(MAGELLAN_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        // A login page is a deployment problem, not a flap — retrying it just
        // burns the operator's time and reports the wrong cause at the end.
        return { error: 'The Apps Script returned a login page — redeploy it', transient: false };
      }
      // The status is the difference between "redeploy it" and "Google flapped".
      // Hiding it behind a bare "non-JSON" is what made this look like a dead
      // deployment for a day.
      return { error: `The Apps Script answered ${res.status} with ${text.length} bytes that are not JSON`, transient: true };
    }
  } catch (err) {
    return { error: err.message, transient: true };
  }
}

/**
 * Every Magellan action is a whole-tab overwrite (writeTab) or a read
 * (getSheetUrl), so re-sending one is safe by construction: the same rows land
 * in the same place. That is what makes retrying the right answer here, exactly
 * as it is for FG — and its absence is why one flap lost the whole sheet write
 * after a 429-person import.
 */
async function postWebApp(payload, { timeoutMs = 60000, attempts = 4, sleep = _sleep } = {}) {
  if (!MAGELLAN_WEBAPP_URL) {
    return { error: 'The Magellan sheet is not set up yet — deploy magellan-apps-script.js and put its /exec URL in src/sheets-webapp-url.js (MAGELLAN_WEBAPP_URL).' };
  }
  let last = { error: 'The sheet request never ran' };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0) await sleep(500 * i);         // 0ms, 500ms, 1s, 1.5s
    const r = await postOnce(payload, timeoutMs);
    if (!r || !r.error) return r;
    last = r;
    if (r.transient === false) break;
  }
  return { error: last.error };
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

// Google Sheets rejects these in a tab name. Emails never contain them, but a
// malformed account name on disk ("Andoela Sadikaj - Connections, …") might.
export function tabNameFor(account) {
  return String(account || 'unknown').replace(/[[\]*?/\\:]/g, '-').slice(0, 95);
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

// What Check found, keyed by LinkedIn member id: the HubSpot id if the person
// is already there, null if they are new. publish() is called from four
// places — Check itself, and later, unrelated writes from collect, merge and
// import — and every one of them has to draw the same Plan tab. Threading a
// per-call override through all four would mean the three that never ran
// Check (and so never populated this) each need to know to pass one through;
// keeping it here instead means they don't have to know this exists at all.
// Cleared by resetPlanVerdicts(), which magellan-run's reset() calls
// alongside resetting _plans, so a fresh sweep starts with no stale verdicts.
let _verdicts = null;

/** Called once by buildPreview after Check finishes. */
export function setPlanVerdicts(verdicts) { _verdicts = verdicts; }

/** A fresh sweep or an explicit reset invalidates every verdict Check found. */
export function resetPlanVerdicts() { _verdicts = null; }

/**
 * One row per person Check looked at, with what Import would do to them.
 *
 * `read` is injected so this stays pure and testable — the real one is
 * readForPlan, the same reader buildPreview used, so the rows here are the
 * rows that would actually be written. The already-in-HubSpot verdict itself
 * does NOT come from these rows — readForPlan rebuilds them from disk on
 * every call, so nothing stamped on them earlier survives a second read — it
 * comes from _verdicts, set once by buildPreview and shared by every caller.
 */
export function planRows(state = {}, read = readForPlan, verdicts = _verdicts) {
  const pv = state.preview;
  if (!pv) return [];
  const out = [];
  for (const account of pv.accounts || []) {
    let rows = [];
    try { rows = read(account) || []; } catch { continue; }
    const seen = new Set();
    for (const r of rows) {
      // Same three buckets planAccount uses, in the same order, so the tab
      // never disagrees with the ledger about which bucket someone is in.
      if (isHidden(r)) {
        out.push([account, r.firstName || '', r.lastName || '', '',
          'Hidden by LinkedIn — nothing we can do']);
        continue;
      }
      if (!r.memberId) {
        out.push([account, r.firstName || '', r.lastName || '',
          r.slug ? `https://www.linkedin.com/in/${r.slug}` : '',
          'Not collected yet — no LinkedIn ID, we retry next collection']);
        continue;
      }
      // LinkedIn occasionally lists the same person twice in one export;
      // planAccount issues one write for them, so this issues one row.
      if (seen.has(r.memberId)) continue;
      seen.add(r.memberId);
      const existingId = verdicts ? verdicts.get(String(r.memberId)) : null;
      const what = existingId
        ? 'Already in HubSpot — we note the connection, nothing else changes'
        : 'Will be added';
      out.push([account, r.firstName || '', r.lastName || '',
        r.slug ? `https://www.linkedin.com/in/${r.slug}` : '', what]);
    }
  }
  return out;
}

/**
 * One-line provenance banner, written as the first row under the Plan tab's
 * header — the row a reader cannot miss without scrolling past it.
 *
 * The Plan tab can go stale two ways and neither is fixed here (on purpose —
 * see the comment on this being called from publish()): runImport rewrites
 * it at the end with the *pre-import* verdicts, so right after an Import it
 * still says "Will be added" for people who were just added; and a Check
 * that finds nothing new leaves plan.length at 0, so the write is skipped
 * and whatever was there survives untouched. Either way, a reader who can
 * see WHEN this was built and WHAT it covers can judge for themselves
 * whether they're looking at something current — which is all a stamp can
 * honestly promise.
 */
export function planBanner(state = {}) {
  const pv = state.preview || {};
  const built = pv.builtAt
    ? new Date(pv.builtAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'an unknown time';
  const n = (pv.accounts || []).length;
  const coverage = `This plan was built ${built} and covers ${n} account${n === 1 ? '' : 's'}.`;
  const msg = state.imported
    ? `${coverage} An Import has already run. The rows below show what it was going to do, not what will happen if you press Import now.`
    : `${coverage} If a Check or an Import ran since, the rows below may no longer be accurate.`;
  return [msg, '', '', '', ''];
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
// account → the row count last written for it. An account's tab is only
// rewritten when its numbers changed, so a 300-account sweep sends each
// account's people once instead of resending all of them every publish.
const _written = new Map();

/** Forget what has been written — a fresh sweep rewrites every tab. */
export function resetPublished() { _written.clear(); }

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
    // actually needs, and the per-account tabs are the slow part.
    let last = await write(ACCOUNTS_TAB, ACCOUNTS_HEADER, accountsRows(state), deps);
    await write(LOG_TAB, LOG_HEADER, logRows(state), deps);

    for (const a of state.perAccount || []) {
      if (a.error) continue;
      let rows;
      try { rows = connectionsRowsForAccount(a.account, read(a.account)); } catch { continue; }
      if (_written.get(a.account) === rows.length) continue;   // unchanged since last time
      last = await write(tabNameFor(a.account), CONNECTIONS_HEADER, rows, deps);
      _written.set(a.account, rows.length);
    }

    const plan = planRows(state, read);
    // The banner rides along with the data it describes — it is only worth
    // writing when there is a plan to have a provenance date at all.
    if (plan.length) last = await write(PLAN_TAB, PLAN_HEADER, [planBanner(state), ...plan], deps);

    const imp = importRows(state.imported);
    if (imp.length) await write(IMPORT_TAB, IMPORT_HEADER, imp, deps);
    return { written: true, url: (last && last.url) || '' };
  } catch (err) {
    return { written: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}
