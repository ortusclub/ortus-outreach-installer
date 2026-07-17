// src/connections/fg-sync.js
// Central FG sheet I/O for the Follower Growth campaign. Talks to the FG Apps
// Script (a SEPARATE deployment from the master outreach script) via its own
// FG_WEBAPP_URL. The 302-safe postFg mirrors drive-sync.js's postWebApp
// (Apps Script answers POST with a 302 that Node's fetch would turn into a GET).
import { FG_WEBAPP_URL } from '../sheets-webapp-url.js';

// LinkedIn's monthly "Invite to follow" credit pool. The live balance is shown
// in the invite modal ("30/30 credits available · Credit refill <date>") and is
// the authoritative number — Phase 2 automation reads it straight from the modal.
// This constant is only the fallback used to cap a Build when an account has no
// FG Budgets row yet; per-account overrides still live in the Allowance column.
export const FG_DEFAULT_MONTHLY_ALLOWANCE = 30;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST→(follow 302)→parse attempt. Returns either the parsed object, or a
// { error, transient } marker so the retry wrapper knows whether to try again.
async function postFgOnce(payload, timeoutMs) {
  const body = JSON.stringify(payload);
  try {
    const initial = await fetch(FG_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      res = await fetch(initial.headers.get('location'), { signal: AbortSignal.timeout(timeoutMs) });
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        // A login page is a deployment problem, not a transient blip — don't retry.
        return { error: 'FG Apps Script returned a login page — redeploy it ("anyone with the link")', transient: false };
      }
      // Apps Script intermittently returns an HTML error page from its one-time
      // redirect URL under load. This is transient — worth retrying.
      return { error: 'Unexpected non-JSON response from the FG Apps Script', transient: true };
    }
  } catch (err) {
    // Network / timeout — transient.
    return { error: err.message, transient: true };
  }
}

// Retry transient failures a few times with a short backoff. Safe because every FG
// action is idempotent: fgQueue dedupes by Member-ID-or-URL, fgMarkInvited skips
// rows already Invited, fgObserveCredits just overwrites a snapshot — so re-sending
// a request whose response was lost to a Google hiccup never double-applies.
export async function postFg(payload, { timeoutMs = 30000, attempts = 3, sleep = _sleep } = {}) {
  if (!FG_WEBAPP_URL) return { error: 'FG_WEBAPP_URL not configured — deploy fg-apps-script.js and set its URL in src/sheets-webapp-url.js' };
  let last = { error: 'FG request never ran' };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0) await sleep(400 * i); // 0ms, 400ms, 800ms…
    const r = await postFgOnce(payload, timeoutMs);
    if (!r || !r.error) return r;            // success
    last = r;
    if (r.transient === false) break;        // non-retryable (e.g. login page)
  }
  return { error: last.error };
}

// Skip-list keys (Member ID, else LinkedIn URL) for people ALREADY invited —
// Status === 'Invited' only. A 'Failed' or in-flight 'Queued' row is NOT skipped,
// so a failed person is retried next run.
export function invitedKeysFromState(invites) {
  return (invites || [])
    .filter((r) => r && r.Status === 'Invited')
    .map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''))
    .filter(Boolean);
}

// { invites: [...row objects], budgets: [...], funnel: [...] }
export async function getFgState() {
  const r = await postFg({ action: 'fgState' }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  return { invites: r.invites || [], budgets: r.budgets || [], funnel: r.funnel || [] };
}

// Pad each FG_HEADER-order row (13 cells) to 16 by appending the run's id + time
// + an empty Reason. Single choke point so callers never hand-build the new cols.
export function stampRunCells(rows, { runId = '', runAt = '' } = {}) {
  return (rows || []).map((r) => [...r.slice(0, 13), String(runId), String(runAt), '']);
}

// Append queued rows (FG_HEADER order). Stamps the run id + time onto every row.
export async function queueFgInvites(rows, { runId = '', runAt = '' } = {}) {
  const stamped = stampRunCells(rows, { runId, runAt });
  const r = await postFg({ action: 'fgQueue', rows: stamped }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { queued, skippedDuplicates }
}

// Sweep every still-'Queued' row for this run to 'Failed' (post-reconcile). `reasons`
// is an optional { memberId: text } map for per-lead reasons; `reason` is the fallback.
export async function markFgFailed({ runId, reason, reasons }) {
  const r = await postFg({ action: 'fgMarkFailed', runId, reason, reasons }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { failed }
}

// Flip the given Member IDs from Queued → Invited (stamp Invited At) and bump
// the account's FG Budgets row for the month.
export async function markFgInvited({ memberIds, account, operator, month }) {
  const r = await postFg({ action: 'fgMarkInvited', memberIds, account, operator, month }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { invited, remaining }
}

// Write the modal's observed available-credit count straight to the account's FG
// Budgets row (Remaining := available, Sent := allowance − available) plus the
// refill date + an "Observed At" stamp. Authoritative over the 30−Sent estimate
// because LinkedIn refills credits on accept/withdraw, which Sent can't see.
export async function observeFgCredits({ account, operator, month, available, allowance, refill }) {
  const r = await postFg({ action: 'fgObserveCredits', account, operator, month, available, allowance, refill }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  return r; // { observed, remaining, allowance }
}
