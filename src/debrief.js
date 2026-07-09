// src/debrief.js — pure helper: build the persisted post-campaign debrief
// snapshot from data that already exists at campaign end (skip ledger,
// parkedProfiles, campaign.errors, _endNotice). The snapshot is stored on the
// history entry so the Debrief panel survives app restarts (the skip ledger
// is in-memory and reset on every run).

/** Cap on persisted skip rows — keeps history.json small on huge runs. */
export const MAX_DEBRIEF_SKIPS = 100;

/** Cap on persisted error samples. */
export const MAX_ERROR_SAMPLES = 5;

/**
 * Build a debrief snapshot. Every field maps 1:1 onto data that exists at
 * campaign end — nothing is invented or derived from the sheet.
 *
 * @param {object} opts
 * @param {Array<{url?:string, leadName?:string, rowNumber?:number, profileName?:string, reason?:string, detail?:string, timestamp?:string}>} [opts.skips]
 *   Entries from the skip ledger (src/skip-ledger.js getSkips()).
 * @param {Array<{profileId?:string, pName?:string, reason?:string, parkedAt?:number}>} [opts.parked]
 *   campaign.parkedProfiles at end of run.
 * @param {Array<{time?:string|number, message?:string}>} [opts.errors]
 *   campaign.errors at end of run.
 * @param {{reason?:string, detail?:string}|null} [opts.endNotice]
 *   campaign._endNotice (why-it-stopped notice), if one was built.
 * @param {Array<{profileId?:string, name?:string, sent?:number, endReason?:string}>} [opts.perAccount]
 *   One row per profile that participated in the run — Sent count + end
 *   reason only. We do NOT track per-lead Accepted/Replied for a normal
 *   run, so nothing beyond Sent/endReason is invented here.
 * @returns {{skipTotal:number, skipReasons:Object<string,number>, skips:Array, parked:Array, errors:{count:number, samples:Array}, endNotice:{reason:string, detail:string}|null, perAccount:Array}}
 */
export function buildDebrief({ skips = [], parked = [], errors = [], endNotice = null, perAccount = [] } = {}) {
  const skipReasons = {};
  for (const s of skips) {
    const r = (s && s.reason) || 'other';
    skipReasons[r] = (skipReasons[r] || 0) + 1;
  }
  return {
    skipTotal: skips.length,
    skipReasons,
    skips: skips.slice(0, MAX_DEBRIEF_SKIPS).map((s) => ({
      url: (s && s.url) || '',
      leadName: (s && s.leadName) || '',
      rowNumber: s && Number.isFinite(s.rowNumber) ? s.rowNumber : null,
      profileName: (s && s.profileName) || '',
      reason: (s && s.reason) || 'other',
      detail: (s && s.detail) || '',
      timestamp: (s && s.timestamp) || '',
    })),
    parked: parked.map((p) => ({
      profileId: (p && p.profileId) || '',
      pName: (p && p.pName) || '',
      reason: (p && p.reason) || '',
      parkedAt: p && Number.isFinite(p.parkedAt) ? p.parkedAt : null,
    })),
    errors: {
      count: errors.length,
      samples: errors.slice(-MAX_ERROR_SAMPLES).map((e) => ({
        time: (e && e.time != null) ? e.time : null,
        message: String((e && e.message) || ''),
      })),
    },
    endNotice: endNotice
      ? { reason: endNotice.reason || '', detail: endNotice.detail || '' }
      : null,
    perAccount: (perAccount || []).map((a) => ({
      profileId: (a && a.profileId) || '',
      name: (a && a.name) || '',
      sent: a && Number.isFinite(a.sent) ? a.sent : 0,
      endReason: (a && a.endReason) || '',
    })),
  };
}
