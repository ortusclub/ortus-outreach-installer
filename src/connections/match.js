import { normalizeSlug } from './slug.js';

const ts = (v) => Number(v) || Date.parse(v) || 0;

// Lead-status values that mean do-not-contact. Confirm against HubSpot during Task 3 Step 1.
const DNC_LEAD_STATUSES = new Set(['UNSUBSCRIBED', 'DNC']);

export function isDnc(c) {
  if (DNC_LEAD_STATUSES.has((c.hs_lead_status || '').toUpperCase())) return true;
  // TODO(confirm prop name): the "Priority = DNC" custom field, once known, check here.
  return false;
}

export function matchesCriteria(c, { countries = [], regions = [], cities = [], jobTitles = [], companies = [], geo = [] } = {}) {
  const eqAny = (v, list) => !list.length || list.some((x) => (v || '').toLowerCase() === x.toLowerCase());
  const hasAny = (v, list) => !list.length || list.some((x) => (v || '').toLowerCase().includes(x.toLowerCase()));
  // `geo` is a single level-free "any place" field: a term matches if it equals
  // the contact's country, region/state, OR city — so the operator never has to
  // know which level HubSpot stored it at. ANDed with the rest like every field.
  const geoOk = !geo.length || geo.some((g) => {
    const t = (g || '').toLowerCase();
    return (c.country || '').toLowerCase() === t
      || (c.state || '').toLowerCase() === t
      || (c.city || '').toLowerCase() === t;
  });
  return geoOk && eqAny(c.country, countries) && eqAny(c.state, regions) && eqAny(c.city, cities)
    && hasAny(c.jobtitle, jobTitles) && hasAny(c.company, companies);
}

// Keep the earlier of two "Connected On" dates (when the colleague first connected).
// Unparseable dates lose to any parseable one; otherwise keep whatever we have.
function earlierConn(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const da = Date.parse(a), db = Date.parse(b);
  if (Number.isNaN(da)) return b;
  if (Number.isNaN(db)) return a;
  return da <= db ? a : b;
}

// Join HubSpot contacts to the colleague index. DNC contacts are NOT dropped here
// — they're carried with `dnc: true` so the UI can show them greyed/unselectable
// and count them as "excluded"; the search/export layer is responsible for keeping
// them out of results and the exported lead list. warmDetails carries the
// per-colleague Connected-On date (for the "1st-degree · Jul 2024" line).
export function annotate(contacts, index) {
  const byKey = new Map();
  for (const c of contacts) {
    const slug = normalizeSlug(c.linkedinbio);
    const key = slug || (c.linkedin_membership_id ? `mid:${c.linkedin_membership_id}` : `id:${c.id}`);
    const conns = slug && index.has(slug) ? index.get(slug) : []; // [{ colleague, connectedOn }]
    if (!byKey.has(key)) byKey.set(key, { contact: c, slug, warm: new Map() });
    const e = byKey.get(key);
    for (const x of conns) {
      e.warm.set(x.colleague, earlierConn(e.warm.get(x.colleague), x.connectedOn || ''));
    }
    if (ts(c.lastmodifieddate) > ts(e.contact.lastmodifieddate)) e.contact = c;
  }
  return [...byKey.values()].map((v) => {
    const warmVia = [...v.warm.keys()];
    return {
      contact: v.contact,
      slug: v.slug,
      warmVia,
      warmDetails: warmVia.map((col) => ({ colleague: col, connectedOn: v.warm.get(col) || '' })),
      hasWarm: warmVia.length > 0,
      dnc: isDnc(v.contact),
    };
  });
}
