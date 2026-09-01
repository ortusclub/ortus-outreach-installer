/**
 * Sales Nav Scraper engine client.
 *
 * The Ortus app is the CONTROL PANEL; the actual Sales Navigator scraping runs
 * on the GKE "engine" (the salesnav-cloud-scraper service). This module is a
 * thin HTTP client to that engine's API — it launches NO browser locally and
 * deliberately bypasses the local campaign/performOutreach path. The
 * "Sales Nav Scrape" campaign type dispatches here.
 *
 * Engine endpoint + auth come from env (set in the bundled .env at build time):
 *   SCRAPER_ENGINE_URL    e.g. https://scraper.ortusclub.com
 *   SCRAPER_ENGINE_TOKEN  bearer token for the engine's auth (optional)
 *
 * Like sheets-writer.js, calls NEVER throw — they resolve to a parsed result or
 * an { error } object so the dashboard can surface "engine not wired up yet" or
 * a transient failure without crashing the campaign flow.
 */

import { withWriteRetry } from './sheets-writer.js';
import { SCRAPER_ENGINE_URL, SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';
import { getOperatorId } from './operator-id.js';

// Cloud engine is the centralized default (scraper-engine-url.js); a local
// SCRAPER_ENGINE_URL / SCRAPER_ENGINE_TOKEN env var overrides it for dev.
const engineUrl = () => (process.env.SCRAPER_ENGINE_URL || SCRAPER_ENGINE_URL).replace(/\/+$/, '');
const engineToken = () => process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN;

// Scrape control calls are quick; the engine does the long-running work async
// and we poll /api/jobs for progress. 20s is generous for a control round-trip.
const REQUEST_TIMEOUT_MS = 20000;

/** True when SCRAPER_ENGINE_URL is configured, so the UI can gate the mode. */
export function isScraperConfigured() {
  return !!engineUrl();
}

// Pure: pull Sales Nav SEARCH URLs out of parsed sheet rows (the shape fetchSheet
// returns). Lets the operator feed input URLs from a Google Sheet instead of
// pasting them — the app extracts them here and dispatches the SAME `searchUrls`
// to the engine, so the engine contract is unchanged. Scans every cell, keeps
// only Sales Nav search URLs, trims, dedupes, preserves first-seen order.
const SALES_NAV_SEARCH_RE = /linkedin\.com\/sales\/search\//i;
export function extractSalesNavUrls(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const value of Object.values(row)) {
      const v = (value == null ? '' : String(value)).trim();
      if (!v || !SALES_NAV_SEARCH_RE.test(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Row-aware variant: pull the first Sales Nav search URL out of each sheet row,
 * tagged with the 1-based sheet row number (the shape fetchSheetWithRows
 * returns). Powers the "scrape rows 2–10" picker — the operator chooses which
 * sheet rows run, so we keep ONE entry per row (no cross-row dedupe) and
 * preserve the sheet's row numbers exactly. Rows with no Sales Nav URL are
 * skipped.
 * @param {{ rowNumber: number, row: Record<string, string> }[]} rowsWithNumbers
 * @returns {{ row: number, url: string }[]}
 */
export function extractSalesNavUrlsWithRows(rowsWithNumbers) {
  if (!Array.isArray(rowsWithNumbers)) return [];
  const out = [];
  for (const entry of rowsWithNumbers) {
    if (!entry || typeof entry !== 'object' || !entry.row) continue;
    for (const value of Object.values(entry.row)) {
      const v = (value == null ? '' : String(value)).trim();
      if (!v || !SALES_NAV_SEARCH_RE.test(v)) continue;
      out.push({ row: entry.rowNumber, url: v });
      break; // one search per sheet row
    }
  }
  return out;
}

/** The engine base URL — exposed for the UI / health payload. */
export function getEngineUrl() {
  return engineUrl();
}

/**
 * Open the live MJPEG screencast stream for ONE running job (the per-job "View"
 * button). The engine streams multipart/x-mixed-replace; this resolves to
 * { ok: true, contentType, body, abort } where `body` is the web ReadableStream
 * to pipe straight through to the browser, and `abort()` tears down the upstream
 * connection. On failure resolves to { ok: false, status, error } — never throws.
 *
 * NOTE: no request timeout — this is a long-lived stream; the caller aborts when
 * the viewer closes (see /api/scrape/view/:jobId in server.js).
 */
export async function openJobViewStream(jobId) {
  const base = engineUrl();
  if (!base) return { ok: false, status: 503, error: 'Scraper engine not configured' };
  const controller = new AbortController();
  try {
    const headers = {};
    const token = engineToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}/api/scrape/view/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      controller.abort();
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      contentType: res.headers.get('content-type') || 'multipart/x-mixed-replace',
      body: res.body,
      abort: () => { try { controller.abort(); } catch { /* */ } },
    };
  } catch (err) {
    controller.abort();
    return { ok: false, status: 502, error: err.message };
  }
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = engineToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * One request attempt to the engine. Returns parsed JSON or an { error } object;
 * never throws. HTTP 5xx/429 map to a transient-looking error so withWriteRetry
 * retries them; 4xx are returned as-is (retrying won't help).
 */
async function requestOnce(method, path, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = engineUrl();
  if (!base) {
    return { error: 'Scraper engine not configured (set SCRAPER_ENGINE_URL)' };
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      // Embed the status code in the message so withWriteRetry's transient
      // detection (which matches \b(429|500|502|503|504)\b) fires on 5xx/429
      // but not on 4xx.
      const detail = parsed && parsed.error ? `: ${parsed.error}` : '';
      return { error: `HTTP ${res.status}${detail}`, status: res.status };
    }
    return parsed;
  } catch (err) {
    return { error: err.message };
  }
}

// Retry wrapper for IDEMPOTENT calls (status reads, pause/resume/stop). NOT used
// for startScrape — see below.
function requestWithRetry(method, path, body) {
  return withWriteRetry(() => requestOnce(method, path, body), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    log: (m) => console.warn(`[scraper-client] ${m}`),
  });
}

/**
 * Start a Sales Nav scrape on the engine.
 *
 * Single attempt (NO retry): starting a scrape is not idempotent — a retried
 * POST after a transient blip could enqueue a duplicate job. The operator can
 * re-click Start if the one attempt fails.
 *
 * @param {object}   opts
 * @param {string|string[]} opts.searchUrls  one Sales Nav URL, or many for a batch
 * @param {string}   opts.sheetUrl           destination Google Sheet
 * @param {string}   opts.profileId          GoLogin profile (must have a Sales Nav seat)
 * @param {string}   [opts.tabName]          destination tab (single scrape only)
 * @param {boolean}  [opts.slowMode]         larger inter-page delays
 */
export function startScrape({ searchUrls, sheetUrl, profileId, tabName, slowMode = false, ownerEmail = '', campaignName = '', excludeUrns = [], excludeCompanies = [], accountName = '' } = {}) {
  const urls = (Array.isArray(searchUrls) ? searchUrls : [searchUrls])
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);

  if (!urls.length) return Promise.resolve({ error: 'searchUrls required' });
  if (!sheetUrl) return Promise.resolve({ error: 'sheetUrl required' });
  if (!profileId) return Promise.resolve({ error: 'profileId required' });

  // Tag every job with this install's operator id so the engine can scope the
  // jobs/logs views to just this operator (the engine is shared across the team).
  const userId = getOperatorId();

  // Blocklisted people (member URNs) the engine must skip mid-scrape — never
  // written to the sheet. Best-effort: an older engine ignores the field and
  // the exclusion still applies at send-out (pre-flight) on this side.
  const excludeUrnList = (Array.isArray(excludeUrns) ? excludeUrns : [])
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);
  // Blocklisted company NAMES, matched against each result's company field by
  // the engine using the same whole-word rule pre-flight uses on the sheet.
  const excludeCompanyList = (Array.isArray(excludeCompanies) ? excludeCompanies : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  // ownerEmail + campaignName ride along so the SHARED board can label each
  // job's owner/campaign on every operator's screen. Best-effort — if the
  // engine drops unknown fields, the board falls back to userId + tab name.
  // accountName = the GoLogin profile's human name, so an account-level engine
  // error (logged out / no Sales Nav seat) can say WHICH account, not a hash.
  if (urls.length === 1) {
    return requestOnce('POST', '/api/scrape/single', {
      searchUrl: urls[0],
      sheetUrl,
      tabName: tabName || 'Results',
      profileId,
      slowMode,
      userId,
      ownerEmail,
      campaignName,
      excludeUrns: excludeUrnList,
      excludeCompanies: excludeCompanyList,
      accountName,
    });
  }
  return requestOnce('POST', '/api/scrape/batch', {
    searchUrls: urls,
    sheetUrl,
    profileId,
    slowMode,
    userId,
    ownerEmail,
    campaignName,
    excludeUrns: excludeUrnList,
    excludeCompanies: excludeCompanyList,
    accountName,
  });
}

/** ALL operators' jobs (unscoped) — powers the SHARED board. The engine tags
 *  each job with its own userId; we group by that. Retried like getJobs. */
export function getAllJobs() {
  return requestWithRetry('GET', '/api/jobs');
}

/** Board-poll variant of getAllJobs: SINGLE attempt, SHORT timeout. The Sales Nav
 *  Scraper board re-polls every 2.5s, so a failed poll doesn't matter — the next
 *  one IS the retry. The retried getAllJobs (3 attempts x 20s) instead piled up to
 *  ~60s per poll and surfaced a raw "aborted due to timeout" while the engine was
 *  busy. 10s single-shot keeps the board responsive under load. */
export function getAllJobsFast() {
  // 25s (not the usual 20s or a tight 10s): the engine's /api/jobs currently
  // returns the FULL job history for all operators — ~10MB / ~9s on a busy engine
  // — so a short timeout spuriously fails the board's poll. Still single-attempt
  // (the 2.5s board poll is its own retry). The real fix is slimming /api/jobs
  // engine-side to a lightweight board projection.
  return requestOnce('GET', '/api/jobs', undefined, { timeoutMs: 25000 });
}

/** Pause the running scrape for a profile. Idempotent → retried. */
export function pauseScrape(profileId) {
  return requestWithRetry('POST', '/api/scrape/pause', { profileId });
}

/** Resume a paused scrape for a profile. Idempotent → retried. */
export function resumeScrape(profileId) {
  return requestWithRetry('POST', '/api/scrape/resume', { profileId });
}

/** Stop (and clear queued) scrapes for a profile. Idempotent → retried. */
export function stopScrape(profileId) {
  return requestWithRetry('POST', '/api/scrape/stop', { profileId });
}

/** This operator's jobs (queued/running/done) with page/profile progress counters. */
export function getJobs() {
  return requestWithRetry('GET', `/api/jobs?userId=${encodeURIComponent(getOperatorId())}`);
}

/** This operator's recent engine activity log lines. `since` (ms epoch) fetches only newer. */
export function getLogs(since) {
  const params = new URLSearchParams({ userId: getOperatorId() });
  if (since) params.set('since', since);
  return requestWithRetry('GET', `/api/logs?${params.toString()}`);
}

/**
 * Stored log history for ONE launch (runId), merged across its jobs.
 *
 * getLogs() above reads the engine's LIVE buffer, which only holds current
 * activity — so a scrape's log went blank the moment it finished. This endpoint
 * is the engine's persisted per-run history and survives completion. runId is
 * echoed on every job in /api/jobs. Single attempt: the board renders without
 * logs perfectly well, so this must never hold up a strip.
 */
export function getRunLogs(runId) {
  if (!runId) return Promise.resolve({ logs: [] });
  return requestOnce('GET', `/api/scrape/runs/${encodeURIComponent(runId)}/logs`, undefined, { timeoutMs: 12000 });
}

/** Engine health probe — single attempt, used to show connectivity in the UI. */
export function engineHealth() {
  return requestOnce('GET', '/api/health');
}
