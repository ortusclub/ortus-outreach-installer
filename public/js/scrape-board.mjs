// Pure helpers for the Sales Nav board — no DOM, no fetch, fully unit-tested.
export const ADMIN_EMAIL = 'antonio@ortusclub.com';

export function campaignStatus(jobs) {
  if (!jobs || !jobs.length) return 'idle';
  if (jobs.some((j) => j.state === 'running')) return 'running';
  if (jobs.some((j) => j.state === 'queued')) return 'queued';
  if (jobs.some((j) => j.state === 'error' || j.state === 'cancelled') && !jobs.some((j) => j.state === 'done')) return 'error';
  if (jobs.some((j) => j.state === 'done')) return 'done';
  return 'idle';
}

export function groupJobsIntoCampaigns(campaigns, jobs) {
  const byUrl = new Map();
  for (const c of campaigns || []) for (const u of (c.searchUrls || [])) byUrl.set(u, c.id);
  const jobsByCampaign = new Map();
  for (const j of jobs || []) {
    const cid = byUrl.get(j.searchUrl);
    if (!cid) continue;
    if (!jobsByCampaign.has(cid)) jobsByCampaign.set(cid, []);
    jobsByCampaign.get(cid).push(j);
  }
  return (campaigns || []).map((campaign) => {
    const cjobs = jobsByCampaign.get(campaign.id) || [];
    const status = campaignStatus(cjobs);
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    const etas = cjobs.filter((j) => j.etaMs).map((j) => j.etaMs);
    return {
      campaign,
      jobs: cjobs,
      status,
      running: cjobs.filter((j) => j.state === 'running').length,
      queued: cjobs.filter((j) => j.state === 'queued').length,
      done: cjobs.filter((j) => j.state === 'done').length,
      totalProfiles: cjobs.reduce((n, j) => n + (j.profiles || 0), 0),
      minPosition: positions.length ? Math.min(...positions) : null,
      etaMs: etas.length ? Math.min(...etas) : null,
    };
  });
}

export function toggleDecision({ currentEmail, ownerEmail }) {
  const cur = String(currentEmail || '').trim().toLowerCase();
  const own = String(ownerEmail || '').trim().toLowerCase();
  if (cur === ADMIN_EMAIL) return { needsConfirm: false, isAdmin: true };
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
