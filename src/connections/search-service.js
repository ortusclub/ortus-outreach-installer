// In-app Connections search, backed by the local HubSpot cache.
// Loads the slug→colleague index (from the CSV folder) and the cached HubSpot contacts
// (data/connections-cache.json), joins them via the tested annotate(), and filters with
// matchesCriteria(). All loads are memoized and auto-reload when their source file's
// mtime changes — so the UI picks up a freshly-built cache without a server restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFolder } from './csv-ingest.js';
import { annotate, matchesCriteria } from './match.js';
import { writeLeadCsv, leadRow, HEADER } from './export.js';
import { FG_HEADER, fgRow, inviteKey } from './fg-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
const DEFAULT_DIR = path.join(REPO, 'data/connections');
const DEFAULT_CACHE = path.join(REPO, 'data/connections-cache.json');
const COLLEAGUES_PATH = path.join(__dirname, 'colleagues.json');
const OUT_DIR = path.join(REPO, 'out');

const mtimeKey = (p) => { try { return `${p}:${fs.statSync(p).mtimeMs}`; } catch { return `${p}:none`; } };

let _idx = null, _idxKey = null;
function getIndex(dir = DEFAULT_DIR) {
  const key = mtimeKey(dir);
  if (_idx && _idxKey === key) return _idx;
  _idx = ingestFolder(dir); _idxKey = key; // { index, stats }
  return _idx;
}

let _cache = null, _cacheKey = null;
function getCache(cachePath = DEFAULT_CACHE) {
  const key = mtimeKey(cachePath);
  if (_cache && _cacheKey === key) return _cache;
  if (key.endsWith(':none')) { _cache = { contacts: [], meta: null }; _cacheKey = key; return _cache; }
  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  _cache = {
    contacts: raw.contacts || [],
    meta: { builtAt: raw.builtAt, slugsProcessed: raw.slugsProcessed || 0, totalSlugs: raw.totalSlugs || 0 },
  };
  _cacheKey = key;
  return _cache;
}

let _colleagues = null, _colleaguesKey = null;
function getColleagues() {
  const key = mtimeKey(COLLEAGUES_PATH);
  if (_colleagues && _colleaguesKey === key) return _colleagues;
  try { _colleagues = JSON.parse(fs.readFileSync(COLLEAGUES_PATH, 'utf8')); } catch { _colleagues = {}; }
  _colleaguesKey = key;
  return _colleagues;
}

// annotate() over the whole cache is O(contacts); memoize it so repeated searches with
// different criteria don't re-run the join.
let _annot = null, _annotKey = null;
function getAnnotated(dir, cachePath) {
  const idx = getIndex(dir);
  const cache = getCache(cachePath);
  const key = `${_idxKey}|${_cacheKey}`;
  if (_annot && _annotKey === key) return _annot;
  _annot = annotate(cache.contacts, idx.index); _annotKey = key;
  return _annot;
}

const normCriteria = (c = {}) => ({
  countries: c.countries || [], regions: c.regions || [], cities: c.cities || [],
  jobTitles: c.jobTitles || [], companies: c.companies || [], geo: c.geo || [],
});

function toRow(r, colleagues) {
  const c = r.contact;
  const primaryEmail = r.warmVia[0];
  const meta = primaryEmail ? (colleagues[primaryEmail] || {}) : {};
  return {
    id: c.id,
    firstName: c.firstname || '',
    lastName: c.lastname || '',
    url: c.linkedinbio || '',
    linkedinId: c.linkedin_membership_id || '',
    company: c.company || '',
    jobTitle: c.jobtitle || '',
    country: c.country || '',
    region: c.state || '',
    city: c.city || '',
    warmVia: r.warmVia.map((e) => colleagues[e]?.name || e),
    warmDetails: (r.warmDetails || []).map((d) => ({
      name: colleagues[d.colleague]?.name || d.colleague,
      connectedOn: d.connectedOn || '',
    })),
    primaryName: meta.name || primaryEmail || '',
    primaryUrl: meta.linkedinUrl || '',
    hasWarm: r.hasWarm,
    dnc: !!r.dnc,
  };
}

