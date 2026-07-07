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

/** Resets the ledger. Call at campaign start. */
export function clearSkips() {
  _ledger = [];
}
