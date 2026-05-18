/**
 * Pure helpers for the dashboard tab controller. No DOM, no fetch, no
 * state — everything is a pure function so unit tests cover the routing
 * + selection logic without spinning up a browser.
 */

/**
 * Pick which tab to show on dashboard load.
 *
 * Order:
 *   1. If a persisted tab is provided AND that tab has rows → use it.
 *   2. Else if monitoring has rows → 'monitoring' (the operator's most
 *      time-sensitive context — campaigns still actively working).
 *   3. Else if active has rows → 'active' (next-most-time-sensitive).
 *   4. Else → 'all' (last-resort fallback so the page is never empty).
 *
 * @param {object} counts - { active, monitoring, queued, schedules, drafts, past, all }
 * @param {string} [persisted] - tab name from localStorage, may be empty/null
 * @returns {string} tab name
 */
export function pickDefaultTab(counts = {}, persisted = '') {
  const safe = {
    active: counts.active || 0,
    monitoring: counts.monitoring || 0,
    queued: counts.queued || 0,
    schedules: counts.schedules || 0,
    drafts: counts.drafts || 0,
    past: counts.past || 0,
    all: counts.all || 0,
  };
  if (persisted && Object.prototype.hasOwnProperty.call(safe, persisted) && safe[persisted] > 0) {
    return persisted;
  }
  if (safe.monitoring > 0) return 'monitoring';
  if (safe.active > 0) return 'active';
  return 'all';
}

/**
 * Compute the "· N IN OTHER TABS" qualifier for the bulk-action strip.
 * Returns '' when all selected ids belong to the active tab.
 *
 * @param {Set<string>} selection - selected campaign ids
 * @param {string} activeTab - currently-active tab name
 * @param {Record<string,string[]>} idsByTab - per-tab id lists
 * @returns {string} qualifier text or ''
 */
export function computeCrossTabQualifier(selection, activeTab, idsByTab = {}) {
  if (!selection || selection.size === 0) return '';
  const activeIds = new Set(idsByTab[activeTab] || []);
  let inOther = 0;
  for (const id of selection) {
    if (!activeIds.has(id)) inOther++;
  }
  if (inOther === 0) return '';
  return `· ${inOther} IN OTHER TABS`;
}

/**
 * Return a new Set with `id` added. Input set is not mutated.
 */
export function addToSelection(selection, id) {
  const out = new Set(selection);
  out.add(id);
  return out;
}

/**
 * Return a new Set with `id` removed. Input set is not mutated.
 */
export function removeFromSelection(selection, id) {
  const out = new Set(selection);
  out.delete(id);
  return out;
}

/**
 * Return a new Set with `id` toggled. Input set is not mutated.
 */
export function toggleInSelection(selection, id) {
  return selection.has(id)
    ? removeFromSelection(selection, id)
    : addToSelection(selection, id);
}
