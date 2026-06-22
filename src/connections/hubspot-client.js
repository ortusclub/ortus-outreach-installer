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
