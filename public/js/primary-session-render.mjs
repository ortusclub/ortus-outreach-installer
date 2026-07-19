/**
 * RETIRED. Personal-primary follow-ups now send from the owner's own machine
 * (local drain — see src/cloud-followup-poller.js), so the engine's per-campaign
 * primary-session 'needs_login' state no longer gates anything and must NOT be
 * surfaced as a "Primary needs login" badge — there is no VM login for a personal
 * account, and the follow-up sends locally regardless of that state. GoLogin
 * primaries never had this state. Kept as a no-op so the existing strip/card call
 * sites (app.js) render nothing without further edits. The honest signal is now
 * the aggregate "follow-ups waiting to send from this machine" nudge
 * (_renderPrimaryNudge + GET /api/local-followups/pending).
 *
 * Still importable by app.js (browser ES module) and node --test.
 */
export function primarySessionBadge(_primarySession) {
  return { show: false };
}
