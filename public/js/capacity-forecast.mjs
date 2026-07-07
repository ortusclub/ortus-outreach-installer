// Capacity forecast — pure helper (feature ⑥, capacity-forecast-2141).
//
// Given the target list size, the per-account daily limit, and the number of
// selected accounts, projects the daily send capacity and the finish date.
// Shared between the wizard UI (imported by app.js) and node tests via the
// re-export in src/capacity-forecast.js.
//
// Stays consistent with the `list_vs_limit` pre-flight lint in
// src/preflight-lint.js: that check fires when targetCount > 14 × perDay,
// i.e. exactly when `days > 14` here — use WARN_DAYS for the UI amber state.

export const WARN_DAYS = 14;

/**
 * @param {object} p
 * @param {number} p.targetCount  actionable leads in the sheet
 * @param {number} p.dailyLimit   invites per account per day
 * @param {number} p.accountCount selected accounts
 * @param {number|Date} [p.now]   reference time (injectable for tests)
 * @returns {{perDay:number, days:number, finishDate:Date}|null}
 *          null when any input is missing/non-positive (nothing to forecast)
 */
export function forecastCapacity({ targetCount, dailyLimit, accountCount, now } = {}) {
  const targets = Number(targetCount);
  const limit = Number(dailyLimit);
  const accounts = Number(accountCount);
  if (!Number.isFinite(targets) || targets <= 0) return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(accounts) || accounts <= 0) return null;

  const perDay = limit * accounts;
  const days = Math.ceil(targets / perDay);
  // Same convention as the existing launch-hero math (app.js): finish is
  // `now + days` whole days — conservative by up to one day.
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
  const finishDate = new Date(nowMs + days * 86400000);
  return { perDay, days, finishDate };
}
