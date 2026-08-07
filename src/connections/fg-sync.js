// src/connections/fg-sync.js
// Central FG sheet I/O for the Follower Growth campaign. Talks to the FG Apps
// Script (a SEPARATE deployment from the master outreach script) via its own
// FG_WEBAPP_URL. The 302-safe postFg mirrors drive-sync.js's postWebApp
// (Apps Script answers POST with a 302 that Node's fetch would turn into a GET).
import { FG_WEBAPP_URL } from '../sheets-webapp-url.js';
import { FG_MASTER_HEADER, chunkRows } from './fg-master.js';

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
  // fgState_ always returns all three arrays, so a missing key means the reply
  // was not the reply — a 302 body, a truncated read, a timeout page. Defaulting
  // those to [] used to hand callers an empty invite ledger, which reads as
  // "nobody has been invited yet" and re-invites the whole list.
  if (!r || !Array.isArray(r.invites) || !Array.isArray(r.budgets)) {
    throw new Error('The FG sheet returned an unreadable reply (no invites/budgets) — try again.');
  }
  return { invites: r.invites, budgets: r.budgets, funnel: r.funnel || [] };
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
export async function markFgInvited({ memberIds, invited, account, operator, month }) {
  const r = await postFg({ action: 'fgMarkInvited', memberIds, invited, account, operator, month }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { invited, remaining, master }
}

// Create (or replace) a per-run invite-list tab and write its header + rows.
// `tab` is the tab name (e.g. "FG 2026-08-01"); `header`/`rows` are in
// FG_LIST_HEADER order (see fg-list.js). Idempotent by design: re-writing the
// same tab replaces its contents, so re-generating a list never doubles rows.
export async function writeFgList(tab, rows, { header = [] } = {}) {
  const r = await postFg({ action: 'fgWriteList', tab, header, rows }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { tab, written }
}

// Read a per-run invite-list tab back as raw sheet values (header row first),
// ready for parseListRows(). Used at fire time for the auto tab and for a BYO
// tab that lives in the central FG sheet.
export async function readFgList(tab) {
  const r = await postFg({ action: 'fgReadList', tab }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  return r.rows || [];
}

// Stamp the ledger columns (Status / Invited At / Note / Member ID) back into a
// per-run list tab, matching rows by LinkedIn URL. Called by the cloud reconcile
// as invites go out so the SAME tab you built doubles as the run ledger. updates:
// [{ url, status, invitedAt, note, memberId }] — only these rows are touched.
export async function updateFgListLedger(tab, updates) {
  if (!Array.isArray(updates) || !updates.length) return { tab, updated: 0 };
  const r = await postFg({ action: 'fgUpdateListLedger', tab, updates }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { tab, updated }
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

// Write the FG Master tab in chunks. One setValues (and one POST) cannot carry
// ~279k rows, so the first chunk REPLACES the tab (clear + header) and every
// later chunk APPENDS at a POSITIONAL startRow (2 + i*chunkSize — row 1 is the
// header). postFg retries transient failures, and a lost response replaying a
// chunk must overwrite the SAME rows, not append a duplicate copy — that's why
// this is positional rather than "append at getLastRow()+1". `buildId` fences
// concurrent rebuilds in the Apps Script (see fgWriteMaster_): it defaults to a
// string derived from the row count + a timestamp, unique enough per build
// without a dependency.
//
// `appendAt` switches the whole write to incremental: nothing is cleared, the
// header is left alone, and the chunks land at appendAt, appendAt+chunkSize, …
// (still positional, so a retried chunk overwrites itself rather than duplicating).
export async function writeFgMaster(rows, {
  tab = 'FG Master', header = FG_MASTER_HEADER, chunkSize = 2000,
  post = postFg, onProgress = null, appendAt = 0,
  buildId = `${Array.isArray(rows) ? rows.length : 0}-${Date.now()}`,
} = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const incremental = Number(appendAt) > 1;
  const base = incremental ? Number(appendAt) : 2;
  const chunks = chunkRows(all, chunkSize);
  // No rows still needs one replace so a rebuild that matches nothing empties the
  // tab — but an incremental build with nothing new must not touch the sheet.
  if (!chunks.length) {
    if (incremental) return { tab, written: 0, chunks: 0 };
    chunks.push([]);
  }
  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const mode = !incremental && i === 0 ? 'replace' : 'append';
    // Incremental: the first chunk claims the buildId fence that 'replace' would
    // normally set, so a full rebuild racing us is rejected rather than interleaved.
    const claim = incremental && i === 0;
    const startRow = base + i * chunkSize;
    const r = await post({ action: 'fgWriteMaster', tab, header, rows: chunks[i], mode, startRow, buildId, claim }, { timeoutMs: 120000 });
    if (r && r.error) throw new Error(`FG Master chunk ${i + 1}/${chunks.length} failed: ${r.error}`);
    done += chunks[i].length;
    if (onProgress) onProgress({ done, total: all.length });
  }
  return { tab, written: all.length, chunks: chunks.length };
}

// Identity keys of everyone already in the FG Master tab, paged so a 300k-row tab
// never comes back in one response. Returns { keys:Set, rows, exists } — `exists`
// false means there is no tab yet and the caller must do a full build.
export async function readFgMasterKeys({
  // 100k keys came back as a 1.2MB body after ~40s in the Apps Script — close
  // enough to the limits that one slow page failed and was read as "no tab".
  // 25k keeps each page well under both.
  tab = 'FG Master', post = postFg, pageSize = 25000, onProgress = null,
} = {}) {
  const keys = new Set();
  let offset = 0;
  for (;;) {
    const r = await post({ action: 'fgMasterKeys', tab, offset, limit: pageSize }, { timeoutMs: 120000 });
    if (r && r.error) throw new Error(`FG Master key read failed: ${r.error}`);
    // A malformed reply must NOT read as "there is no tab" — the caller answers
    // that with a full rebuild, which clears a tab that was there all along.
    if (!r || typeof r.exists === 'undefined') throw new Error('FG Master key read returned an unreadable response');
    if (!r.exists) {
      if (offset === 0) return { keys, rows: 0, exists: false };
      throw new Error(`FG Master tab disappeared mid-read (after ${offset} rows)`);
    }
    for (const k of String(r.keys || '').split('\n')) if (k) keys.add(k);
    const read = Number(r.read) || 0;
    offset += read;
    if (onProgress) onProgress({ done: offset, total: Number(r.rows) || 0 });
    // No progress means the tab is exhausted (or shrank mid-read) — stop either way.
    if (!read || offset >= (Number(r.rows) || 0)) return { keys, rows: Number(r.rows) || offset, exists: true };
  }
}
