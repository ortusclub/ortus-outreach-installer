// Local blocklist — companies, email/URL domains, AND individual people the app
// must never cold-contact (or scrape). Stored per-machine in data/blocklist.json.
// Company/domain: spec 2026-07-07. Person (by LinkedIn profile URL): 2026-08.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

export const BLOCKLIST_FILE = dataPath('blocklist.json');

// A LinkedIn *person* URL — public (/in/, /pub/) or Sales Nav (/sales/lead/,
// /sales/people/, /lead/, /people/). Detected BEFORE the domain/company guess:
// a profile URL has a dot and no space and would otherwise be mis-filed as a
// 'domain' (which matches by email suffix and would never catch the person).
const PERSON_URL_RE = /linkedin\.com\/(?:in|pub|sales\/lead|sales\/people|lead|people)\//i;
const PERSON_ID_RE = /linkedin\.com\/(?:in|pub|sales\/lead|sales\/people|lead|people)\/([^/?#,]+)/i;
// Member-URN tokens (base64url) look like ACwAAA… — the stable key the scraper
// writes to the sheet as linkedin.com/in/<urn>. Anything else in that slot is a
// vanity slug. URNs are case-SENSITIVE base64url — never lower-case them.
const URN_RE = /^AC[a-zA-Z0-9_-]{6,}$/;

/** True when `value` looks like a LinkedIn profile URL (person, not company). */
export function isPersonUrl(value) {
  return PERSON_URL_RE.test(String(value || ''));
}

/**
 * Pull the stable identity out of a LinkedIn person URL:
 *   { urn }  — a member URN: matches scraped profiles + sheet rows the scraper
 *              wrote (both keyed by memberUrn). Case-preserved.
 *   { slug } — a vanity slug, lower-cased: matches manually-added vanity URLs.
 * Returns {} when the value isn't a parseable person URL. A given URL yields
 * exactly one of urn/slug — the two key-spaces don't cross (you can't derive a
 * vanity slug from a URN or vice-versa without visiting the profile).
 */
export function parsePersonUrl(value) {
  const m = String(value || '').match(PERSON_ID_RE);
  if (!m) return {};
  let id;
  try { id = decodeURIComponent(m[1]).trim(); } catch { id = String(m[1]).trim(); }
  if (!id) return {};
  if (URN_RE.test(id)) return { urn: id };
  return { slug: id.toLowerCase() };
}

export function inferKind(value) {
  const v = String(value || '').trim();
  if (isPersonUrl(v)) return 'person';
  return v.includes('.') && !v.includes(' ') ? 'domain' : 'company';
}

export function readBlocklist() {
  try {
    const raw = fs.readFileSync(BLOCKLIST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeBlocklist(entries) {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  const tmp = BLOCKLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  fs.renameSync(tmp, BLOCKLIST_FILE);
}

// Canonical display/dedup value. People collapse to linkedin.com/in/<id> so the
// SAME profile pasted in vanity vs Sales-Nav form (or with tracking params)
// dedupes to one entry. Companies/domains are stored verbatim.
function canonicalValue(value, kind, parsed) {
  if (kind !== 'person') return value;
  const id = parsed.urn || parsed.slug;
  return id ? `linkedin.com/in/${id}` : value;
}

export function addEntry({ value, reason = '', addedBy = '' }) {
  const v = String(value || '').trim();
  if (!v) throw new Error('blocklist: value required');
  const kind = inferKind(v);
  const parsed = kind === 'person' ? parsePersonUrl(v) : {};
  const canonical = canonicalValue(v, kind, parsed);
  const entries = readBlocklist();
  const existing = entries.find((e) => e.value.toLowerCase() === canonical.toLowerCase());
  if (existing) return existing;
  const entry = { value: canonical, kind, reason, addedBy, addedAt: new Date().toISOString() };
  // Persist the matched identity so the linter + scraper filter don't have to
  // re-parse on every lead. urn → scrape-time + send-out match; slug → send-out
  // only (a search result carries no vanity slug).
  if (kind === 'person') {
    if (parsed.urn) entry.urn = parsed.urn;
    if (parsed.slug) entry.slug = parsed.slug;
  }
  entries.push(entry);
  writeBlocklist(entries);
  return entry;
}

export function removeEntry(value) {
  const v = String(value || '').trim().toLowerCase();
  const entries = readBlocklist();
  const next = entries.filter((e) => e.value.toLowerCase() !== v);
  if (next.length === entries.length) return false;
  writeBlocklist(next);
  return true;
}
