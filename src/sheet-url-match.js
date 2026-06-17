/**
 * Loose LinkedIn-URL identity + duplicate-row matching for sheet write-back.
 *
 * v2.105 — when the same lead sits on duplicate rows, a status stamp must land
 * on EVERY copy (not just the first/last one), and the same person must resolve
 * to one identity regardless of protocol, `www.`, query string, fragment,
 * trailing slash, or case. Otherwise "Connection Request Sent" and "Still
 * Pending" scatter across what look like different rows for one lead.
 *
 * This module is the PURE, unit-tested source of truth. The Apps Script
 * (`google-apps-script.js`) mirrors `normalizeLeadUrl` inline as `normalizeUrl`
 * and `matchingRowNumbers` as `findRowsByUrl` — Apps Script can't import, so the
 * two are hand-kept in sync (same pattern as match-primary.js ↔ actions.js).
 * When this file changes, update the mirror.
 */

export function normalizeLeadUrl(url) {
  if (!url) return '';
  return url
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')      // drop query string + fragment
    .replace(/^https?:\/\//, '') // drop protocol
    .replace(/^www\./, '')       // drop www.
    .replace(/\/+$/, '');        // drop trailing slash(es)
}

/**
 * Every 1-based sheet row whose URL resolves to the same identity as searchUrl.
 *
 * Exact normalized match first; if none match, fall back to a `/in/<slug>`
 * contains-match so a bare slug still finds a full-URL cell (mirrors the old
 * handleUpdateRow loose fallback). Always returns ALL matches so the caller can
 * stamp every duplicate copy.
 *
 * @param {Array<string>} cellUrls - raw URL cell values, one per data row, in order
 * @param {string} searchUrl       - the lead URL being stamped
 * @param {number} startRow        - sheet row number of cellUrls[0] (default 2: row 1 = header)
 * @returns {number[]} matching sheet row numbers
 */
export function matchingRowNumbers(cellUrls, searchUrl, startRow = 2) {
  const target = normalizeLeadUrl(searchUrl);
  if (!target || !Array.isArray(cellUrls)) return [];

  const exact = [];
  for (let i = 0; i < cellUrls.length; i++) {
    if (normalizeLeadUrl(cellUrls[i]) === target) exact.push(i + startRow);
  }
  if (exact.length > 0) return exact;

  // Loose fallback: match by the /in/<slug> token. Only extract a slug from the
  // canonical `/in/<slug>` form, or treat the search as a bare slug when it has
  // no slash/dot/whitespace — never pluck the first token out of a full URL
  // (that would match "https"/"www"/"linkedin" against every cell).
  const inMatch = String(searchUrl).match(/linkedin\.com\/in\/([^/?#]+)/i);
  let slug = '';
  if (inMatch) slug = inMatch[1].toLowerCase();
  else if (!/[/.\s]/.test(String(searchUrl))) slug = String(searchUrl).trim().toLowerCase();
  if (!slug) return [];
  const loose = [];
  for (let i = 0; i < cellUrls.length; i++) {
    const cell = (cellUrls[i] || '').toString().toLowerCase();
    if (cell.indexOf(slug) !== -1) loose.push(i + startRow);
  }
  return loose;
}
