const DERIVED_PROFILE_MODES = new Set(['check_status', 'message_only', 'introduce_back']);
const PREFLIGHT_TARGET_MODES = new Set([
  'connect_only', 'connect_and_introduce', 'connect_and_message',
  'open_profile_only', 'inmail_only',
]);

export function launchValidationError({ mode, profileIds, targetCount } = {}) {
  const normalizedMode = String(mode || 'connect_only');
  if (!DERIVED_PROFILE_MODES.has(normalizedMode)
      && (!Array.isArray(profileIds) || profileIds.filter(Boolean).length === 0)) {
    return 'Choose at least one sending account before starting the campaign.';
  }
  if (PREFLIGHT_TARGET_MODES.has(normalizedMode) && Number(targetCount) === 0) {
    return 'No actionable leads were found in the selected sheet tab. The campaign was not started.';
  }
  return null;
}
