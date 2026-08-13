// src/connections/fg-list-launch.js
// The two-phase Follower Growth flow built on the invite-list tab (fg-list.js):
//   GENERATE (auto)  buildListRows()   — role builder → FG_LIST_HEADER rows.
//   FIRE (both)      dispatchFromRows() — read tab rows → routed engine leads → dispatch.
// Pure orchestration; all I/O (buildTargets, startCloud, sheet read/write) is
// injected via `deps`, so this is unit-testable with no browser/HTTP/sheet.
// Mirrors fg-cloud-launch.js's style; that module stays for the legacy one-shot
// path until this one is wired in and validated.

import {
  FG_LIST_HEADER, listRowFromFgRow, parseListRows, invertAccountEmails, inviteIdentity,
} from './fg-list.js';
import { spreadsheetIdFromUrl } from '../utils.js';

/**
 * Decide where a launch's invite list comes from.
 *
 * Two doors, and NO third: an absent source is an error, never a licence to
 * build one. Before 2026-08-10 a request with no `source` fell through to the
 * roles builder, which is why an operator who had prepared a list offline kept
 * getting a freshly generated one instead.
 *
 * @param {object} body  the launch request body
 * @returns {{ ok: true, kind: 'sheet', sheetUrl: string }
 *          |{ ok: true, kind: 'tab', tab: string }
 *          |{ ok: false, error: string }}
 */
export function resolveListSource(body) {
  const b = body || {};
  const sheetUrl = String(b.sheetUrl || '').trim();
  const tab = String(b.tab || '').trim();

  if (sheetUrl) {
    if (!spreadsheetIdFromUrl(sheetUrl)) {
      return { ok: false, error: `That does not look like a Google Sheet link: ${sheetUrl}` };
    }
    return { ok: true, kind: 'sheet', sheetUrl };
  }
  if (tab) return { ok: true, kind: 'tab', tab };

  return {
    ok: false,
    error: 'Choose where the list comes from — paste a Google Sheet link, or build one from the team\'s connections.',
  };
}

// FG_HEADER indices (mirror fg-export.js) for reading buildTargets() output.
const F_URL = 1, F_MEMBER = 2;

/**
 * GENERATE (auto): build the invite-list rows for a set of account pairs.
 * @param {Array} pairs  [{ profileId, account, operator, operatorName }]
 * @param {Object} ctx
 * @param {Object} ctx.accountEmails  profileId → LinkedIn login email (Account Email column)
 * @param {Object} deps
 * @param {(pair)=>{rows:Array,reason?:string}} deps.buildTargets  today's FG_HEADER row builder
 * @returns {{ header:Array, rows:Array, perAccount:Array, skipped:Array }}
 */
export function buildListRows(pairs, { accountEmails = {} } = {}, deps = {}) {
  const rows = [];
  const perAccount = [];
  const skipped = [];
  const seen = new Set();                       // cross-account de-dupe by identity
  for (const pair of pairs || []) {
    const email = String(accountEmails[pair.profileId] || pair.account || '').trim();
    if (!email) skipped.push({ profileId: pair.profileId, reason: 'no email resolved for this account' });
    const built = (deps.buildTargets && deps.buildTargets(pair)) || {};
    const fgRows = Array.isArray(built.rows) ? built.rows : [];
    let kept = 0;
    for (const r of fgRows) {
      const url = String(r[F_URL] || '').trim();
      if (!url) continue;
      const id = inviteIdentity({ memberId: r[F_MEMBER], url });
      if (seen.has(id)) continue;               // already claimed by an earlier account
      seen.add(id);
      rows.push(listRowFromFgRow(r, { accountEmail: email }));
      kept += 1;
    }
    perAccount.push({ profileId: pair.profileId, account: email, count: kept, reason: built.reason || '' });
  }
  return { header: FG_LIST_HEADER, rows, perAccount, skipped };
}

/**
 * FIRE (both options): turn invite-list tab rows into routed engine leads and
 * dispatch a Follower Growth campaign. Each lead is pinned to its account via
 * routeAccount (email → profileId). Never throws — resolves to {error} so a
 * dispatch hiccup can be surfaced without crashing the fire.
 * @param {Array<Array>} rows  raw sheet values (header row first)
 * @param {Object} opts
 * @param {Object} opts.accountEmails  profileId → email (inverted for the URL→account resolve)
 * @param {Object} opts.campaign       { name, owner, config }
 * @param {Set<string>|null} [opts.allowedSenders]  emails allowed to invite to
 *   this page (see sendersForPage). Empty/absent = no restriction.
 * @param {Object} deps
 * @param {(payload)=>Promise<{id?:string,error?:string}>} deps.startCloud
 * @returns {Promise<{cloudId?:string, leadCount?:number, perAccount?:Array, skipped:Array, error?:string}>}
 */
export async function dispatchFromRows(rows, { accountEmails = {}, campaign = {}, allowedSenders = null } = {}, deps = {}) {
  const { emailToProfileId } = invertAccountEmails(accountEmails);
  const { leads, perAccount, skipped } = parseListRows(rows, { emailToProfileId, allowedSenders });
  if (!leads.length) {
    return { error: 'No invites to send — the list has no usable rows.', skipped };
  }
  let resp;
  try {
    resp = await deps.startCloud({
      mode: 'follower_growth',
      name: campaign.name || '',
      owner: campaign.owner || '',
      profileIds: [...new Set(leads.map((l) => l.routeAccount))],
      leads,
      // accountEmails goes with EVERY dispatch, not just the ones whose caller
      // remembered: the engine labels every log line and account pill with
      // config.accountEmails[profileId] and prints raw 24-hex GoLogin ids
      // without it. Auto-Pilot fires through here too.
      config: { ...(campaign.config || {}), accountEmails },
    });
  } catch (e) {
    return { error: (e && e.message) || 'Cloud dispatch failed.', skipped };
  }
  if (!resp || resp.error || !resp.id) {
    return { error: (resp && resp.error) || 'Cloud dispatch failed.', skipped };
  }
  return { cloudId: resp.id, leadCount: leads.length, perAccount, skipped };
}
