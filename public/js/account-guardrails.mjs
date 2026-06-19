// Pure helpers for account-selection guardrails (#5). No DOM, no I/O.
// Flags accounts assigned to / in use by another operator; computes the mode-aware
// passover warning. Consumed by public/js/app.js and by tests. Zero invented data.

function norm(s) { return String(s || '').trim().toLowerCase(); }

/**
 * Clean a SoO reserver/assignee value down to just the person for display.
 * The SoO "User" columns can hold a log string like
 *   "ivy@ortusclub.com, 2026-06-17 07:05, In Use"
 * Take the part before the first comma; if that's an email, keep the local part
 * before "@". A plain name ("Cathy") passes through unchanged.
 */
export function cleanWho(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.split(',')[0].trim();        // drop trailing "…, timestamp, In Use"
  if (s.includes('@')) s = s.split('@')[0].trim();  // email → local part
  return s;
}

export function isRestrictedStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  return /restricted/.test(s) || s === 'inaccessible';
}

/**
 * Accounts living under the "Construction" section header (column A of the SoO)
 * must never appear in the GoLogin launcher window. The section is derived by
 * handleGetSoO straight from the sheet's column-A header rows, so this stays
 * correct even as the section's starting row moves over time — we key on the
 * section name, not a row number. Substring + case-insensitive so a header like
 * "Construction Accounts" still matches. No SoO record → cannot identify the
 * section → not hidden (we only hide what the SoO positively tells us to).
 */
export function isHiddenSection(soo) {
  return norm(soo && soo.section).includes('construction');
}

const IN_USE = 'in use';
// [creditField, reserverField|null] — each channel's reserver lives in its OWN
// "User" column. The SoO has a dedicated "CC User" column (raw header key,
// emitted by handleGetSoO alongside the structured fields), so CC reads from
// there — NOT from linkedinUser (the Linkedin OP User column), which only
// names the OP reserver and is empty for CC-only accounts. Reading CC from
// linkedinUser mis-classified CC-in-use accounts (e.g. rafaela) as FREE.
const CREDIT_FIELDS = [
  ['linkedinCredits', 'linkedinUser'],
  ['inmailCredits', 'inmailUser'],
  ['salesNavCredits', 'salesNavUser'],
  ['ccCredits', 'CC User'],
];
// Same pairing as a lookup: credit column → its paired "User" (reserver) column.
const CREDIT_USER = Object.fromEntries(CREDIT_FIELDS);

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

/**
 * The exact SoO credit COLUMN a campaign mode draws from. Finer-grained than
 * mapModeToChannel (which only buckets into cc/monthly for passover): NA gating
 * needs the specific column, since open-profile and inmail share the monthly
 * passover but consume different credits.
 *   Connect* → CC (Credits) | open_profile_only → Linkedin (OP Credits)
 *   inmail_only → Inmail Credits | credit-free modes → null
 */
export function mapModeToCreditField(mode) {
  if (CC_MODES.has(mode)) return 'ccCredits';
  if (mode === 'open_profile_only') return 'linkedinCredits';
  if (mode === 'inmail_only') return 'inmailCredits';
  return null;
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

/**
 * Classify a single account tile into one of four exclusive states:
 *   'blocked'  — SoO Status is restricted/inaccessible; never selectable.
 *   'in-use'   — a credit channel is stamped "In Use" by a different operator.
 *   'assigned' — tile belongs to another operator's team section (and credit
 *                channel is not yet active, so passover hasn't freed it yet).
 *   'free'     — available for the current operator to use.
 *
 * Priority: blocked > in-use > assigned > free.
 * Pure — no DOM, no I/O.
 *
 * @param {object|null} soo      Raw SoO row object (all columns).
 * @param {string}      me       Current operator identifier (lowercased upstream).
 * @param {string}      mode     Campaign mode string (e.g. 'connect_only').
 * @param {object}      passover getPassoverStatus() result: { cc, monthly } each { active, label }.
 * @returns {{ state: 'blocked'|'in-use'|'assigned'|'free', who: string, frees: string }}
 */
export function classifyAccountState(soo, me, mode, passover) {
  const FREE = { state: 'free', who: '', frees: '' };

  // 1. Guard: missing soo or me → free
  if (!soo || !me) return FREE;

  // 2. Blocked: SoO Status is restricted or inaccessible (column B). Independent
  // of the per-channel credit columns below.
  if (isRestrictedStatus(soo.Status || soo.status)) return { state: 'blocked', who: '', frees: '', reason: 'restricted' };

  const meN = norm(me);

  // 3. The campaign's OWN credit column is the source of truth for whether this
  // account can run THIS campaign. Channel-aware via mapModeToCreditField:
  //   connect_* → CC (Credits) [AH] · open_profile_only → Linkedin (OP Credits)
  //   [AD] · inmail_only → Inmail Credits [AF]. (Sales Nav [AB] has no mode.)
  // Dropdown values: Available | In Use | Used | - | NA | Partial Inaccessible.
  // Rule: ONLY "Available" is usable; "In Use" → in-use (reserver from the
  // paired User column); any OTHER non-blank value → not usable (NA → "no
  // credits"; Used / - / Partial Inaccessible → unavailable). A blank cell is
  // not a positive "unusable" signal, so it falls through to free. Credit-free
  // modes (message_only / check_status / introduce_back → null) skip this.
  const creditField = mapModeToCreditField(mode);
  if (creditField) {
    const v = norm(soo[creditField]);
    if (v === IN_USE) {
      const userField = CREDIT_USER[creditField];
      const reserver = userField ? String(soo[userField] || '').trim() : '';
      return { state: 'in-use', who: cleanWho(reserver), frees: '' };
    }
    if (v && v !== 'available') {
      const reason = (v === 'na' || v === 'n/a') ? 'na' : 'unavailable';
      return { state: 'blocked', who: '', frees: '', reason, label: String(soo[creditField] || '').trim() };
    }
    // 'available' (or blank) → fall through to the assigned / free check.
  }

  // 4. Assigned: section is not a pool, assignee is someone else
  const assignee = String(soo.Assignee || soo.assignee || '').trim();
  const isPool = norm(soo.section).includes('pool') || norm(soo.section).includes('unassigned');
  if (!isPool && assignee && assignee !== '-' && !norm(assignee).includes(meN)) {
    const channel = mapModeToChannel(mode);
    if (channel === null) return { state: 'assigned', who: cleanWho(assignee), frees: '' };
    if (passover && passover[channel] && passover[channel].active === false) {
      return { state: 'assigned', who: cleanWho(assignee), frees: passover[channel].label || '' };
    }
    // Channel is active (passover lifted) → treat as free
    return FREE;
  }

  // 5. Default: free
  return FREE;
}
