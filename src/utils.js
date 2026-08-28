/**
 * Shared utilities.
 */

/**
 * Extracts a Google Sheet ID from various URL formats.
 * @param {string} url
 * @returns {string}
 */
export function extractSheetId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(url.trim())) return url.trim();
  throw new Error(`Cannot extract Google Sheet ID from URL: ${url}`);
}

/**
 * Extracts the tab (gid) from a Google Sheet URL.
 * Matches #gid=, ?gid=, or &gid= forms (Google emits all three depending on
 * how the link was generated). Returns the numeric string, or '' when the
 * URL has no tab selector.
 *
 * @param {string} url
 * @returns {string}
 */
export function extractSheetGid(url) {
  if (!url || typeof url !== 'string') return '';
  const match = url.match(/[#&?]gid=(\d+)/);
  return match ? match[1] : '';
}

/**
 * Extracts the spreadsheet ID (the long alphanumeric segment after /d/) from
 * a Google Sheets URL. Returns '' when the URL doesn't contain that segment.
 *
 * @param {string} url
 * @returns {string}
 */
export function spreadsheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

/**
 * Return a URL that definitely carries gid=<gid>. Replaces any existing gid
 * in both the query-string and hash. Empty gid → url unchanged.
 *
 * @param {string} url
 * @param {string|number} gid
 * @returns {string}
 */
export function withGid(url, gid) {
  const g = String(gid || '').replace(/\D/g, '');
  if (!g) return url;
  let u = String(url || '');
  u = u.replace(/([?&])gid=\d+/g, '$1gid=' + g).replace(/#gid=\d+/g, '#gid=' + g);
  if (!/[?&]gid=/.test(u) && !/#gid=/.test(u)) {
    u += (u.includes('#') ? '' : '#') + 'gid=' + g;
  }
  return u;
}

/**
 * Suppression list matching — normalizes emails and LinkedIn URLs/membership
 * IDs so minor formatting differences (http vs https, www, trailing slash,
 * query params, casing) don't cause a false negative.
 */
export function normalizeSuppressionValue(raw) {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  // LinkedIn URL normalization: strip protocol, www., trailing slash, query string.
  if (v.includes('linkedin.com')) {
    v = v.replace(/^https?:\/\//, '');
    v = v.replace(/^www\./, '');
    v = v.replace(/\?.*$/, '');
    v = v.replace(/\/+$/, '');
  }
  return v;
}

/**
 * Builds a normalized Set from a list of raw suppression values (emails,
 * LinkedIn URLs, or membership IDs), skipping blanks.
 */
export function buildSuppressionSet(values) {
  const set = new Set();
  for (const v of values || []) {
    const norm = normalizeSuppressionValue(v);
    if (norm) set.add(norm);
  }
  return set;
}

/**
 * True if any of the row's candidate values (email, LinkedIn URL/bio,
 * membership ID) match the suppression set.
 */
export function isRowSuppressed(row, suppressionSet) {
  if (!suppressionSet || suppressionSet.size === 0) return false;
  for (const key of Object.keys(row || {})) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('email') || lowerKey.includes('linkedin') || lowerKey.includes('membership')) {
      const norm = normalizeSuppressionValue(row[key]);
      if (norm && suppressionSet.has(norm)) return true;
    }
  }
  return false;
}
