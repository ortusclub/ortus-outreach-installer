import { scheduledCampaign, localSchedule } from './basics-schedules.js';
import { isMaturingCampaign } from '../public/js/maturing-visibility.mjs';

export const RUNNING = new Set(['running', 'monitoring', 'collecting', 'checking', 'previewing', 'importing', 'merging']);
const FINISHED = new Set(['done', 'completed', 'stopped', 'cancelled', 'error', 'failed', 'interrupted']);
const WAITING = new Set(['queued', 'pending', 'scheduled', 'waiting_daily_reset', 'paused', 'pausing', 'stopping', 'needs_review']);
const time = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;
const earliest = values => { const times = values.map(time).filter(Boolean); return times.length ? Math.min(...times) : null; };
const owner = c => c.owner || c.ownerEmail || c.owner_email || c.createdBy || '';
const category = c => isMaturingCampaign(c) ? 'maturing' : (c.mode || c.config?.mode || c.launchBody?.mode) === 'sales_nav_scrape' ? 'salesnav' : ['connections', 'connection_db', 'magellan'].includes(c.mode || c.config?.mode) ? 'connections' : 'outreach';

// Count campaigns, not accounts or leads. Permanent IDs join reruns; legacy
// names deliberately never join campaigns owned by different people.
export function buildAdminOverview({ cloud = [], history = [], local = null, queue = [], scrapes = [], connections = [], schedules = [], now = new Date() } = {}) {
  const groups = new Map();
  const seen = new Set();
  function add(c, run, key) {
    const runKey = `${c.category}:${run.source}:${run.id}`;
    if (seen.has(runKey)) return;
    seen.add(runKey);
    const groupKey = `${c.category}:${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { id: groupKey, ...c, runs: [] });
    groups.get(groupKey).runs.push({ ...run, owner: run.owner || c.owner || '',
      scheduled: !!run.scheduleLabel, running: RUNNING.has(run.status), finished: FINISHED.has(run.status), waiting: WAITING.has(run.status),
      hasRun: !!run.startedAt || RUNNING.has(run.status) || FINISHED.has(run.status) || ['monitoring', 'paused', 'waiting_daily_reset'].includes(run.status) });
  }
  for (const c of cloud) {
    add({ name: c.name || 'Untitled campaign', owner: owner(c), category: category(c) }, {
      id: c.id, source: 'cloud', status: c.status || 'unknown', mode: c.mode,
      startedAt: c.started_at || null, createdAt: c.created_at, finishedAt: c.finished_at || c.completed_at,
      accounts: (c.profile_ids || []).length, campaignId: c.campaignId || c.config?.campaignId, ...scheduledCampaign(c),
    }, c.campaignId || c.config?.campaignId || `cloud:${c.id}`);
  }
  history.forEach((c, index) => {
    index = c.historyIndex ?? index;
    // A locally saved mirror of a cloud run is not a second execution.
    if (cloud.some(r => r.id === (c.runId || c.executionId || c.cloudId))) return;
    add({ name: c.name || 'Untitled campaign', owner: owner(c), category: category({ ...c, config: c.settings }) }, {
      id: c.runId || c.executionId || `history-${index}`, historyIndex: index, source: 'history',
      status: c.stopped ? 'stopped' : c.status || (c.endReason === 'errored' ? 'error' : c.endReason === 'stopped' || c.fullStop ? 'stopped' : 'done'), startedAt: c.startedAt || c.startTime || c.ts || c.date,
      finishedAt: c.finishedAt || c.endedAt, mode: c.mode, accounts: (c.profiles || []).length,
      processed: c.totalProcessed, campaignId: c.campaignId,
    }, c.campaignId || `history:${index}`);
  });
  if (local && (local.running || local.state === 'monitoring')) add({ name: local.name || 'Local campaign', owner: owner(local), category: category(local) }, {
    id: local.runId || 'local-active', source: 'local', status: local.paused ? 'paused' : local.state === 'monitoring' ? 'monitoring' : 'running', startedAt: local.startedAt, mode: local.mode,
  }, local.campaignId || 'local-active');
  for (const c of queue) add({ name: c.name || 'Queued campaign', owner: owner(c), category: category(c) }, {
    id: c.id, source: 'queue', status: c.scheduledAt ? 'scheduled' : 'queued', createdAt: c.createdAt || c.queuedAt, mode: c.mode || c.config?.mode, campaignId: c.campaignId, ...scheduledCampaign(c),
  }, c.campaignId || `queue:${c.id}`);
  for (const c of schedules) {
    const timing = localSchedule(c, now);
    if (!timing) continue;
    add({ name: c.name || 'Scheduled campaign', owner: owner(c), category: category({ ...c, config: c.launchBody || c.config }) }, {
      id: c.id, source: 'schedule', status: 'scheduled', campaignId: c.campaignId, mode: c.mode || c.launchBody?.mode,
      accounts: (c.profileIds || c.launchBody?.profileIds || []).length, ...timing,
    }, c.campaignId || `schedule:${c.id}`);
  }
  for (const c of scrapes) {
    const jobsByRun = new Map();
    for (const j of c.jobs || []) {
      const key = j.runId || 'legacy';
      if (!jobsByRun.has(key)) jobsByRun.set(key, []);
      jobsByRun.get(key).push(j);
    }
    if (!jobsByRun.size) jobsByRun.set('saved', []);
    for (const [id, jobs] of jobsByRun) {
      const scheduledJobs = jobs.filter(j => scheduledCampaign(j));
      const state = jobs.some(j => j.state === 'running') ? 'running' : scheduledJobs.length ? 'scheduled' : jobs.some(j => j.state === 'queued') ? 'queued'
        : jobs.some(j => ['error', 'cancelled'].includes(j.state)) ? 'error' : jobs.length ? 'done' : 'idle';
      add({ name: c.name || 'Sales Navigator scrape', owner: owner(c), category: 'salesnav' }, {
        id: `${c.id}:${id}`, campaignId: c.id, runId: id === 'legacy' || id === 'saved' ? null : id, source: 'scrape', status: state,
        createdAt: earliest(jobs.map(j => j.createdAt)),
        startedAt: jobs.some(j => j.state !== 'queued') ? earliest(jobs.map(j => j.startedAt || j.createdAt)) : null,
        ...(scheduledJobs.length ? { scheduleLabel: 'Scheduled start', scheduledAt: earliest(scheduledJobs.map(j => scheduledCampaign(j).scheduledAt)) } : {}),
        accounts: (c.profileIds || []).length, processed: jobs.reduce((n, j) => n + (Number(j.profiles) || 0), 0), searches: jobs.length,
      }, c.id);
    }
  }
  for (const c of connections) add({ name: c.name || 'Connection DB', owner: owner(c), category: 'connections' }, {
    id: c.id, source: 'connections', status: c.status, startedAt: c.startedAt, finishedAt: c.finishedAt,
    accounts: c.total, processed: c.done, phase: c.phase, ...scheduledCampaign(c),
  }, c.id);
  const campaigns = [...groups.values()].map(c => {
    c.runs.sort((a, b) => time(b.startedAt || b.createdAt) - time(a.startedAt || a.createdAt));
    return { ...c, scheduled: c.runs.some(r => r.scheduled), running: c.runs.some(r => r.running), waiting: c.runs.some(r => r.waiting),
      hasRun: c.runs.some(r => r.hasRun), finishedRuns: c.runs.filter(r => r.finished).length };
  }).sort((a, b) => Number(b.running) - Number(a.running) || time(b.runs[0]?.startedAt || b.runs[0]?.createdAt) - time(a.runs[0]?.startedAt || a.runs[0]?.createdAt));
  const categories = ['outreach', 'maturing', 'salesnav', 'connections'].map(id => {
    const rows = campaigns.filter(c => c.category === id);
    return { id, total: rows.length, scheduled: rows.filter(c => c.scheduled).length, running: rows.filter(c => c.running).length, haveRun: rows.filter(c => c.hasRun).length,
      waiting: rows.filter(c => c.waiting).length, finishedRuns: rows.reduce((n, c) => n + c.finishedRuns, 0) };
  });
  return { campaigns, categories };
}
