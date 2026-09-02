const BASE = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
export const PROPS = ['firstname', 'lastname', 'linkedinbio', 'linkedin_membership_id',
  'country', 'state', 'city', 'jobtitle', 'company', 'hs_lead_status', 'lastmodifieddate'];

export function buildFilterGroups({ countries = [], regions = [], cities = [], jobTitles = [], companies = [] }) {
  const base = [];
  if (countries.length) base.push({ propertyName: 'country', operator: 'IN', values: countries });
  if (regions.length) base.push({ propertyName: 'state', operator: 'IN', values: regions });
  if (cities.length) base.push({ propertyName: 'city', operator: 'IN', values: cities });
  if (companies.length) base.push({ propertyName: 'company', operator: 'IN', values: companies });
  if (!jobTitles.length) return [{ filters: base }];
  // HubSpot ORs filterGroups, ANDs within. Distribute each title into its own group.
  // Cap at 5 groups (HubSpot max). Titles beyond 5 are dropped — log it in the CLI.
  return jobTitles.slice(0, 5).map(t => ({
    filters: [...base, { propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: t }],
  }));
}

async function postWithRetry(fetchImpl, url, token, body, attempt = 0) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    return postWithRetry(fetchImpl, url, token, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
  return res;
}

export async function searchContacts(params, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, maxPages = 50 } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const filterGroups = buildFilterGroups(params);
  const out = []; let after;
  for (let page = 0; page < maxPages; page++) {
    const body = { filterGroups, properties: PROPS, limit: params.limit || 100, ...(after ? { after } : {}) };
    const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token, body);
    const json = await res.json();
    for (const r of json.results || []) out.push({ id: r.id, ...r.properties });
    after = json.paging && json.paging.next && json.paging.next.after;
    if (!after) break;
  }
  return out;
}

// Canonical URL variants to match HubSpot's stored linkedinbio forms against a bare CSV slug.
// Catches https/http www forms; country subdomains (sg.linkedin.com) and non-www are NOT matched
// here — LinkedIn member-ID resolution (Phase 1.5) closes that residual.
export function slugVariants(slug) {
  return [`https://www.linkedin.com/in/${slug}`, `http://www.linkedin.com/in/${slug}`];
}

// Network-first: find which of these bare slugs exist in HubSpot via batched `linkedinbio IN`.
export async function lookupBySlugs(slugs, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, valuesPerBatch = 100 } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const slugsPerBatch = Math.max(1, Math.floor(valuesPerBatch / 2)); // 2 variants per slug
  const out = [];
  for (let i = 0; i < slugs.length; i += slugsPerBatch) {
    const values = slugs.slice(i, i + slugsPerBatch).flatMap(slugVariants);
    const body = { filterGroups: [{ filters: [{ propertyName: 'linkedinbio', operator: 'IN', values }] }], properties: PROPS, limit: 100 };
    let after;
    do {
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token, after ? { ...body, after } : body);
      const json = await res.json();
      for (const r of json.results || []) out.push({ id: r.id, ...r.properties });
      after = json.paging && json.paging.next && json.paging.next.after;
    } while (after);
  }
  return out;
}

// ── Operation Magellan — the write side ──────────────────────────────────────
// The read helpers above feed the warm-reach search. Everything below pushes
// collected connections INTO HubSpot. Kept separate so the warm-reach cache
// keeps requesting its own narrow PROPS set (it stores 152MB as it is).

import { CONNECTIONS_PROP, MEMBER_ID_PROP, LOCATION_PROP, syntheticEmail } from './magellan.js';
import { mergeOptions, verifyReadBack } from './hubspot-options.js';

// What we need back to decide create-vs-update and whether a real email exists.
// createdate earns its place: when one person has three records, "in HubSpot
// since 2021" is how a human tells the real one from the import's leftovers.
export const MAGELLAN_PROPS = ['firstname', 'lastname', 'company', 'jobtitle',
  'linkedinbio', 'email', 'hs_additional_emails', 'createdate',
  MEMBER_ID_PROP, CONNECTIONS_PROP, LOCATION_PROP];

// HubSpot caps batch endpoints at 100 objects per call.
const BATCH_LIMIT = 100;

