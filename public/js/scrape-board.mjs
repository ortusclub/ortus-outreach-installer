// Pure helpers for the Sales Nav board — no DOM, no fetch, fully unit-tested.
// Client-side admin set — mirrors the server's ADMIN_EMAILS default. Keyed off
// the per-machine operator email (snCurrentEmail), NOT the shared login.
export const ADMIN_EMAILS = new Set(['antonio@ortusclub.com', 'antoniov@ortusclub.com', 'sam@ortusclub.com']);
export const isAdminEmail = (e) => ADMIN_EMAILS.has(String(e || '').trim().toLowerCase());
// Back-compat single value for any legacy importer.
export const ADMIN_EMAIL = 'antonio@ortusclub.com';

export function campaignStatus(jobs) {
  if (!jobs || !jobs.length) return 'idle';
  if (jobs.some((j) => j.state === 'running')) return 'running';
  if (jobs.some((j) => j.state === 'queued')) return 'queued';
  if (jobs.some((j) => j.state === 'error' || j.state === 'cancelled') && !jobs.some((j) => j.state === 'done')) return 'error';
  if (jobs.some((j) => j.state === 'done')) return 'done';
  return 'idle';
}

export function mergeCampaignsWithJobs(campaigns, jobs) {
  const byUrl = new Map();
  for (const c of campaigns || []) for (const u of (c.searchUrls || [])) byUrl.set(u, c.id);
  const jobsByCampaign = new Map();
  for (const j of jobs || []) {
    const cid = byUrl.get(j.searchUrl);
    if (!cid) continue;
    if (!jobsByCampaign.has(cid)) jobsByCampaign.set(cid, []);
    jobsByCampaign.get(cid).push(j);
  }
  return (campaigns || []).map((c) => {
    const cjobs = jobsByCampaign.get(c.id) || [];
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    // Keep 0 — it means "next up", not "no estimate". Dropping it made the
    // strip show the SECOND job's ETA as the campaign's soonest start.
    const etas = cjobs.filter((j) => Number.isFinite(j.etaMs)).map((j) => j.etaMs);
    return {
      ...c, jobs: cjobs, status: campaignStatus(cjobs),
      running: cjobs.filter((j) => j.state === 'running').length,
      queued: cjobs.filter((j) => j.state === 'queued').length,
      done: cjobs.filter((j) => j.state === 'done').length,
      totalProfiles: cjobs.reduce((n, j) => n + (j.profiles || 0), 0),
      minPosition: positions.length ? Math.min(...positions) : null,
      etaMs: etas.length ? Math.min(...etas) : null,
    };
  });
}

// Strip a trailing " N" batch suffix so the per-URL tabs of one launch
// ("Results", "Results 2", "Results 3") collapse to a single base name.
export function baseTabName(tab) {
  return String(tab || '').replace(/\s+\d+\s*$/, '').trim();
}

// Deterministic small hash → stable synthetic campaign id (no Math.random,
// which is unavailable in workflow scripts and would break resume/tests).
function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Build board strips DIRECTLY from the engine's shared job list (every
// operator's jobs, each tagged with userId/profileId/tabName/sheetUrl and —
// when the engine echoes them — ownerEmail/campaignName). One launch's jobs
// share userId+sheetUrl+base-tab, so that triple is a robust grouping key that
// works even if the engine drops the ride-along fields; ownerEmail/campaignName
// are then pure display enrichments. `currentEmail`/`currentOperatorId` mark
// which strips belong to the viewer (email match, or same install id).
// The board's synthetic strip id, derived from the SAME triple the grouping
// uses. Exported so the dispatch path can compute a scrape's board id BEFORE
// its jobs exist — that's what lets a launch write its log lines against the
// strip the operator will actually open.
export function scrapeCampaignId({ userId = '', sheetUrl = '', base = '' } = {}) {
  const name = String(base || '').trim() || 'Sales Nav scrape';
  return 'eng_' + _hash(`${userId || ''}|${sheetUrl || ''}|${name}`);
}

