// Browser-safe run-target logic shared by the wizard tabs. Mirrors the
// engine-supported mode set used at launch (app.js startCampaign _cloudModeNow /
// refreshCloudToggle). Kept here as the single browser source of truth.
export const CLOUD_MODES = new Set([
  'connect_only', 'message_only', 'introduce_back', 'connect_and_introduce',
  'connect_and_message', 'follower_growth', 'inmail_only', 'open_profile_only', 'check_status',
]);
export const DEFAULT_RUN_TARGET = 'local'; // operator default — cloud VM is a deliberate opt-in

export function isCloudMode(mode) { return CLOUD_MODES.has(String(mode || '')); }

export function modeAvailability(mode, runTarget, { engineConfigured = true } = {}) {
  if (runTarget !== 'cloud') return { available: true, reason: '' };
  if (!engineConfigured) return { available: false, reason: 'Cloud engine not configured' };
  if (!isCloudMode(mode)) return { available: false, reason: 'This mode is local-only — switch to 💻 This machine' };
  return { available: true, reason: '' };
}

export function runTargetFacts(runTarget) {
  if (runTarget === 'cloud') {
    return [
      { ok: true,  text: 'Survives closing the laptop' },
      { ok: true,  text: 'Watch it live with 👁 Show on the board' },
      { ok: false, text: 'Stop only — no pause/resume' },
      { ok: false, text: '~2-3 min warm-up' },
      { ok: false, text: 'Senders must be GoLogin accounts' },
      { ok: false, text: 'No automated follow-up (local primary)' },
    ];
  }
  return [
    { ok: true,  text: 'Full control — pause, resume, edit mid-run' },
    { ok: true,  text: 'Every mode available' },
    { ok: false, text: 'Stops if the app closes or the Mac sleeps' },
  ];
}
