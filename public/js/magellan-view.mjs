// Pure helpers for the Magellan card — browser-safe (no DOM), so app.js imports
// them and node --test unit-tests them. Same arrangement as vjcard.mjs.

/**
 * The ONLY percentage in this card.
 *
 * renderMagellanState used to compute this twice: once from whole accounts and
 * again with the in-account fraction blended in, writing both to #mg-pct — and
 * the Check button read the first while the hero showed the second. That is how
 * 92% and 83% ended up on screen together. The in-account fraction is part of
 * the answer, not a later correction to it.
 *
 * Stage weighting, unchanged from what the card already did:
 *   'check' — asking HubSpot IS the whole of an account's work
 *   'list'  — reading the connections list is the front half
 *   'ids'   — resolving each person's LinkedIn ID is the back half
 */
export function magellanPct(state = {}) {
  const s = state || {};
  const total = Number(s.total) || 0;
  if (total <= 0) return 0;
  const done = Number(s.done) || 0;
  const c = s.current;
  let frac = 0;
  if (c && Number(c.total) > 0 && c.count != null) {
    const raw = Math.min(1, Number(c.count) / Number(c.total));
    frac = c.stage === 'check' ? raw : c.stage === 'ids' ? 0.5 + raw / 2 : raw / 2;
  }
  return Math.min(100, Math.round(((done + frac) / total) * 100));
}

/**
 * What pressing Check would actually run.
 *
 * The bar said "13 accounts selected" over a run that reported "11 of 12",
 * because the HubSpot allowlist drops accounts it has no option for and only
 * says so in the log afterwards. Neither number was wrong; nothing connected
 * them.
 *
 * `importable` is null when the portal could not be asked. One unknown makes the
 * whole split unknown — a screen that guesses which colleague's account is about
 * to be skipped is worse than one that stays quiet.
 *
 * @param {Array<{account: string, importable: boolean|null}>} accounts
 */
export function selectionSummary(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const known = list.every((a) => typeof a.importable === 'boolean');
  const blocked = known ? list.filter((a) => !a.importable).map((a) => a.account) : [];
  return { total: list.length, usable: list.length - blocked.length, blocked, known };
}
