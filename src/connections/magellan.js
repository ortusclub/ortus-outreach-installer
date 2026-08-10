// Operation Magellan — turn one Ortus account's LinkedIn connections into a
// plan of HubSpot writes. Pure: no network, no disk. The caller supplies the
// connections and whatever HubSpot already knows; this decides what to do.
//
// The write contract is lifted from the HS Extension (hubspotClient.js), which
// has been doing this per-profile in production for months:
//   - a contact is keyed by its LinkedIn member id, carried as the synthetic
//     email <memberId>@linkedinmembership.id
//   - on CREATE that synthetic address is written as the primary email, because
//     a brand-new contact has none and HubSpot needs a unique key
//   - on UPDATE it is NEVER written — the contact may already have a real
//     address and overwriting it would lose a genuine email. The member id is
//     persisted to its own property instead.
// Getting that asymmetry wrong at Magellan's scale would clobber real email
// addresses across the whole CRM, so it is the thing the tests pin hardest.

// HubSpot property holding the Ortus accounts a person is connected to. It is a
// multi-value property, so values are semicolon-delimited (and the sheet's
// existing rows carry a leading ';' — we reproduce that exactly).
// Read off the live portal, not guessed: internal name `linkedin_1st_connections`,
// label "Linkedin 1st Connections", type enumeration/checkbox with one option per
// Ortus account email.
export const CONNECTIONS_PROP = process.env.HUBSPOT_CONNECTIONS_PROP
  || 'linkedin_1st_connections';

export const MEMBER_ID_PROP = 'linkedin_membership_id';

/** The synthetic key. Byte-identical to the HS Extension's version. */
export function syntheticEmail(memberId) {
  return `${memberId}@linkedinmembership.id`;
}

/**
 * Merge an Ortus account into a semicolon-delimited connections value.
 * Idempotent: re-collecting the same account never grows the value.
 * Returns the merged string, or null when nothing changed.
 */
export function mergeConnections(existingValue, account) {
  const acct = String(account || '').trim().toLowerCase();
  if (!acct) return null;
  const have = String(existingValue || '')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (have.includes(acct)) return null;
  return `;${[...have, acct].join(';')}`;
}

/**
 * A connection LinkedIn told us nothing usable about. The archive export emits
 * rows that are entirely blank except "Connected On" (~1.4% of a real file) for
 * people who block export sharing or have deleted their account. There is no
 * name and no link, so there is nothing to create or match on.
 */
export function isHidden(c) {
  return !c || (!c.memberId && !c.slug);
}

function trimmed(v) {
  const s = (v == null ? '' : String(v)).trim();
  return s || undefined;
}

/** Properties for a brand-new contact. Carries the synthetic email. */
export function createProperties(c, account) {
  const props = {
    [MEMBER_ID_PROP]: c.memberId,
    email: syntheticEmail(c.memberId),
    firstname: trimmed(c.firstName),
    lastname: trimmed(c.lastName),
    company: trimmed(c.company),
    jobtitle: trimmed(c.jobTitle),
    linkedinbio: c.slug ? `https://www.linkedin.com/in/${c.slug}` : undefined,
    [CONNECTIONS_PROP]: `;${String(account).trim().toLowerCase()}`,
  };
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

/**
 * Properties for a contact that already exists. Never includes `email` — see
 * the header note. Only writes fields that are actually new, so an update with
 * nothing to say produces no call at all.
 */
export function updateProperties(c, account, existingProps = {}) {
  const props = {};
  if (c.memberId && !trimmed(existingProps[MEMBER_ID_PROP])) {
    props[MEMBER_ID_PROP] = c.memberId;
  }
  const merged = mergeConnections(existingProps[CONNECTIONS_PROP], account);
  if (merged) props[CONNECTIONS_PROP] = merged;
  // Fill blanks only. A human may have corrected these in HubSpot; LinkedIn's
  // copy is not authoritative enough to overwrite them.
  for (const [key, val] of [['firstname', c.firstName], ['lastname', c.lastName],
    ['company', c.company], ['jobtitle', c.jobTitle]]) {
    if (trimmed(val) && !trimmed(existingProps[key])) props[key] = trimmed(val);
  }
  return props;
}

/** Does this existing contact already carry an email address anywhere? */
export function hasAnyEmail(existingProps = {}) {
  const primary = trimmed(existingProps.email);
  const extra = String(existingProps.hs_additional_emails || '')
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  return Boolean(primary) || extra.length > 0;
}

/** Is the synthetic key already recorded on this contact? */
export function hasSyntheticEmail(existingProps = {}, memberId) {
  const want = syntheticEmail(memberId).toLowerCase();
  const all = [trimmed(existingProps.email) || '',
    ...String(existingProps.hs_additional_emails || '').split(/[;,]/)]
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  return all.includes(want);
}

/**
 * Build the full plan for one account.
 *
 * @param {Array} connections - [{ slug, memberId, firstName, lastName, company, jobTitle }]
 * @param {string} account    - the Ortus account these came from, e.g. antonio@ortusclub.com
 * @param {Function} lookup   - (connection) => existing contact | null,
 *                              where existing is { id, properties }
 * @returns {{creates:Array, updates:Array, additionalEmails:Array, hidden:Array, unresolved:Array, counts:Object}}
 */
export function planAccount(connections, account, lookup) {
  const creates = [];
  const updates = [];
  const additionalEmails = [];
  const hidden = [];
  const unresolved = [];
  const seen = new Set();

  for (const c of connections || []) {
    if (isHidden(c)) { hidden.push(c); continue; }
    // Known person, but no member id yet — nothing to key on. Retried on the
    // next collection rather than written half-formed.
    if (!c.memberId) { unresolved.push(c); continue; }

    // The same person can appear twice in one export (LinkedIn occasionally
    // duplicates); collapse so we never issue two writes for one member id.
    if (seen.has(c.memberId)) continue;
    seen.add(c.memberId);

    const existing = lookup(c);
    if (!existing) {
      creates.push({ connection: c, properties: createProperties(c, account) });
      continue;
    }
    const props = updateProperties(c, account, existing.properties);
    if (Object.keys(props).length) {
      updates.push({ id: existing.id, connection: c, properties: props });
    }
    // The synthetic key still has to exist somewhere on the record, or the next
    // run cannot find this person. If they already have a real address it goes
    // in as an additional email rather than displacing it.
    if (!hasSyntheticEmail(existing.properties, c.memberId)) {
      additionalEmails.push({
        id: existing.id,
        email: syntheticEmail(c.memberId),
        asPrimary: !hasAnyEmail(existing.properties),
      });
    }
  }

  return {
    creates,
    updates,
    additionalEmails,
    hidden,
    unresolved,
    counts: {
      created: creates.length,
      updated: updates.length,
      extraEmails: additionalEmails.length,
      hidden: hidden.length,
      unresolved: unresolved.length,
      total: (connections || []).length,
    },
  };
}
