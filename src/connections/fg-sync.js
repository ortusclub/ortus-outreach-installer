// src/connections/fg-sync.js
// Central FG sheet I/O for the Follower Growth campaign. Talks to the FG Apps
// Script (a SEPARATE deployment from the master outreach script) via its own
// FG_WEBAPP_URL. The 302-safe postFg mirrors drive-sync.js's postWebApp
// (Apps Script answers POST with a 302 that Node's fetch would turn into a GET).
import { FG_WEBAPP_URL } from '../sheets-webapp-url.js';

// LinkedIn's per-account monthly "Invite to follow" allowance depends on the
// account's role on the page: PAGE ADMINS get 250/month, everyone else 75
// (LinkedIn shows the real number per account). The true figure lives per-account
// in the FG Budgets `Allowance` column (set 250 for admins); this constant is only
// the fallback when an account has no budget row yet — kept at the SAFE FLOOR (75)
// so the app under-promises rather than over-promises for a non-admin.
export const FG_DEFAULT_MONTHLY_ALLOWANCE = 75;

async function postFg(payload, { timeoutMs = 30000 } = {}) {
  if (!FG_WEBAPP_URL) return { error: 'FG_WEBAPP_URL not configured — deploy fg-apps-script.js and set its URL in src/sheets-webapp-url.js' };
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
        return { error: 'FG Apps Script returned a login page — redeploy it ("anyone with the link")' };
      }
      return { error: 'Unexpected non-JSON response from the FG Apps Script' };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// { invites: [...row objects], budgets: [...], funnel: [...] }
export async function getFgState() {
  const r = await postFg({ action: 'fgState' }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  return { invites: r.invites || [], budgets: r.budgets || [], funnel: r.funnel || [] };
}

// Append queued rows (FG_HEADER order). The Apps Script dedupes server-side by
// Member-ID-or-URL, so concurrent operators can't double-queue the same person.
export async function queueFgInvites(rows) {
  const r = await postFg({ action: 'fgQueue', rows }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { queued, skippedDuplicates }
}

// Flip the given Member IDs from Queued → Invited (stamp Invited At) and bump
// the account's FG Budgets row for the month.
export async function markFgInvited({ memberIds, account, operator, month }) {
  const r = await postFg({ action: 'fgMarkInvited', memberIds, account, operator, month }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { invited, remaining }
}
