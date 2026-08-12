// Operation Magellan — the collect half. Reads an Ortus account's connections
// straight off LinkedIn and writes them to data/connections/<email>.csv, the
// same file the Drive sync produces and csv-ingest already reads. So collecting
// an account also refreshes the warm-reach database: one pipeline, two uses.
//
// Why live instead of the downloadable archive: the archive has no LinkedIn
// member id, which is the only key HubSpot can dedupe on — that gap is the
// entire reason the manual process needs LinkedHelper. The connections API
// returns profile URNs, so getRecentConnections' enrichment pass resolves
// member ids 25 per call instead of one profile visit each.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecentConnections } from '../linkedin/helpers.js';
import { parseCsv } from './csv-ingest.js';
import { normalizeSlug } from './slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
export const CONNECTIONS_DIR = path.join(REPO, 'data/connections');

// 40 rows a page. 500 pages is 20k connections — past any real Ortus account,
// and the walk stops early on the first short page anyway.
const MAX_PAGES = 500;

export const CSV_HEADER = ['First Name', 'Last Name', 'URL', 'Email Address',
  'Company', 'Position', 'Connected On', 'Member ID'];

const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** LinkedIn writes "15 Jun 2026"; match it so re-reads look native. */
export function formatConnectedOn(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Read whatever is already on disk for this account, keyed by slug. The archive
 * export carries Company and Position on ~95% of rows; the connections API
 * carries neither. Merging keeps that detail instead of blanking it on the
 * first live collection.
 */
export function readExistingBySlug(filePath) {
  const bySlug = new Map();
  if (!fs.existsSync(filePath)) return bySlug;
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const h = rows.findIndex((r) => r[0] && r[0].trim() === 'First Name');
  if (h === -1) return bySlug;
  const header = rows[h].map((x) => x.trim());
  const col = (name) => header.indexOf(name);
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const slug = normalizeSlug(r[col('URL')]);
    if (!slug) continue;
    bySlug.set(slug, {
      company: col('Company') >= 0 ? (r[col('Company')] || '').trim() : '',
      position: col('Position') >= 0 ? (r[col('Position')] || '').trim() : '',
      email: col('Email Address') >= 0 ? (r[col('Email Address')] || '').trim() : '',
      connectedOn: col('Connected On') >= 0 ? (r[col('Connected On')] || '').trim() : '',
      memberId: col('Member ID') >= 0 ? (r[col('Member ID')] || '').trim() : '',
    });
  }
  return bySlug;
}

/**
 * Merge a live pull with what's already on disk. Live wins on identity
 * (name, member id); disk wins on company/position, which only it has.
 */
export function mergeRows(live, existingBySlug) {
  return (live || []).map((c) => {
    const slug = c.publicId || '';
    const prev = (slug && existingBySlug.get(slug)) || {};
    return {
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      url: slug ? `https://www.linkedin.com/in/${slug}` : '',
      email: prev.email || '',
      company: prev.company || '',
      position: prev.position || '',
      connectedOn: formatConnectedOn(c.connectedAt) || prev.connectedOn || '',
      memberId: c.memberNumber || prev.memberId || '',
      slug,
    };
  });
}

export function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.firstName, r.lastName, r.url, r.email, r.company, r.position,
      r.connectedOn, r.memberId].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Atomic write — tmp + rename, per the repo convention. */
