/**
 * Pure: turn the raw download/install failure signals into one short, specific
 * operator-facing line. Empty string when nothing failed. Lives in public/js
 * so both app.js (browser) and node --test can import it.
 *
 * @param {object} [o]
 * @param {string} [o.downloadError] - _downloadState.error from the server
 * @param {string} [o.installError]  - error from /api/update-install
 * @param {boolean} [o.fallback]     - install opened the DMG for a manual drag
 */
export function summarizeUpdateError({ downloadError, installError, fallback } = {}) {
  if (downloadError) return `Update download failed: ${downloadError}`;
  if (installError) return `Update install failed: ${installError}`;
  if (fallback) return 'Couldn’t auto-install — opened the installer so you can drag it to Applications.';
  return '';
}