// Operator roster for the Follower Growth picker: [{ email, name }] from
// colleagues.json. The email is the exact key warmVia scoping matches on.
// Operators for the Follower Growth picker = everyone whose 1st-degree network
// has actually been ingested (one <email>.csv per colleague in data/connections),
// UNIONed with colleagues.json. We key on the INGESTED networks — not the small
// hand-maintained colleagues.json — so every synced network is selectable, not
// just the couple with a curated display name. colleagues.json only supplies a
// nicer name when present; otherwise we humanize the email local-part.
export function listOperators({ dir } = {}) {
  const colleagues = getColleagues();
  let ingested = [];
  try { ingested = Object.keys(getIndex(dir).stats.perColleague || {}); } catch { ingested = []; }
  const emails = new Set([...ingested, ...Object.keys(colleagues)]);
  const displayName = (email) => {
    const m = colleagues[email];
    if (m && m.name) return m.name;
    const local = String(email).split('@')[0].replace(/[._-]+/g, ' ').trim();
    return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : email;
  };
  return [...emails]
    .map((email) => ({ email, name: displayName(email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getConnectionsStats({ dir, cachePath } = {}) {
  const { stats } = getIndex(dir);
  const { meta, contacts } = getCache(cachePath);
  return {
    networks: stats.files,
    rows: stats.rows,
    withUrl: stats.withUrl,
    uniqueSlugs: stats.uniqueSlugs,
    colleagues: Object.keys(stats.perColleague || {}).length,
    cache: meta
      ? {
          built: true,
          builtAt: meta.builtAt,
          contacts: contacts.length,
          slugsProcessed: meta.slugsProcessed,
          totalSlugs: meta.totalSlugs,
          complete: meta.slugsProcessed >= meta.totalSlugs && meta.totalSlugs > 0,
        }
      : { built: false },
  };
}

export function searchConnections(criteria = {}, { dir, cachePath, limit = 1000 } = {}) {
  const annotated = getAnnotated(dir, cachePath);
  const colleagues = getColleagues();
  const norm = normCriteria(criteria);
  const matched = annotated.filter((r) => matchesCriteria(r.contact, norm));
  // DNC / unsubscribed never go on the list — surface them separately so the UI can
  // show them greyed and count them, but keep them out of `results` and exports.
  const live = matched.filter((r) => !r.dnc);
  const dnc = matched.filter((r) => r.dnc);
  live.sort(
    (a, b) => Number(b.hasWarm) - Number(a.hasWarm) || (a.contact.company || '').localeCompare(b.contact.company || ''),
  );
  return {
    count: live.length,
    warmCount: live.filter((r) => r.hasWarm).length,
    dncExcluded: dnc.length,
    totalInHubSpot: annotated.length,
    results: live.slice(0, limit).map((r) => toRow(r, colleagues)),
    dncResults: dnc.slice(0, 100).map((r) => toRow(r, colleagues)),
  };
}

export function exportConnections(criteria = {}, { dir, cachePath, urls } = {}) {
  const annotated = getAnnotated(dir, cachePath);
  const colleagues = getColleagues();
  const norm = normCriteria(criteria);
  // Never export DNC / unsubscribed contacts.
  let filtered = annotated.filter((r) => matchesCriteria(r.contact, norm) && !r.dnc);
  if (Array.isArray(urls) && urls.length) {
    const set = new Set(urls);
    filtered = filtered.filter((r) => set.has(r.contact.linkedinbio));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `warm-reach-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  writeLeadCsv(filtered, outPath, colleagues);
  return { path: outPath, count: filtered.length, csv: fs.readFileSync(outPath, 'utf8') };
}

// Lead rows (header + rectangular string rows) for the "Build & attach a warm
// list" flow — same schema/selection as exportConnections, written to a new
// Google Sheet via the Apps Script createLeadTab action. DNC excluded.
export function buildLeadRows(criteria = {}, { dir, cachePath, urls } = {}) {
  const annotated = getAnnotated(dir, cachePath);
  const colleagues = getColleagues();
  const norm = normCriteria(criteria);
  let filtered = annotated.filter((r) => matchesCriteria(r.contact, norm) && !r.dnc);
  if (Array.isArray(urls) && urls.length) {
    const set = new Set(urls);
    filtered = filtered.filter((r) => set.has(r.contact.linkedinbio));
  }
  return { header: HEADER, rows: filtered.map((r) => leadRow(r, colleagues)), count: filtered.length };
}

// Per-operator Follower Growth invite list from the Connections DB. Scoped to
// one operator's OWN network (warmVia includes `operator`), filtered by
// matchesCriteria (the function/title chips live in jobTitles), DNC excluded,
// deduped against already-invited keys (Member ID or URL), and capped at the
// remaining monthly budget. Returns FG_HEADER + rectangular string rows + counts.
export function buildFgTargets(criteria = {}, { operator, operatorName, account, month, alreadyInvited = [], budget = Infinity, dir, cachePath } = {}) {
  const annotated = getAnnotated(dir, cachePath);
  const colleagues = getColleagues();
  const norm = normCriteria(criteria);
  const invitedKeys = new Set((alreadyInvited || []).map(String));
  const keywords = norm.jobTitles;
  const eligible = annotated.filter((r) =>
    !r.dnc
    && r.warmVia.includes(operator)
    && matchesCriteria(r.contact, norm)
    && !invitedKeys.has(inviteKey(r.contact)),
  );
  eligible.sort((a, b) => (a.contact.company || '').localeCompare(b.contact.company || ''));
  const capped = Number.isFinite(budget) ? eligible.slice(0, Math.max(0, budget)) : eligible;
  const opName = operatorName || colleagues[operator]?.name || operator || '';
  const rows = capped.map((r) => fgRow(r, colleagues, { operatorName: opName, account, month, keywords }));
  return { header: FG_HEADER, rows, count: rows.length, eligible: eligible.length };
}

// Test seam: when set, listFgColleagues uses these instead of the real DB.
let _fgColleaguesFixtures = null;
export function __setFgColleaguesFixtures(f) { _fgColleaguesFixtures = f; }

// Distinct warm-via owners (the Ortus colleagues whose networks are in the DB)
// with their non-DNC connection counts — the employee roster for Team Launch.
export function listFgColleagues({ dir, cachePath } = {}) {
  const annotated = _fgColleaguesFixtures ? _fgColleaguesFixtures.annotated : getAnnotated(dir, cachePath);
  const colleagues = _fgColleaguesFixtures ? _fgColleaguesFixtures.colleagues : getColleagues();
  const counts = new Map();
  for (const r of annotated) {
    if (r.dnc) continue;
    for (const email of (r.warmVia || [])) counts.set(email, (counts.get(email) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([email, connCount]) => ({ email, name: colleagues[email]?.name || email, connCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
