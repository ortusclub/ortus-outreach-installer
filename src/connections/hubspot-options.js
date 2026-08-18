// Pure helpers for editing the linkedin_1st_connections option list.
//
// The property PATCH replaces the ENTIRE options array — adding one option
// means sending all 1030 back. A short or reordered array does not corrupt one
// contact, it detaches the property's values across a 12.2M-contact portal.
// So the merge appends only, and refuses to produce anything else.

export function normaliseValue(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * @param {Array<{label:string,value:string,displayOrder:number,hidden:boolean}>} existing
 * @param {string[]} values
 * @returns {{options: Array, added: string[]}}
 */
export function mergeOptions(existing, values) {
  const base = Array.isArray(existing) ? existing : [];
  const have = new Set(base.map((o) => normaliseValue(o.value)));
  const options = base.slice();
  const added = [];

  for (const raw of Array.isArray(values) ? values : []) {
    const v = normaliseValue(raw);
    if (!v || have.has(v)) continue;
    have.add(v);
    added.push(v);
    options.push({ label: v, value: v, displayOrder: options.length, hidden: false });
  }

  // The guard. Cheap, and the only thing standing between a bug here and a
  // portal-wide data loss.
  if (options.length < base.length) {
    throw new Error('refusing to PATCH: merged option list is shorter than the current one');
  }
  const out = new Set(options.map((o) => normaliseValue(o.value)));
  const dropped = base.map((o) => normaliseValue(o.value)).filter((v) => !out.has(v));
  if (dropped.length) {
    throw new Error(`refusing to PATCH: would drop ${dropped.length} existing option(s)`);
  }

  return { options, added };
}

/**
 * Did the write actually land? A 200 is not evidence.
 */
export function verifyReadBack(before, after, added) {
  const have = new Set((after || []).map((o) => normaliseValue(o.value)));
  const missing = (added || []).map(normaliseValue).filter((v) => !have.has(v));
  const ok = missing.length === 0
    && (after || []).length === (before || []).length + (added || []).length;
  return { ok, missing };
}
