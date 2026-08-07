// src/connections/fg-list-generate.js
// GENERATE, shared by the two places that build an invite-list tab: the desktop
// app's "Generate list from roles" route, and Auto-Pilot's pre-generate a few
// days before a scheduled run. One implementation so a list built by the cloud
// is byte-for-byte the list the operator would have built by hand.
//
// Pure orchestration: the target builder is injected (the app reaches the
// connections DB through dbCall/RPC, the roster service holds it locally).
import { buildListRows } from './fg-list-launch.js';

/**
 * Build invite-list rows for a set of paired accounts.
 * @param {Array} pairs [{ profileId, account, operator, operatorName }]
 * @param {Object} opts
 * @param {Object} opts.criteria       { jobTitles, companies, geo }
 * @param {string} opts.month          YYYY-MM
 * @param {Array}  opts.alreadyInvited identity keys to exclude
 * @param {number} opts.budget         per-account cap (a NUMBER — Infinity does not survive JSON)
 * @param {Object} deps
 * @param {(criteria, opts)=>Promise<{rows:Array,count:number,matched:number}>} deps.buildTargets
 * @returns {Promise<{header:Array, rows:Array, perAccount:Array, skipped:Array}>}
 */
export async function generateListRows(pairs, { criteria, month, alreadyInvited = [], budget }, deps) {
  const targetsByProfile = new Map();
  for (const pair of pairs) {
    const out = await deps.buildTargets(criteria, {
      operator: pair.operator, operatorName: pair.operatorName, account: pair.account,
      month, alreadyInvited, budget,
    });
    let reason = '';
    if (!out || !out.count) {
      reason = (out && out.matched === 0) ? 'no connections match these roles' : 'all matching connections already invited';
    }
    targetsByProfile.set(pair.profileId, { rows: (out && out.rows) || [], count: (out && out.count) || 0, reason });
  }
  const accountEmails = Object.fromEntries(pairs.map((p) => [p.profileId, p.account]));
  return buildListRows(pairs, { accountEmails }, {
    buildTargets: (p) => targetsByProfile.get(p.profileId) || { rows: [], count: 0, reason: 'no targets for this account' },
  });
}
