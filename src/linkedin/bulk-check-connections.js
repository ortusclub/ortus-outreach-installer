/**
 * Bulk Connection Status check.
 *
 * Replaces the per-lead Voyager-degree check with a single paginated fetch
 * of the account's recent connections, then matches against pending invites
 * in the sheet. Matched rows get Connected Status = 'Connected' written
 * back via the existing batchUpdate path.
 *
 * Match key: LinkedIn public identifier (the slug after /in/). Both the
 * sheet's URL column and the connections payload carry this, so collision
 * risk is effectively zero.
 *
 * Caller is responsible for cooldown gating + navigating the page to a
 * LinkedIn URL before invoking (so JSESSIONID is present for Voyager).
 */

import { getRecentConnections } from './helpers.js';
import { fetchSheet } from '../sheets.js';
import { batchUpdateSheet, writeRecentConnectionsTab } from '../sheets-writer.js';
import { extractLinkedInUrl } from '../campaign.js';

function publicIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().trim() : '';
}

// Extract LinkedIn's ACwAA-style member ID from any string (URL, URN, etc.).
// Some sheet rows use /in/ACwAA…-style URLs (URN-encoded) instead of the
// vanity /in/firstname-lastname slug. The Voyager connections API returns
// both representations across different fields, so we match on either.
function memberIdFromAny(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Run one bulk-check pass for a profile.
 *
 * @param {puppeteer.Page} page - Active page on a LinkedIn URL
 * @param {string} sheetUrl - Sheet URL the campaign is running against
 * @param {string} linkedinColumn - Operator-specified URL column name (or '')
 * @param {string} pName - Profile name for logging
 * @returns {Promise<{ matched: number, fetched: number, error?: string }>}
 */
export async function bulkCheckConnections(page, sheetUrl, linkedinColumn, pName) {
  // 1) Always navigate to a stable LinkedIn URL so the page context has
  // fresh cookies. /mynetwork/invite-connect/connections/ is what LinkedIn's
  // own UI hits. Then check whether we ended up logged in — a stale-session
  // profile gets redirected to /login or /uas/login, where Voyager doesn't
  // exist (returns 404 from a login-page context).
  let postNavUrl = '';
  try {
    await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    postNavUrl = page.url() || '';
  } catch (err) {
    return { matched: 0, fetched: 0, error: `navigation-failed: ${err.message}` };
  }
  // Quick auth check before burning cycles on Voyager calls that will 404.
  if (/\/login|\/uas\/|\/checkpoint/.test(postNavUrl)) {
    return { matched: 0, fetched: 0, error: `session-expired (redirected to ${postNavUrl})` };
  }

  // 2) Fetch recent connections. We pass sinceMs=0 so all pages are fetched
  // (up to the helper's MAX_PAGES cap). Tighter scoping (e.g. since the
  // first invite in this campaign) is a future optimisation.
  const conns = await getRecentConnections(page, 0);
  if (conns.length === 0) {
    // The helper attaches `.error` on the empty array when the failure was
    // something specific (no-csrf, http-XXX, empty-elements, etc.). Surface
    // it so the operator can see exactly why the fetch produced nothing.
    const reason = conns.error || 'no-connections-fetched';
    return { matched: 0, fetched: 0, error: reason };
  }

  // Mirror the fetched connections into a sidecar tab on the same sheet so
  // the operator has a visible audit log of what Voyager actually returned.
  // Best-effort — failures are non-fatal to the bulk-check flow.
  try {
    const sidecarRows = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: c.publicId || '',
      // LinkedIn URN column carries just the ACoAA… portion (no
      // `urn:li:fsd_profile:` prefix) — same convention as the campaign tab.
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      connectedAt: c.connectedAt || 0,
      profileSentBy: pName || '',
    }));
    await writeRecentConnectionsTab(sheetUrl, pName, sidecarRows);
  } catch (err) {
    console.warn(`[bulk-check] sidecar tab write failed: ${err.message}`);
  }

  // Build THREE sets for O(1) matching: vanity-slug publicIds, ACwAA-style
  // member IDs, AND "first last" name pairs. Sheet rows can carry either
  // URL format; the name fallback catches the case where the URL has a
  // vanity slug but Voyager's connections API only returns URNs (without
  // publicIdentifier) — common across many account types.
  const connectedSlugs = new Set();
  const connectedMemberIds = new Set();
  const connectedNames = new Set();
  for (const c of conns) {
    if (c.publicId) connectedSlugs.add(c.publicId.toLowerCase());
    const mid = memberIdFromAny(c.urn) || memberIdFromAny(c.publicId);
    if (mid) connectedMemberIds.add(mid);
    const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`.trim();
    if (nameKey && nameKey !== ' ') connectedNames.add(nameKey);
  }

  // 3) Read the sheet. Match each row's public identifier against the
  // connected set. Skip rows that already show Connected/Declined — only
  // promote rows that are still pending or unverified.
  let rows;
  try {
    rows = await fetchSheet(sheetUrl);
  } catch (err) {
    return { matched: 0, fetched: conns.length, error: `sheet-fetch: ${err.message}` };
  }

  // Build a single human-readable timestamp for every "Still Pending" stamp
  // written this sweep. Same string everywhere so the operator can see at a
  // glance which rows were checked in the same pass.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stillPendingLabel = `Still Pending (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())})`;

  // Diagnostic counters — surfaced in the campaign log so we can see why
  // the stamp count is what it is. Pure observability; remove once the
  // bulk-check is well-trusted.
  let dbgRowsScanned = 0;
  let dbgWithUrl = 0;
  let dbgWithCRS = 0;
  let dbgAlreadyConnected = 0;
  let dbgAlreadyDeclined = 0;
  let dbgPidMatched = 0;
  const sampleCRSValues = new Set();
  const sampleSheetSlugs = [];
  const sampleSheetMemberIds = [];
  // Snapshot a few extracted IDs from the connections list so we can
  // eyeball-compare against what's in the sheet rows.
  const sampleConnectedSlugs = [...connectedSlugs].slice(0, 3);
  const sampleConnectedMemberIds = [...connectedMemberIds].slice(0, 3);

  const updates = [];
  for (const row of rows) {
    dbgRowsScanned++;
    const url = extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    dbgWithUrl++;
    const cs = (row['Connected Status'] || row['connected status'] || row['CC'] || row['cc'] || '').toString().trim();
    if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
    const slug = publicIdFromUrl(url);
    // Captured URN takes precedence over the URL — the bot stamps it on
    // every successful connect via getProfileUrn. Falls back to scanning
    // the URL itself for an ACoAA pattern.
    // LinkedIn URN column now carries the bare ACoAA… portion (the bot
    // strips the `urn:li:fsd_profile:` prefix on write). Membership ID
    // column carries the NUMERIC member number — not useful for matching
    // against the connections API, which returns ACoAA-style URNs.
    const rowUrn = (row['LinkedIn URN'] || row['linkedin urn'] || '').toString();
    const memberId = memberIdFromAny(rowUrn) || memberIdFromAny(url);
    if (sampleSheetSlugs.length < 3 && slug) sampleSheetSlugs.push(slug);
    if (sampleSheetMemberIds.length < 3 && memberId) sampleSheetMemberIds.push(memberId);
    // Name fallback: assemble "first last" from the row when URL match fails.
    const firstName = (row['First Name'] || row['first name'] || row['firstName'] || '').toString().toLowerCase().trim();
    const lastName  = (row['Last Name']  || row['last name']  || row['lastName']  || '').toString().toLowerCase().trim();
    const nameKey = `${firstName} ${lastName}`.trim();
    const isMatch = (slug && connectedSlugs.has(slug))
      || (memberId && connectedMemberIds.has(memberId))
      || (nameKey && nameKey !== ' ' && connectedNames.has(nameKey));
    if (isMatch) {
      dbgPidMatched++;
      if (cs === 'Connected') { dbgAlreadyConnected++; continue; }
      // When the bulk-check confirms acceptance, flip the Connected column
      // (formerly "Connected Already") from No → Yes so it tracks current
      // connection state, not just whether the lead was already 1st-degree
      // at connect time.
      updates.push({ linkedinUrl: url, cc: 'Connected', connectedAlready: 'Yes' });
      continue;
    }
    // Not in the recent-connections list. Only stamp "Still Pending" on rows
    // the bot actually invited — checked via Connection Request Status, with
    // back-compat tolerance for the legacy 'Status' column. Skips rows the
    // bot hasn't touched (e.g. cold leads or operator-edited rows).
    const requestStatus = (row['Connection Request Status'] || row['connection request status']
      || row['Connection Status'] || row['connection status']
      || row['Status'] || row['status'] || '').toString().trim();
    if (sampleCRSValues.size < 5 && requestStatus) sampleCRSValues.add(requestStatus);
    if (requestStatus !== 'Connection Request Sent') continue;
    dbgWithCRS++;
    updates.push({ linkedinUrl: url, cc: stillPendingLabel });
  }

  const sampleConnectedNames = [...connectedNames].slice(0, 3);
  const diagSummary = `scanned=${dbgRowsScanned}, withUrl=${dbgWithUrl}, slugs=${connectedSlugs.size}, memberIds=${connectedMemberIds.size}, names=${connectedNames.size}, pidMatched=${dbgPidMatched}, alreadyConnected=${dbgAlreadyConnected}, alreadyDeclined=${dbgAlreadyDeclined}, stamped=${dbgWithCRS}\n  ↳ sampleSheetSlugs=${sampleSheetSlugs.join(' | ') || '(none)'}\n  ↳ sampleSheetMemberIds=${sampleSheetMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedSlugs=${sampleConnectedSlugs.join(' | ') || '(none)'}\n  ↳ sampleConnectedMemberIds=${sampleConnectedMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedNames=${sampleConnectedNames.join(' | ') || '(none)'}\n  ↳ sampleCRS=${[...sampleCRSValues].join(' | ') || '(none)'}`;
  // Log to stdout for forensic deep-dives, AND also surface in the return
  // so the campaign loop can pipe it into the dashboard-visible log.
  console.log(`[bulk-check] diag: ${diagSummary}`);

  if (updates.length === 0) {
    return { matched: 0, fetched: conns.length, diag: diagSummary };
  }

  // Batch-update via the existing Apps Script bridge. cc → 'Connected
  // Status' column on the new schema; FIELD_MAP handles the column mapping.
  try {
    await batchUpdateSheet(sheetUrl, updates);
  } catch (err) {
    return { matched: 0, fetched: conns.length, error: `batch-update: ${err.message}`, diag: diagSummary };
  }

  const matchedCount = updates.filter((u) => u.cc === 'Connected').length;
  const pendingCount = updates.length - matchedCount;
  return { matched: matchedCount, fetched: conns.length, stamped: pendingCount, diag: diagSummary };
}
