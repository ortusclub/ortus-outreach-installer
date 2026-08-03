// src/skip-ledger.js — in-memory skip ledger for campaign runs
// Call clearSkips() at campaign start; recordSkip() per skipped lead; getSkips() to read.

export const ALREADY_PROCESSED   = 'already_processed';
export const IDENTITY_UNCONFIRMED = 'identity_unconfirmed';
export const WATCHDOG_TIMEOUT     = 'watchdog_timeout';
export const MALFORMED_URL        = 'malformed_url';
export const DUPLICATE_ROW        = 'duplicate_row';
export const FAILED_REPEATEDLY    = 'failed_repeatedly';
export const TERMINAL_STAGE       = 'terminal_stage';
export const OTHER                = 'other';

/** @type {Array<{url:string, leadName:string, rowNumber:number|undefined, profileId:string|undefined, profileName:string|undefined, reason:string, detail:string|undefined, timestamp:string}>} */
let _ledger = [];

/**
 * Append a skip entry to the in-memory ledger.
 * @param {{ url: string, leadName: string, reason: string, rowNumber?: number, profileId?: string, profileName?: string, detail?: string }} opts
 */
export function recordSkip({ url, leadName, reason, rowNumber, profileId, profileName, detail }) {
  _ledger.push({
    url,
    leadName,
    rowNumber,
    profileId,
    profileName,
    reason,
    detail,
    timestamp: new Date().toISOString(),
  });
}

/** Returns a shallow copy of the ledger array. */
export function getSkips() {
  return [..._ledger];
}

// Human wording per reason, for the one-line exhaustion summary. A reason with
// no entry here falls back to its raw slug rather than being dropped — an
// unknown reason is still information the operator needs.
const REASON_LABELS = {
  [ALREADY_PROCESSED]:    'already actioned by this app',
  [IDENTITY_UNCONFIRMED]: 'identity unconfirmed',
  [WATCHDOG_TIMEOUT]:     'timed out',
  [MALFORMED_URL]:        'no usable LinkedIn URL',
  [DUPLICATE_ROW]:        'duplicate row',
  [FAILED_REPEATEDLY]:    'failed repeatedly',
  [TERMINAL_STAGE]:       'already marked done in the sheet',
  [OTHER]:                'other',
};

/**
 * One-line "why there was nothing left" tail for the live log.
 *
 * Every in-loop drop already calls recordSkip, but the ledger is in-memory and
 * never surfaced while a run is going, so a campaign that dropped hundreds of
 * rows logged only "All leads processed or filtered out". An operator then
 * rebuilt the sheet repeatedly against a filter that was never about the sheet.
 *
 * Returns '' when nothing was skipped, so the caller can append unconditionally.
 *
 * @param {ReturnType<typeof getSkips>} skips
 * @returns {string} e.g. ' 430 row(s) skipped: 430 already actioned by this app.'
 */
export function summarizeSkips(skips) {
  if (!Array.isArray(skips) || skips.length === 0) return '';
  const counts = new Map();
  for (const s of skips) {
    const reason = s?.reason || OTHER;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${REASON_LABELS[reason] || reason}`);
  return ` ${skips.length} row(s) skipped: ${parts.join(', ')}.`;
}

/** Resets the ledger. Call at campaign start. */
export function clearSkips() {
  _ledger = [];
}
