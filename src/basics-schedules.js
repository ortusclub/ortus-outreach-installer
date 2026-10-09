import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { nextCronRun } from '../public/js/schedule-time.mjs';

export function scheduledCampaign(c) {
  const status = c.status || c.state || '';
  const datedStart = c.scheduled_start_at || c.scheduledAt || c.startAt || null;
  if (['done', 'completed', 'cancelled', 'stopped', 'error', 'failed', 'paused', 'pausing', 'stopping'].includes(status)) return null;
  if (status === 'waiting_daily_reset') return { scheduledAt: c.resumeTaskDueAt || null, scheduleLabel: 'Next daily window' };
  if (status === 'scheduled' || datedStart && ['pending', 'queued', ''].includes(status)) {
    return { scheduledAt: datedStart, scheduleLabel: datedStart ? 'Scheduled start' : 'Start time pending' };
  }
  return null;
}

export function localSchedule(c, now = new Date()) {
  if (c.enabled === false) return null;
  const next = nextCronRun(c.cron, now);
  if (!next) return null;
  const fields = String(c.cron).trim().split(/\s+/);
  return { scheduledAt: next.toISOString(), scheduleLabel: fields[2] === '*' || fields[3] === '*' ? 'Repeating schedule' : 'Scheduled date' };
}

export function basicsDataDirectory() {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'Ortus Basics', 'data');
}

// Read-only: never import or start Basics, its schedulers, or its workers.
// The shared engine has no reliable source-app tag. Only exact launch IDs
// retained by Basics can identify its cloud campaigns.
export async function readBasicsSchedules(cloud = [], { directory = basicsDataDirectory(), now = new Date() } = {}) {
  const warnings = [];
  try { await stat(directory); }
  catch (error) {
    return { available: false, schedules: [], knownCloudIds: [], warnings: [error.code === 'ENOENT' ? 'No Ortus Basics data was found on this Mac.' : 'Ortus Basics data could not be read.'] };
  }
  async function read(name, fallback) {
    try {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(fallback)) throw new Error('Invalid stored format');
      return value;
    }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`Could not read Basics ${name === 'cloud-launch-configs.json' ? 'cloud launch records' : 'schedules'}. Counts may be incomplete.`); return fallback; }
  }
  const [recurring, queue, launches] = await Promise.all([read('schedules.json', []), read('queued-campaigns.json', []), read('cloud-launch-configs.json', {})]);
  const knownCloudIds = Object.keys(launches || {});
  const rows = [];
  const make = (c, timing, source) => ({ id: c.id, campaignId: c.campaignId || c.config?.campaignId,
    name: c.name || c.config?.name || 'Untitled campaign', owner: c.owner || c.createdBy || '',
    mode: c.mode || c.config?.mode, source, accounts: (c.profileIds || c.profile_ids || c.config?.profileIds || []).length,
    status: c.status || 'scheduled', ...timing });
  for (const c of Array.isArray(recurring) ? recurring : []) {
    const timing = localSchedule(c, now); if (timing) rows.push(make(c, timing, 'schedule'));
  }
  for (const c of Array.isArray(queue) ? queue : []) {
    const timing = scheduledCampaign(c); if (timing) rows.push(make(c, timing, 'queue'));
  }
  for (const c of cloud) {
    if (!Object.hasOwn(launches, c.id)) continue;
    const timing = scheduledCampaign(c); if (timing) rows.push(make(c, timing, 'cloud'));
  }
  const scheduled = new Set(rows.map(r => r.campaignId || `${r.source}:${r.id}`)).size;
  rows.sort((a, b) => Date.parse(a.scheduledAt || '') - Date.parse(b.scheduledAt || ''));
  return { available: true, scheduled, schedules: rows, knownCloudIds, warnings,
    scope: 'Schedules saved by Ortus Basics on this Mac, plus cloud schedules matched to its saved launch records. Local schedules require Basics to be open. Other Macs and untagged cloud campaigns are not identifiable here.' };
}
