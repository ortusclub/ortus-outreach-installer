'use strict';

// Normalize a LinkedIn profile URL to its bare vanity slug, lowercased.
// Returns null when there is no /in/<slug> segment (e.g. /sales/people/…, blank, redacted).
export function normalizeSlug(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.trim().match(/\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
  return slug.toLowerCase();
}
