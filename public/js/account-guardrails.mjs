// Pure helpers for account-selection guardrails (#5). No DOM, no I/O.
// Flags accounts assigned to / in use by another operator; computes the mode-aware
// passover warning. Consumed by public/js/app.js and by tests. Zero invented data.

function norm(s) { return String(s || '').trim().toLowerCase(); }

const IN_USE = 'in use';
// [creditField, reserverField|null] — ccCredits has NO reserver field in the SoO.
const CREDIT_FIELDS = [
  ['linkedinCredits', 'linkedinUser'],
  ['inmailCredits', 'inmailUser'],
  ['salesNavCredits', 'salesNavUser'],
  ['ccCredits', null],
];

/**
 * Classify one account at selection time. `me` = operator identifier (lowercased upstream).
 * Returns { flagged, reason: 'assigned'|'in-use'|null, label }.
 */
export function classifyAccountFlag(soo, me) {
  if (!soo || !me) return { flagged: false, reason: null, label: '' };
  const meN = norm(me);
  const section = norm(soo.section);
  const isPool = section.includes('pool') || section.includes('unassigned');

  const assignee = String(soo.Assignee || soo.assignee || '').trim();
  if (!isPool && assignee && assignee !== '-' && !norm(assignee).includes(meN)) {
    return { flagged: true, reason: 'assigned', label: 'assigned to ' + assignee };
  }

  for (const [creditKey, userKey] of CREDIT_FIELDS) {
    if (norm(soo[creditKey]) === IN_USE) {
      const reserver = userKey ? String(soo[userKey] || '').trim() : '';
      if (!reserver) return { flagged: true, reason: 'in-use', label: 'in use' };
      if (!norm(reserver).includes(meN)) return { flagged: true, reason: 'in-use', label: 'in use by ' + reserver };
    }
  }
  return { flagged: false, reason: null, label: '' };
}

const CC_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message']);
const MONTHLY_MODES = new Set(['open_profile_only', 'inmail_only']);

/** Which credit channel a campaign mode consumes (drives the passover warning). */
export function mapModeToChannel(mode) {
  if (CC_MODES.has(mode)) return 'cc';
  if (MONTHLY_MODES.has(mode)) return 'monthly';
  return null; // message_only / check_status / introduce_back consume no credits
}

/** Mode-aware passover warning. passover = getPassoverStatus() → { monthly, cc }. */
export function passoverWarning(mode, passover) {
  const channel = mapModeToChannel(mode);
  if (!channel || !passover) return null;
  const info = passover[channel];
  if (!info || info.active) return null;
  return { channel, label: info.label };
}

/** Aggregate the currently-selected accounts. selectedSooList = [{ email, soo }]. */
export function summarizeSelection(selectedSooList, me, mode, passover) {
  const flagged = [];
  for (const entry of (selectedSooList || [])) {
    const f = classifyAccountFlag(entry.soo, me);
    if (f.flagged) flagged.push({ email: entry.email, label: f.label });
  }
  const pw = passoverWarning(mode, passover);
  return { flagged, passover: pw, hasWarnings: flagged.length > 0 || !!pw };
}
