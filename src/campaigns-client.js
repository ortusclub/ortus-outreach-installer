/**
 * Cloud campaign engine client.
 *
 * Sibling of scraper-client.js. Where scraper-client.js dispatches Sales Nav
 * SCRAPES to the GKE engine, this module dispatches CAMPAIGNS (connect / intro /
 * DM / follower-growth) to the SAME engine's campaign API — so a campaign can
 * run in the cloud (survives the laptop closing) instead of on the operator's
 * Mac. It launches NO browser locally and bypasses the local campaign/
 * performOutreach path entirely.
 *
 * Same host + bearer token as the scraper (the campaign API is mounted on the
 * engine's frontend behind the same auth), so it reuses scraper-engine-url.js —
 * no separate endpoint/token to configure.
 *
 * Engine campaign API (server-side campaign-api.js):
 *   POST /api/campaign/start        { mode, name, owner, profileIds[], sheetUrl,
 *                                     dailyLimit, config{}, leads[{leadUrl,
 *                                     memberUrn, fullName}] }
 *   GET  /api/campaign/list?owner=
 *   GET  /api/campaign/:id
 *   POST /api/campaign/:id/stop[?pause=1]
 *
 * Like scraper-client.js, calls NEVER throw — they resolve to parsed JSON or an
 * { error } object so the dashboard can surface "engine not wired up yet" or a
 * transient failure without crashing the campaign flow.
 */

import { withWriteRetry } from './sheets-writer.js';
import { SCRAPER_ENGINE_URL, SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';

const engineUrl = () => (process.env.SCRAPER_ENGINE_URL || SCRAPER_ENGINE_URL).replace(/\/+$/, '');
const engineToken = () => process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN;

// Control round-trips are quick; the engine runs the campaign async and the UI
// polls /api/campaign/:id for progress. 20s is generous.
const REQUEST_TIMEOUT_MS = 20000;

// Modes the cloud engine supports (mirror of campaign-runtime MODE_PLAN). Used
// to gate the "Run in cloud" toggle so unsupported modes stay local-only.
export const CLOUD_MODES = new Set([
  'connect_only',
  'message_only',
  'introduce_back',
  'connect_and_introduce',
  'connect_and_message',
  'follower_growth',
  'inmail_only',
  'open_profile_only',
  'check_status',
]);

/** True when the engine URL is configured, so the UI can gate the cloud toggle. */
export function isCampaignEngineConfigured() {
  return !!engineUrl();
}

/** True when a given mode can run in the cloud today. */
export function isCloudMode(mode) {
  return CLOUD_MODES.has(String(mode || ''));
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = engineToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// One attempt; returns parsed JSON or { error }, never throws. 5xx/429 embed the
// status so withWriteRetry's transient detection retries them; 4xx are returned
// as-is (retrying won't help — it's a bad request).
async function requestOnce(method, path, body) {
  const base = engineUrl();
  if (!base) return { error: 'Campaign engine not configured (set SCRAPER_ENGINE_URL)' };
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const detail = parsed && parsed.error ? `: ${parsed.error}` : '';
      return { error: `HTTP ${res.status}${detail}`, status: res.status };
    }
    return parsed;
  } catch (err) {
    return { error: err.message };
  }
}

// Retry wrapper for IDEMPOTENT calls (list / status / stop).
function requestWithRetry(method, path, body) {
  return withWriteRetry(() => requestOnce(method, path, body), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    log: (m) => console.warn(`[campaigns-client] ${m}`),
  });
}

/**
 * Start a campaign on the cloud engine.
 *
 * Single attempt (NO retry): starting a campaign is not idempotent — a retried
 * POST after a transient blip could create a duplicate. Pass a stable `id` to
 * make it idempotent if you need retries. The operator can re-click if it fails.
 *
 * @param {object}   c
 * @param {string}   c.mode         one of CLOUD_MODES
 * @param {string[]} c.profileIds   GoLogin accounts the campaign may drive
 * @param {Array}    c.leads        [{ leadUrl, memberUrn?, fullName? }]
 * @param {object}   [c.config]     mode templates/settings (connectionNote,
 *                                  ccDmBody, primaryName, primaryIntroBody,
 *                                  primaryUrl, introTitle, monthlyBudget, …)
 * @param {string}   [c.name]       display name
 * @param {string}   [c.owner]      operator id/email (walls off per-user views)
 * @param {string}   [c.sheetUrl]   source sheet (for reference/write-back)
 * @param {number}   [c.dailyLimit] per-account daily cap
 * @param {string}   [c.id]         optional stable id (idempotency)
 */
