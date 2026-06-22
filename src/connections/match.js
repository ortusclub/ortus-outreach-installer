import { normalizeSlug } from './slug.js';

// Lead-status values that mean do-not-contact. Confirm against HubSpot during Task 3 Step 1.
const DNC_LEAD_STATUSES = new Set(['UNSUBSCRIBED', 'DNC']);

export function isDnc(c) {
  if (DNC_LEAD_STATUSES.has((c.hs_lead_status || '').toUpperCase())) return true;
  // TODO(confirm prop name): the "Priority = DNC" custom field, once known, check here.
  return false;
}

export function annotate(contacts, index) {
  const byKey = new Map();
  for (const c of contacts) {
    if (isDnc(c)) continue;
    const slug = normalizeSlug(c.linkedinbio);
    const key = slug || (c.linkedin_membership_id ? `mid:${c.linkedin_membership_id}` : `id:${c.id}`);
    const warm = slug && index.has(slug) ? index.get(slug).map(x => x.colleague) : [];
    if (!byKey.has(key)) byKey.set(key, { contact: c, slug, warmVia: new Set(warm) });
    else {
      const e = byKey.get(key);
      warm.forEach(w => e.warmVia.add(w));
      if ((c.lastmodifieddate || '') > (e.contact.lastmodifieddate || '')) e.contact = c;
    }
  }
  return [...byKey.values()].map(v => ({
    contact: v.contact, slug: v.slug, warmVia: [...v.warmVia], hasWarm: v.warmVia.size > 0,
  }));
}
