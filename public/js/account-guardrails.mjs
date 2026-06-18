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
