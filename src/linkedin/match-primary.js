/**
 * Pure matcher for the LinkedIn typeahead dropdown when adding a recipient.
 *
 * Three-tier match, attempted in order:
 *   1. Exact / startsWith — configured name equals candidate OR candidate
 *      starts with `${configuredName} ` (catches "Sam" → "Sam Ferrer · CEO").
 *   2. Token-prefix — every whitespace token in the configured name is a
 *      prefix of some whitespace word in the candidate. Catches "Sam Ferrer"
 *      → "Samuel Ferrer".
 *   3. Single-candidate fallback — if LinkedIn returns exactly one suggestion,
 *      click it. Almost always correct for a name-based typeahead.
 *
 * Mirrored inline inside src/linkedin/actions.js sendIntroMessage's
 * page.evaluate block — when this file changes, that block must change too.
 * See the comment at the call site for details.
 */

export function normalizeName(v) {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^remove\s+/, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<{text: string}>} candidates - candidate rows from the dropdown
 * @param {string} configuredName            - operator-configured primary name
 * @returns {{ matchIndex: number|null, reason: string }}
 *   reason: 'exact' | 'token-prefix' | 'single-candidate' | 'no-match' | 'no-candidates' | 'empty-config'
 */
export function matchPrimaryCandidate(candidates, configuredName) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { matchIndex: null, reason: 'no-candidates' };
  }
  const norm = normalizeName(configuredName);
  if (!norm) return { matchIndex: null, reason: 'empty-config' };

  // Tier 1: exact / startsWith
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    if (t === norm || t.startsWith(`${norm} `)) {
      return { matchIndex: i, reason: 'exact' };
    }
  }

  // Tier 2: token-prefix match
  const tokens = norm.split(/\s+/);
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    const words = t.split(/\s+/);
    const allMatched = tokens.every(tok => words.some(w => w.startsWith(tok)));
    if (allMatched) {
      return { matchIndex: i, reason: 'token-prefix' };
    }
  }

  // Tier 3: single-candidate fallback
  if (candidates.length === 1) {
    return { matchIndex: 0, reason: 'single-candidate' };
  }

  return { matchIndex: null, reason: 'no-match' };
}
