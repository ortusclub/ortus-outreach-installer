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
    const etas = cjobs.filter((j) => j.etaMs).map((j) => j.etaMs);
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
    g.jobs.push(j);
    if (!g.ownerEmail && j.ownerEmail) g.ownerEmail = String(j.ownerEmail).trim();
    if (j.searchUrl && !g.searchUrls.includes(j.searchUrl)) g.searchUrls.push(j.searchUrl);
    if (j.profileId && !g.profileIds.includes(j.profileId)) g.profileIds.push(j.profileId);
  }
  return [...groups.values()].map((g) => {
    const cjobs = g.jobs;
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    const etas = cjobs.filter((j) => j.etaMs).map((j) => j.etaMs);
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
