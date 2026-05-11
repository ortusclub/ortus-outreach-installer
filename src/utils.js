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
 * how the link was generated). Returns the numeric string, or null when the
 * URL has no tab selector (caller should default to the first tab).
 *
 * @param {string} url
 * @returns {string|null}
 */
export function extractSheetGid(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/[#&?]gid=(\d+)/);
  return match ? match[1] : null;
}
