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

// Trailing slashes stripped so `${base}${path}` never doubles up.
const engineUrl = () => (process.env.SCRAPER_ENGINE_URL || '').replace(/\/+$/, '');
const engineToken = () => process.env.SCRAPER_ENGINE_TOKEN || '';

// Scrape control calls are quick; the engine does the long-running work async
// and we poll /api/jobs for progress. 20s is generous for a control round-trip.
const REQUEST_TIMEOUT_MS = 20000;

/** True when SCRAPER_ENGINE_URL is configured, so the UI can gate the mode. */
export function isScraperConfigured() {
  return !!engineUrl();
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
async function requestOnce(method, path, body) {
  const base = engineUrl();
  if (!base) {
    return { error: 'Scraper engine not configured (set SCRAPER_ENGINE_URL)' };
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
export function startScrape({ searchUrls, sheetUrl, profileId, tabName, slowMode = false } = {}) {
  const urls = (Array.isArray(searchUrls) ? searchUrls : [searchUrls])
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);

  if (!urls.length) return Promise.resolve({ error: 'searchUrls required' });
  if (!sheetUrl) return Promise.resolve({ error: 'sheetUrl required' });
  if (!profileId) return Promise.resolve({ error: 'profileId required' });

  if (urls.length === 1) {
    return requestOnce('POST', '/api/scrape/single', {
      searchUrl: urls[0],
      sheetUrl,
      tabName: tabName || 'Results',
      profileId,
      slowMode,
    });
  }
  return requestOnce('POST', '/api/scrape/batch', {
    searchUrls: urls,
    sheetUrl,
    profileId,
    slowMode,
  });
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

/** Current jobs (queued/running/done) with page/profile progress counters. */
export function getJobs() {
  return requestWithRetry('GET', '/api/jobs');
}

/** Recent engine activity log lines. `since` (ms epoch) fetches only newer. */
export function getLogs(since) {
  return requestWithRetry('GET', `/api/logs${since ? `?since=${since}` : ''}`);
}

/** Engine health probe — single attempt, used to show connectivity in the UI. */
export function engineHealth() {
  return requestOnce('GET', '/api/health');
}
