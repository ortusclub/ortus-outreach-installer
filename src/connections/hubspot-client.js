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

import { CONNECTIONS_PROP, MEMBER_ID_PROP } from './magellan.js';

// What we need back to decide create-vs-update and whether a real email exists.
export const MAGELLAN_PROPS = ['firstname', 'lastname', 'company', 'jobtitle',
  'linkedinbio', 'email', 'hs_additional_emails', MEMBER_ID_PROP, CONNECTIONS_PROP];

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
export async function lookupByMemberIds(memberIds, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const out = new Map();
  const ids = [...new Set((memberIds || []).filter(Boolean).map(String))];
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
        if (mid) out.set(String(mid), { id: r.id, properties: r.properties || {} });
      }
      after = json.paging && json.paging.next && json.paging.next.after;
    } while (after);
  }
  return out;
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
  for (const batch of chunk(inputs)) {
    try {
      const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/batch/create`, token,
        { inputs: batch.map((b) => ({ properties: b.properties })) });
      const json = await res.json();
      created += (json.results || []).length;
    } catch (err) {
      errors.push({ size: batch.length, error: err.message });
    }
    onProgress?.({ created, errors: errors.length });
  }
  return { created, errors };
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
export async function connectionsPropOptions({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(CONNECTIONS_PROP)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} reading ${CONNECTIONS_PROP}`);
  const j = await res.json();
  return new Set((j.options || []).map((o) => String(o.value || '').trim().toLowerCase()));
}
