const DERIVED_PROFILE_MODES = new Set(['check_status', 'message_only', 'introduce_back']);
const ACTION_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message', 'open_profile_only', 'inmail_only']);

export function launchValidation({ mode, profileIds, targetCount, diagnostics = {} } = {}) {
  const m = String(mode || 'connect_only');
  const fixes = [];
  if (!DERIVED_PROFILE_MODES.has(m) && (!Array.isArray(profileIds) || !profileIds.filter(Boolean).length)) fixes.push({ code: 'accounts', label: 'Choose accounts' });
  if (ACTION_MODES.has(m) && Number(targetCount) === 0) {
    // Name the actual reason. "Review filtered rows" on a sheet whose rows were
    // never touched sends the operator to look at the wrong thing.
    if (Number(diagnostics.alreadyProcessed) > 0) fixes.push({ code: 'rows', label: `${diagnostics.alreadyProcessed} row(s) already have a Stage — clear it to send them again` });
    if (Number(diagnostics.noUrl) > 0) fixes.push({ code: 'url', label: `${diagnostics.noUrl} row(s) have no LinkedIn URL — check the LinkedIn column` });
    if (Number(diagnostics.unmatchedSenders) > 0) fixes.push({ code: 'sender', label: 'Change sender column' });
    if (!fixes.length) fixes.push({ code: 'sheet', label: 'Review sheet and filters' });
  }
  if (!fixes.length) return null;
  return { code: Number(targetCount) === 0 ? 'zero-actionable-targets' : 'zero-accounts',
    message: Number(targetCount) === 0 ? 'No actionable leads were found. The campaign was not started.' : 'Choose at least one sending account before starting.', fixes };
}