export function writeAccountCsv(account, rows, { dir = CONNECTIONS_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${account}.csv`);
  fs.writeFileSync(`${filePath}.tmp`, toCsv(rows));
  fs.renameSync(`${filePath}.tmp`, filePath);
  return filePath;
}

/**
 * Collect one account. `page` must be a live puppeteer page on that account's
 * session; the caller owns launching and closing it.
 *
 * @returns {{rows:Array, total:number, withUrl:number, withMemberId:number, hidden:number, file:string}}
 */
export async function collectAccount(page, account, { dir = CONNECTIONS_DIR, onProgress = null } = {}) {
  // Same navigation bulk-check uses (bulk-check-connections.js:650) — this is
  // the page LinkedIn's own UI hits, and it puts a fresh JSESSIONID in the page
  // context. We do NOT navigate to /login; LinkedIn redirects there itself when
  // the profile's session has expired.
  // Two attempts. bulk-check does one, but it gets another go on the next
  // sweep tick; Magellan visits an account once, so a cold Orbita that needs
  // 31 seconds to reach domcontentloaded would cost the whole account.
  let postNavUrl = '';
  let navErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      navErr = null;
      await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      postNavUrl = page.url() || '';
      break;
    } catch (err) {
      navErr = err;
    }
  }
  if (navErr) throw new Error(`navigation-failed: ${navErr.message}`);
  // Catch the redirect immediately. Without this we'd keep going and fail later
  // with a vague Voyager error, leaving the operator staring at a login page
  // with no idea why.
  if (/\/login|\/uas\/|\/checkpoint/.test(postNavUrl)) {
    throw new Error(`session-expired (redirected to ${postNavUrl})`);
  }

  // getRecentConnections walks every page inside a single page.evaluate(), so it
  // returns nothing until it is completely done. On a 7,000-connection account
  // that is minutes of apparent silence. It publishes a beacon after each page;
  // poll it so the card can show real movement.
  let poller = null;
  if (onProgress) {
    poller = setInterval(async () => {
      try {
        const p = await page.evaluate(() => window.__ortusConnProgress || null);
        if (p) onProgress({ count: p.count, pages: p.pages, total: p.total });
      } catch { /* page busy or navigating — just skip this tick */ }
    }, 1500);
  }

  let live;
  try {
    live = await getRecentConnections(page, 0, {
      maxPages: MAX_PAGES,
      // Second half of the read: resolving LinkedIn IDs, 25 people per call.
      // On a 6,000-connection account that is ~250 round-trips, so it needs a
      // beat of its own or the card freezes on the last page it walked.
      onEnrichProgress: onProgress
        ? ({ done, total }) => onProgress({ count: done, total, stage: 'ids' })
        : null,
    });
  } finally {
    if (poller) clearInterval(poller);
  }
  if (live.error) throw new Error(`Could not read connections: ${live.error}`);

  const filePath = path.join(dir, `${account}.csv`);
  const rows = mergeRows(live, readExistingBySlug(filePath));
  writeAccountCsv(account, rows, { dir });

  return {
    rows,
    // Set when the walk stopped early on a network failure. Everything before
    // it is real, so this is a warning on a success, not a failure.
    partial: live.partial || null,
    total: rows.length,
    withUrl: rows.filter((r) => r.url).length,
    withMemberId: rows.filter((r) => r.memberId).length,
    // Same category the UI calls "Hidden by LinkedIn" — no link, so unusable.
    hidden: rows.filter((r) => !r.url && !r.memberId).length,
    file: filePath,
  };
}

/**
 * What has already been collected, keyed by account email. Derived from the
 * files on disk rather than a separate ledger — the CSV is the fact, so the two
 * can never disagree. Drive-synced accounts show up here too, which is correct:
 * we have their connections, however they arrived.
 */
// Counting rows means CSV-parsing every file, and there are 455 of them holding
// 70MB — 1.4–2.0s of blocking work on a route the Magellan tab hits on every
// visit and every refresh. The parse result only changes when the file does, so
// key it on the file's own mtime and size. A collect rewrites the file, which
// moves both, so a stale count is not reachable. Unbounded on purpose: one
// small record per account, and the account list is the roster.
const _collectedCache = new Map();

export function listCollected({ dir = CONNECTIONS_DIR } = {}) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      const stamp = `${st.mtimeMs}:${st.size}`;
      const hit = _collectedCache.get(full);
      if (hit && hit.stamp === stamp) {
        out.set(f.replace(/\.csv$/i, ''), hit.value);
        continue;
      }
      const bySlug = readExistingBySlug(full);
      const value = {
        count: bySlug.size,
        withMemberId: [...bySlug.values()].filter((v) => v.memberId).length,
        at: st.mtime.toISOString(),
      };
      _collectedCache.set(full, { stamp, value });
      out.set(f.replace(/\.csv$/i, ''), value);
    } catch { /* unreadable file — treat as not collected */ }
  }
  return out;
}

/**
 * Read a collected account back as plan input for magellan.js.
 * Works for Drive-synced files too — they simply have no Member ID column,
 * and those rows come back unresolved for the push stage to skip.
 */
export function readForPlan(account, { dir = CONNECTIONS_DIR } = {}) {
  const filePath = path.join(dir, `${account}.csv`);
  const bySlug = readExistingBySlug(filePath);
  const out = [];
  for (const [slug, v] of bySlug) {
    out.push({
      slug,
      memberId: v.memberId || '',
      firstName: '',
      lastName: '',
      company: v.company,
      jobTitle: v.position,
    });
  }
  // Names live in the file too — re-read them positionally rather than
  // widening readExistingBySlug's shape for one caller.
  if (fs.existsSync(filePath)) {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    const h = rows.findIndex((r) => r[0] && r[0].trim() === 'First Name');
    if (h !== -1) {
      const header = rows[h].map((x) => x.trim());
      const iU = header.indexOf('URL');
      const iF = header.indexOf('First Name');
      const iL = header.indexOf('Last Name');
      const byS = new Map(out.map((o) => [o.slug, o]));
      for (let i = h + 1; i < rows.length; i++) {
        const slug = normalizeSlug(rows[i][iU]);
        const rec = slug && byS.get(slug);
        if (!rec) continue;
        rec.firstName = (rows[i][iF] || '').trim();
        rec.lastName = (rows[i][iL] || '').trim();
      }
    }
  }
  return out;
}
