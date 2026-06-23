// Follower Growth Phase 2 — automates the LinkedIn page "Invite to follow" modal.
// Self-contained module (mirrors post-amplification.js); reuses only shared
// helpers.js + the launcher. Does NOT touch outreach.js / actions.js.

// "30/30 credits available · …" → 30 (the LEADING number = currently available).
export function parseCreditsAvailable(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*\d+\s*credits available/i);
  return m ? Number(m[1]) : 0;
}

// Used ONLY to disambiguate duplicate same-name results. true if the headline
// contains the company token, or a significant (>=4-char, non-generic) job-title word.
const TITLE_STOP = new Set(['head', 'senior', 'chief', 'lead', 'manager', 'director', 'officer', 'global', 'group', 'team']);
export function headlineMatches(headline, { jobTitle = '', company = '' } = {}) {
  const h = (headline || '').toLowerCase();
  if (!h) return false;
  const co = (company || '').toLowerCase().trim();
  if (co.length >= 3 && h.includes(co)) return true;
  const words = (jobTitle || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w));
  return words.some((w) => h.includes(w));
}

// Decide which search result to select for a queued person.
// results: [{ name, headline, canInvite }]. Returns the chosen result or null (skip).
// Rule: among invitable results whose name matches — exactly one -> take it (no
// headline check); several -> the one whose headline verifies; else (0 or >1) -> null.
export function pickInviteResult(results, person) {
  const target = ((person && person.name) || '').trim().toLowerCase();
  if (!target) return null;
  const byName = (results || []).filter((r) => r.canInvite && (r.name || '').trim().toLowerCase() === target);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) return null;
  const verified = byName.filter((r) => headlineMatches(r.headline, { jobTitle: person.jobTitle, company: person.company }));
  return verified.length === 1 ? verified[0] : null;
}
