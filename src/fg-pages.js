// The LinkedIn company pages Follower Growth can grow.
//
// The page is an EXPLICIT choice in the wizard, not something derived. An
// earlier design resolved it from each account's SoO `Company` column; Sam
// asked for a dropdown instead (2026-08-10), which is simpler and means an
// account's org and the page it invites to are independent.
//
// Adding a page is one entry here. Ortus stays first and is the fallback for
// every unrecognised input, so an app that fails to send a page id behaves
// exactly as it did before this file existed.
//
// `sooCompany` is which SoO `Company` value marks an account as belonging to
// this page's org. Only those accounts can invite people to follow the page,
// so it decides who may SEND — separately from `inviteUrl`, which decides
// where the invite goes. It is spelled out rather than matched against the
// label because the two differ: the page is "Apex Guesting Partner" while the
// SoO company is "Apex Strategy".
import { ORTUS_PAGE_INVITE_URL } from './sheets-webapp-url.js';

export const FG_PAGES = {
  ortus: {
    id: 'ortus',
    label: 'Ortus Club',
    inviteUrl: ORTUS_PAGE_INVITE_URL,
    sooCompany: 'The Ortus Club',
  },
  apex: {
    id: 'apex',
    label: 'Apex Guesting Partner',
    // Same /posts/?feedView=all&invite=true shape as Ortus — that query is what
    // opens the invite modal; the bare /company/<slug>/ URL does not.
    inviteUrl: 'https://www.linkedin.com/company/apex-guesting-partner/posts/?feedView=all&invite=true',
    sooCompany: 'Apex Strategy',
  },
};

/**
 * The set of account emails allowed to send for a page, read off the SoO rows.
 * Matching is case-insensitive and substring-based on Company ("Apex Strategy"
 * also matches "Apex Strategy Ltd"), because SoO Company is hand-maintained.
 *
 * Returns an EMPTY set when the SoO is unusable or the page declares no
 * company. Callers treat empty as "no restriction" — an SoO outage must not
 * silently reduce a run to zero invites.
 *
 * @param {Array<Object>} sooRows  SoO rows ({ email, Company, … })
 * @param {{ sooCompany?: string }} page
 * @returns {Set<string>} lower-cased emails
 */
export function sendersForPage(sooRows, page) {
  const want = String(page?.sooCompany || '').trim().toLowerCase();
  const out = new Set();
  if (!want || !Array.isArray(sooRows)) return out;
  for (const row of sooRows) {
    const company = String(row?.Company ?? '').trim().toLowerCase();
    if (!company || !company.includes(want)) continue;
    const email = String(row?.email ?? '').trim().toLowerCase();
    if (email) out.add(email);
  }
  return out;
}

// Dropdown order. Ortus first = the default selection.
export const FG_PAGE_LIST = Object.values(FG_PAGES);

/**
 * Resolve a page id to its config. Never throws and never returns undefined:
 * an unknown, blank or malformed id resolves to Ortus, so a bad request can
 * only ever produce today's behaviour.
 * @param {string} id
 * @returns {{ id: string, label: string, inviteUrl: string }}
 */
export function pageById(id) {
  const key = String(id == null ? '' : id).toLowerCase();
  // Guard: check own properties only. Inherited Object.prototype members
  // (constructor, __proto__, toString, etc.) must fall back to Ortus, not
  // become the URL for FG sends. The id arrives from JSON request bodies,
  // so these keys are reachable.
  return Object.hasOwn(FG_PAGES, key) ? FG_PAGES[key] : FG_PAGES.ortus;
}