function chunk(arr, size = BATCH_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Find existing contacts by LinkedIn member id — the key Magellan writes.
 * Returns a Map memberId → { id, properties }.
 */
export async function lookupByMemberIds(memberIds,
  { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, onProgress = null, slugByMemberId = null } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const out = new Map();
  // Two contacts can carry the same LinkedIn id — the old manual process made
  // one keyed on the synthetic address, and the person also exists under their
  // real email. Keeping only "whichever HubSpot returned last" means updating
  // an arbitrary half of a duplicate pair, so collect every hit and choose.
  const all = new Map();
  const ids = [...new Set((memberIds || []).filter(Boolean).map(String))];
  // 300-odd sequential round trips on a big account. Without a beat the card
  // sits still for three minutes and reads as frozen.
  let asked = 0;
  for (const batch of chunk(ids, BATCH_LIMIT)) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: MEMBER_ID_PROP, operator: 'IN', values: batch }] }],
      properties: MAGELLAN_PROPS,
      limit: BATCH_LIMIT,
    };
    let after;
    do {
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token,
        after ? { ...body, after } : body);
      const json = await res.json();
      for (const r of json.results || []) {
        const mid = r.properties?.[MEMBER_ID_PROP];
        if (!mid) continue;
        const key = String(mid);
        if (!all.has(key)) all.set(key, []);
        all.get(key).push({ id: r.id, properties: r.properties || {} });
      }
      after = json.paging && json.paging.next && json.paging.next.after;
    } while (after);
    asked += batch.length;
    onProgress?.({ done: asked, total: ids.length });
  }

  // Second pass: the ids the search above could not see at all.
  //
  // The old manual process wrote the synthetic address as a contact's primary
  // email but left linkedin_membership_id empty, so those records match no
  // member-id filter. The app concluded "new person", planned a create, and the
  // create then collided on the very address that made the record invisible —
  // "that email address is already used by someone else". That is the whole of
  // Abygael's 17 Aug run: 24 planned creates, 24 rejected, 0 written.
  //
  // Measured against the live portal on 2026-08-17: 401 such records out of
  // 12.2M contacts, 212 of them created this year — so this is an active
  // inflow, not a closed backlog, and a one-off backfill would refill.
  //
  // Finding them by the synthetic address recovers the record we should have
  // been updating all along. updateProperties writes the member id back to it
  // (it fills that property whenever it is blank), so every run permanently
  // repairs the records it touches and this second pass shrinks over time.
  const missing = ids.filter((id) => !all.has(id));
  for (const batch of chunk(missing, BATCH_LIMIT)) {
    // The address we searched IS the member id, so map back from it rather than
    // trusting a property the record is missing by definition.
    const idByEmail = new Map(batch.map((id) => [syntheticEmail(id).toLowerCase(), id]));
    const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token, {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: [...idByEmail.keys()] }] }],
      properties: MAGELLAN_PROPS,
      limit: BATCH_LIMIT,
    });
    const json = await res.json();
    for (const r of json.results || []) {
      const mid = idByEmail.get(String(r.properties?.email || '').trim().toLowerCase());
      // Never overwrite a member-id hit: that one is the record a human
      // maintains, this one is the synthetic shell.
      if (!mid || all.has(mid)) continue;
      all.set(mid, [{ id: r.id, properties: r.properties || {} }]);
    }
    asked += batch.length;
    onProgress?.({ done: Math.min(asked, ids.length), total: ids.length });
  }

  // Third pass: the person is in HubSpot under their LinkedIn URL but with NO
  // member id — Apollo / Sales-Nav / manual imports that carry `linkedinbio`
  // and never a linkedin_membership_id. Neither pass above can see them, so the
  // import used to create a DUPLICATE (measured on Kyle Andersen @ Pfizer,
  // 2026-09-02: in HubSpot as kyle.andersen@pfizer.com, bio /in/kyle-andersen-…,
  // member id blank → planned as new). Matching by the profile URL recovers the
  // record; updateProperties then writes the missing member id onto it, so —
  // like the synthetic pass — every run permanently repairs what it touches and
  // this pass shrinks over time. Only runs when the caller supplies slugs.
  const stillMissing = slugByMemberId ? ids.filter((id) => !all.has(id)) : [];
  if (stillMissing.length) {
    const getSlug = (id) => {
      const s = slugByMemberId.get ? slugByMemberId.get(id) : slugByMemberId[id];
      return String(s || '').trim().toLowerCase();
    };
    const slugToId = new Map();
    for (const id of stillMissing) { const s = getSlug(id); if (s) slugToId.set(s, id); }
    const slugs = [...slugToId.keys()];
    // 2 URL variants per slug, so halve the batch to stay under the value cap.
    for (const batch of chunk(slugs, Math.floor(BATCH_LIMIT / 2))) {
      const values = batch.flatMap((s) => slugVariants(s));
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token, {
        filterGroups: [{ filters: [{ propertyName: 'linkedinbio', operator: 'IN', values }] }],
        properties: MAGELLAN_PROPS,
        limit: BATCH_LIMIT,
      });
      const json = await res.json();
      for (const r of json.results || []) {
        const m = String(r.properties?.linkedinbio || '').match(/\/in\/([^/?#,]+)/i);
        const slug = m ? m[1].trim().toLowerCase() : '';
        const mid = slug && slugToId.get(slug);
        // Never displace a member-id or synthetic hit — those are more certain.
        if (!mid || all.has(mid)) continue;
        all.set(mid, [{ id: r.id, properties: r.properties || {} }]);
      }
      asked += batch.length;
      onProgress?.({ done: Math.min(asked, ids.length), total: ids.length });
    }
  }

  // Prefer the human-maintained record — the one with a real email — over the
  // one the old CSV process created under a synthetic address. Writing to that
  // one keeps the connection on the record people actually look at.
  const duplicates = [];
  for (const [mid, list] of all) {
    const real = list.find((c) => !isSynthetic(c.properties?.email));
    const keep = real || list[0];
    out.set(mid, keep);
    if (list.length > 1) {
      duplicates.push({
        memberId: mid,
        keptId: keep.id,
        otherIds: list.filter((c) => c.id !== keep.id).map((c) => c.id),
        name: [keep.properties?.firstname, keep.properties?.lastname].filter(Boolean).join(' '),
        company: keep.properties?.company || '',
        // "Same LinkedIn id" is our only evidence that two records are one
        // person. If that id was ever typed onto the wrong contact, merging
        // would fuse two different humans — and HubSpot has no undo. So the
        // names have to agree as well, and when they don't we say so instead
        // of merging.
        nameMatch: sameName(list),
        // Every record, so the screen can show a person WHY one was chosen —
        // a real address and an older join date — instead of two id numbers.
        records: list.map((c) => ({
          id: c.id,
          email: c.properties?.email || '',
          synthetic: isSynthetic(c.properties?.email),
          createdAt: c.properties?.createdate || '',
          kept: c.id === keep.id,
        })),
      });
    }
  }
  // Array-style property, same convention getRecentConnections uses for
  // .error / .partial — callers that don't care never see it.
  out.duplicates = duplicates;
  return out;
}

function isSynthetic(email) {
  return /@linkedinmembership\.id\s*$/i.test(String(email || ''));
}

/** The member id back out of a synthetic address, or '' if it is not one. */
function memberIdFromSynthetic(email) {
  const m = /^\s*([^@\s]+)@linkedinmembership\.id\s*$/i.exec(String(email || ''));
  return m ? m[1] : '';
}

/**
 * Do every record agree on who this is? Compared loosely — punctuation and
 * case differ all over a CRM — but a genuine disagreement ("Ina Dakay" vs
 * "Patrick Reyes") must fail, because that is the case merging cannot undo.
 * A record with no name at all abstains rather than blocking.
 */
function sameName(records) {
  const names = records
    .map((c) => [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' '))
    .map((s) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (names.length < 2) return true;
  return names.every((x) => x === names[0]);
}

/**
 * A batch HubSpot only partly accepted answers 207, not 4xx — so `res.ok` is
 * true, `postWithRetry` returns happily, and `results` holds ONLY the rows that
 * landed. Without this the rejected half is invisible: not written, not
 * counted, not reported. `size` is the number of people it cost, the same field
 * a wholly-rejected batch records, so both kinds add up the same way downstream.
 */
function partialFailure(json) {
  const size = Number(json.numErrors) || (json.errors || []).length;
  if (!size) return null;
  const first = (json.errors || [])[0] || {};
  return { size, error: first.message || `HubSpot rejected ${size} of the rows in this batch` };
}

/**
 * Create contacts in batches. `inputs` is [{ properties }] straight off the plan.
 * Returns { created, errors[] }. A failed batch is reported, not thrown — one
 * bad row must not abandon the other 300k.
 */
export async function batchCreate(inputs, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, onProgress } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  let created = 0;
  const errors = [];
  // memberId -> new contact id. HubSpot answers a create with the record it
  // made; throwing that away meant the only way to find a just-imported person
  // was to search for them again. Keyed off the synthetic email because that is
  // the one property we are certain we sent for every create.
  const ids = new Map();
  for (const batch of chunk(inputs)) {
    try {
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/batch/create`, token,
        { inputs: batch.map((b) => ({ properties: b.properties })) });
      const json = await res.json();
      created += (json.results || []).length;
      for (const r of json.results || []) {
        const mid = memberIdFromSynthetic(r.properties?.email);
        if (mid && r.id) ids.set(mid, String(r.id));
      }
      const partial = partialFailure(json);
      if (partial) errors.push(partial);
    } catch (err) {
      errors.push({ size: batch.length, error: err.message });
    }
    onProgress?.({ created, errors: errors.length });
  }
  return { created, errors, ids };
}

/** Update contacts in batches. `inputs` is [{ id, properties }]. */
export async function batchUpdate(inputs, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, onProgress } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  let updated = 0;
  const errors = [];
  for (const batch of chunk(inputs)) {
    try {
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/batch/update`, token,
        { inputs: batch.map((b) => ({ id: b.id, properties: b.properties })) });
      const json = await res.json();
      updated += (json.results || []).length;
      const partial = partialFailure(json);
      if (partial) errors.push(partial);
    } catch (err) {
      errors.push({ size: batch.length, error: err.message });
    }
    onProgress?.({ updated, errors: errors.length });
  }
  return { updated, errors };
}