export function groupJobsIntoCampaigns(jobs, { currentEmail = '', currentOperatorId = '' } = {}) {
  const curEmail = String(currentEmail || '').trim().toLowerCase();
  const curId = String(currentOperatorId || '').trim();
  const groups = new Map();
  for (const j of jobs || []) {
    const userId = j.userId || '';
    const base = (j.campaignName || baseTabName(j.tabName) || 'Sales Nav scrape').trim();
    const key = `${userId}|${j.sheetUrl || ''}|${base}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: 'eng_' + _hash(key), userId,
        ownerEmail: (j.ownerEmail || '').trim(),
        name: j.campaignName || base,
        tabName: baseTabName(j.tabName) || 'Results',
        sheetUrl: j.sheetUrl || '', searchUrls: [], profileIds: [], jobs: [],
      });
    }
    const g = groups.get(key);
    g.key = key;
    g.jobs.push(j);
    if (!g.ownerEmail && j.ownerEmail) g.ownerEmail = String(j.ownerEmail).trim();
    if (j.searchUrl && !g.searchUrls.includes(j.searchUrl)) g.searchUrls.push(j.searchUrl);
    if (j.profileId && !g.profileIds.includes(j.profileId)) g.profileIds.push(j.profileId);
  }
  return [...groups.values()].map((g) => {
    const cjobs = g.jobs;
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    // Keep 0 — it means "next up", not "no estimate". Dropping it made the
    // strip show the SECOND job's ETA as the campaign's soonest start.
    const etas = cjobs.filter((j) => Number.isFinite(j.etaMs)).map((j) => j.etaMs);
    // Owner label: real email if the engine echoed it, else a short, stable
    // install tag so strangers' strips still read as "someone else's".
    const owner = g.ownerEmail || (g.userId ? `operator ${g.userId.replace(/^op_/, '').slice(0, 6)}` : 'unknown');
    const mine = (!!curEmail && g.ownerEmail && g.ownerEmail.toLowerCase() === curEmail)
      || (!!curId && g.userId === curId);
    return {
      ...g, owner, mine,
      status: campaignStatus(cjobs),
      running: cjobs.filter((j) => j.state === 'running').length,
      queued: cjobs.filter((j) => j.state === 'queued').length,
      done: cjobs.filter((j) => j.state === 'done').length,
      totalProfiles: cjobs.reduce((n, j) => n + (j.profiles || 0), 0),
      minPosition: positions.length ? Math.min(...positions) : null,
      etaMs: etas.length ? Math.min(...etas) : null,
      // toggle "on" = not all jobs are paused/stopped.
      enabled: cjobs.some((j) => j.state === 'running' || j.state === 'queued'),
    };
  });
}

// ---------------------------------------------------------------------------
// Board diff → durable log events.
//
// The engine's job list is the ONLY place a scrape's per-job state, page count
// and lead count are ever observed, and nothing was writing them down: the
// board rendered them and threw them away, so "when did it stall", "which
// account errored" and "what did the run finish with" were unanswerable the
// moment the strip re-rendered. The board already polls; diffing consecutive
// polls turns that poll into the missing log stream at no extra fetch.
//
// Pure: prev/next are campaign arrays, the return is the lines to persist.
// ---------------------------------------------------------------------------
const _shortAcct = (pid) => String(pid || '').slice(0, 8) || 'account';
const _jobLabel = (j) => baseTabName(j.tabName) || _shortAcct(j.profileId);

export function diffBoardEvents(prevCampaigns, nextCampaigns) {
  const prevById = new Map((prevCampaigns || []).map((c) => [c.id, c]));
  const out = [];
  for (const c of nextCampaigns || []) {
    const prev = prevById.get(c.id);
    // First sighting of a campaign is not an event — we'd replay the entire
    // board into every log on the first poll after a restart.
    if (!prev) continue;
    const prevJobs = new Map((prev.jobs || []).map((j) => [j.id, j]));
    const push = (message, level) => out.push({ campaignId: c.id, message, level: level || 'info' });

    for (const j of c.jobs || []) {
      const p = prevJobs.get(j.id);
      const acct = `${_jobLabel(j)} · ${_shortAcct(j.profileId)}`;
      if (!p) {
        if (j.state === 'queued') push(`⏳  Queued — ${acct}`);
        continue;
      }
      if (p.state === j.state) continue;
      switch (j.state) {
        case 'running':
          push(`▶  Started — ${acct}`);
          break;
        case 'done':
          push(`✓  Finished — ${acct} · ${j.profiles || 0} lead(s) · ${j.pages || 0} page(s)`, 'ok');
          break;
        case 'error':
          push(`✗  Failed — ${acct}: ${j.error || 'no reason reported by the engine'}`, 'err');
          break;
        case 'cancelled':
          push(`⏹  Cancelled — ${acct} · ${j.profiles || 0} lead(s) collected`, 'warn');
          break;
        default:
          push(`${acct} — ${p.state || '?'} → ${j.state}`);
      }
    }

    // Progress, only when the lead count actually moved. A running scrape that
    // stops moving now leaves a visible gap in the log instead of looking the
    // same as one that is working.
    const leads = c.totalProfiles || 0;
    const prevLeads = prev.totalProfiles || 0;
    if (leads > prevLeads && c.status === 'running') {
      push(`  → ${leads} lead(s) so far (+${leads - prevLeads})`);
    }

    // Campaign-level completion: the "Σ Total" line the scrape never had.
    if (prev.status !== 'done' && c.status === 'done') {
      const pages = (c.jobs || []).reduce((n, j) => n + (j.pages || 0), 0);
      push(`Σ  Complete — ${leads} lead(s) · ${pages} page(s) · ${(c.jobs || []).length} account-run(s)`, 'ok');
    }
    if (prev.status !== 'error' && c.status === 'error') {
      push('⛔  This scrape ended with no successful runs — see the failures above.', 'err');
    }
  }
  return out;
}

export function toggleDecision({ currentEmail, ownerEmail }) {
  const cur = String(currentEmail || '').trim().toLowerCase();
  const own = String(ownerEmail || '').trim().toLowerCase();
  if (isAdminEmail(cur)) return { needsConfirm: false, isAdmin: true };
  if (cur && cur === own) return { needsConfirm: false, isAdmin: false };
  return { needsConfirm: true, isAdmin: false };
}

export function fmtEta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalMin = Math.round(n / 60000);
  if (totalMin < 60) return `~${totalMin}m`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

// ---------------------------------------------------------------------------
// Board payload slimming.
//
// Measured 2026-08-13 on the live board: GET /api/scrape/campaigns returned
// 20,404,966 bytes for 288 strips / 2,247 jobs, and the client re-fetched and
// re-parsed all of it every 2.5s. 17.7MB of that was Sales Nav search URLs
// (~3.1KB each, carried twice — once per job, once per campaign) that no strip
// ever renders in full. The heavy fields all have exactly one consumer:
//   - job.searchUrl  → a 60-char label on the expanded card
//   - campaign.searchUrls → a COUNT, plus a lookup key into the client's
//     launch registry (localStorage, keyed by search URL)
// So the list carries a short label and a hash key instead, and the wizard's
// Open/Re-run path keeps reading full URLs from /api/scrape/campaigns/:id.
// ---------------------------------------------------------------------------

/** FNV-1a → base36. Stable across app and server; used to key the launch registry. */
export function searchKey(url) {
  const s = String(url || '');
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const JOB_LABEL_MAX = 60;

export function slimBoard(campaigns) {
  return (campaigns || []).map((c) => {
    const urls = c.searchUrls || [];
    const { searchUrls, ...rest } = c;
    return {
      ...rest,
      searchCount: urls.length,
      searchKeys: urls.map(searchKey),
      jobs: (c.jobs || []).map((j) => {
        const { searchUrl, sheetUrl, lockKey, podId, podIP, ...jrest } = j;
        return searchUrl
          ? { ...jrest, searchLabel: String(searchUrl).slice(0, JOB_LABEL_MAX) }
          : jrest;
      }),
    };
  });
}