export function startCloudCampaign(c = {}) {
  const mode = String(c.mode || '');
  if (!isCloudMode(mode)) {
    return Promise.resolve({ error: `Mode "${mode}" can't run in the cloud yet.` });
  }
  const profileIds = (Array.isArray(c.profileIds) ? c.profileIds : []).filter(Boolean);
  if (!profileIds.length) return Promise.resolve({ error: 'No GoLogin accounts selected.' });
  const leads = (Array.isArray(c.leads) ? c.leads : [])
    .map((l) => ({
      leadUrl: (l.leadUrl || l.url || l.lead_url || '').trim(),
      memberUrn: l.memberUrn || l.member_urn || null,
      fullName: l.fullName || l.full_name || l.name || '',
      // Auto-routed modes pin each lead to its sender account.
      routeAccount: l.routeAccount || l.route_account || '',
      // The full source-sheet row → engine row_data, so intro templates can fill
      // {company}/{title}/etc. Without this, those variables render blank in the
      // 3-way intro (the engine's lead columns are never populated).
      row: l.row || l.row_data || {},
    }))
    .filter((l) => l.leadUrl);
  if (!leads.length) return Promise.resolve({ error: 'No leads to send (source sheet empty or unreadable).' });

  return requestOnce('POST', '/api/campaign/start', {
    id: c.id,
    mode,
    name: c.name || '',
    owner: c.owner || '',
    profileIds,
    sheetUrl: c.sheetUrl || '',
    dailyLimit: c.dailyLimit ?? 50,
    config: c.config || {},
    leads,
  });
}

/** List cloud campaigns (optionally scoped to one operator). */
export function listCloudCampaigns(owner) {
  const q = owner ? `?owner=${encodeURIComponent(owner)}` : '';
  return requestWithRetry('GET', `/api/campaign/list${q}`);
}

/** One campaign + its live lead-status counts. */
export function getCloudCampaign(id) {
  return requestWithRetry('GET', `/api/campaign/${encodeURIComponent(id)}`);
}

/**
 * Per-lead status rows for one cloud campaign — the engine's per-lead endpoint
 * (deployed as of 2026-07). Each row: { id, leadUrl, fullName, account, status
 * ('pending'|'sent'|'error'|...), stage, error, sentAt, connectionStatus,
 * connectionAcceptedStatus, introductionStatus, dmStatus }. Idempotent GET, so
 * it retries transient failures. Returns { leads:[…], total } or { error }.
 */
export function getCloudCampaignLeads(id) {
  return requestWithRetry('GET', `/api/campaign/${encodeURIComponent(id)}/leads`);
}

/**
 * Signal the engine that the local primary browser has accepted the campaign's
 * pending sender invitations (cloud primary-handshake, local-only primary).
 * Single attempt (mirrors startCloudCampaign) — a duplicate returns a terminal
 * 409 that requestOnce encodes as { error, status:409 }. See
 * docs/cloud-engine-primary-handshake-spec.md.
 * @param {string}   id           cloud campaign id
 * @param {string[]} acceptedIds  sender profileIds accepted
 */
export function signalPrimaryAcceptDone(id, acceptedIds) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/primary-accept-done`, {
    accepted: Array.isArray(acceptedIds) ? acceptedIds : [],
  });
}

/** Stop (cancel) a cloud campaign; pass { pause: true } to pause instead. */
export function stopCloudCampaign(id, { pause = false } = {}) {
  return requestWithRetry('POST', `/api/campaign/${encodeURIComponent(id)}/stop${pause ? '?pause=1' : ''}`);
}

// Monitoring controls (Task 3 Part B) — mirror the local ⚡ Check now / Automatic
// checks toggle. Single-shot (requestOnce): user-initiated, fine to fail loudly.
// Return { error, status } until the engine ships these routes, so the UI can
// degrade gracefully ("engine update pending") instead of throwing.
export function cloudCheckNow(id) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/check-now`);
}
export function setCloudAutoChecks(id, enabled) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/auto-checks`, { enabled: !!enabled });
}

/**
 * Open the live MJPEG screencast for a running cloud campaign's active browser
 * session — the campaign analogue of openJobViewStream (scraper-client.js). The
 * engine must expose `GET /api/campaign/:id/view` streaming
 * multipart/x-mixed-replace (see docs/cloud-engine-campaign-view-spec.md).
 *
 * Resolves to { ok:true, contentType, body, abort } to pipe straight to the
 * dashboard <img>, or { ok:false, status, error } — never throws. No timeout
 * (long-lived stream); the caller aborts when the viewer closes.
 *
 * Until the engine ships that endpoint, the `/view` path falls through to the
 * engine's SPA (text/html); we detect that and report a clean "not available
 * yet" (501) instead of piping HTML into an <img>.
 */
export async function openCampaignViewStream(id) {
  const base = engineUrl();
  if (!base) return { ok: false, status: 503, error: 'Campaign engine not configured' };
  const controller = new AbortController();
  try {
    const headers = {};
    const token = engineToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}/api/campaign/${encodeURIComponent(id)}/view`, {
      method: 'GET', headers, signal: controller.signal,
    });
    if (!res.ok) {
      controller.abort();
      // Pass the engine's real reason through (e.g. {error:"no active session"})
      // so the viewer can distinguish an expected idle window from a real fault.
      let body = null; try { body = await res.json(); } catch { /* not json */ }
      return { ok: false, status: res.status, error: (body && body.error) || `HTTP ${res.status}` };
    }
    const ct = res.headers.get('content-type') || '';
    if (/text\/html/i.test(ct)) {
      controller.abort();
      return { ok: false, status: 501, error: "Live browser view isn't available yet — the cloud engine doesn't stream campaign browsers. (The per-lead log shows live activity.)" };
    }
    return {
      ok: true,
      contentType: ct || 'multipart/x-mixed-replace',
      body: res.body,
      abort: () => { try { controller.abort(); } catch { /* */ } },
    };
  } catch (err) {
    controller.abort();
    return { ok: false, status: 502, error: err.message };
  }
}
