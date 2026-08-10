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
import { ORTUS_PAGE_INVITE_URL } from './sheets-webapp-url.js';

export const FG_PAGES = {
  ortus: {
    id: 'ortus',
    label: 'Ortus Club',
    inviteUrl: ORTUS_PAGE_INVITE_URL,
  },
  apex: {
    id: 'apex',
    label: 'Apex Guesting Partner',
    // Same /posts/?feedView=all&invite=true shape as Ortus — that query is what
    // opens the invite modal; the bare /company/<slug>/ URL does not.
    inviteUrl: 'https://www.linkedin.com/company/apex-guesting-partner/posts/?feedView=all&invite=true',
  },
};

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
  return FG_PAGES[key] || FG_PAGES.ortus;
}