/**
 * Attach the synthetic key to a contact that already exists.
 * No batch endpoint exists for secondary emails, so this is one call each —
 * which is why the plan only ever lists contacts genuinely missing the key.
 */
export async function attachSyntheticEmail({ id, email, asPrimary },
  { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  if (asPrimary) {
    const res = await fetchImpl(`${BASE}/crm/v3/objects/contacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { email } }),
    });
    if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
    return { id, email, action: 'primary_added' };
  }
  // Legacy endpoint — the only way to write hs_additional_emails. Same call the
  // HS Extension uses (hubspotClient.js addAdditionalEmail).
  const res = await fetchImpl(
    `${BASE}/contacts/v1/secondary-email/${encodeURIComponent(id)}/email/${encodeURIComponent(email)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
  return { id, email, action: 'additional_added' };
}

/**
 * Fold one contact into another. HubSpot keeps the primary's own field values
 * and pulls across everything the secondary has that the primary lacks —
 * including its email, which is the whole point here: the synthetic address
 * stops being owned by a second record.
 *
 * There is no undo in HubSpot. Callers must have said yes to this explicitly.
 */
export async function mergeContacts({ primaryId, mergeId },
  { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  if (!primaryId || !mergeId) throw new Error('mergeContacts needs both ids');
  if (String(primaryId) === String(mergeId)) throw new Error('Refusing to merge a contact into itself');
  const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/merge`, token,
    { primaryObjectId: String(primaryId), objectIdToMerge: String(mergeId) });
  const j = await res.json();
  return { id: j.id || primaryId, merged: String(mergeId) };
}

/** Does the portal actually have the properties Magellan writes? */
export async function checkMagellanProperties({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const missing = [];
  for (const name of [MEMBER_ID_PROP, CONNECTIONS_PROP]) {
    const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) missing.push(name);
    else if (!res.ok) throw new Error(`HubSpot ${res.status} checking ${name}`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The values `linkedin_1st_connections` will accept. It is an enumeration
 * (checkbox) with one option per Ortus account email, so an account whose name
 * is not on this list cannot be written at all — HubSpot rejects the value.
 * Worth knowing BEFORE an import rather than after.
 *
 * @returns {Promise<Set<string>>} lowercased option values
 */
export async function connectionsProp({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(CONNECTIONS_PROP)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} reading ${CONNECTIONS_PROP}`);
  const j = await res.json();
  return { options: j.options || [] };
}

export async function connectionsPropOptions({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  const { options } = await connectionsProp({ fetchImpl, token });
  return new Set(options.map((o) => String(o.value || '').trim().toLowerCase()));
}

/**
 * Append addresses to the property's option list.
 *
 * The PATCH replaces the entire array, so: read fresh, append only, send, then
 * read back and prove it landed. The final read is what makes this safe for two
 * operators pressing at the same moment — whoever writes second read first.
 */
export async function addConnectionsOptions(values, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const before = (await connectionsProp({ fetchImpl, token })).options;
  const { options, added } = mergeOptions(before, values);
  if (!added.length) return { added: [], total: before.length };

  const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(CONNECTIONS_PROP)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options }),
  });
  if (!res.ok) {
    const detail = typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`HubSpot ${res.status} updating ${CONNECTIONS_PROP}: ${detail}`);
  }

  const after = (await connectionsProp({ fetchImpl, token })).options;
  const check = verifyReadBack(before, after, added);
  if (!check.ok) {
    throw new Error(`HubSpot accepted the update but it did not take — missing: ${check.missing.join(', ') || 'count mismatch'}`);
  }
  return { added, total: after.length };
}

/**
 * Which scopes this token carries. The OAuth v1 endpoints 404 for private-app
 * tokens; oauth/v2/private-apps is the one that answers. Never throws — an
 * unknown scope list must not take the whole accounts card down with it.
 */
export async function tokenScopes({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) return [];
  try {
    const res = await fetchImpl(`${BASE}/oauth/v2/private-apps/get/access-token-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenKey: token }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.scopes) ? j.scopes : [];
  } catch {
    return [];
  }
}
