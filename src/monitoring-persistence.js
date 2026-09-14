import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { writeJsonAtomic } from './atomic-json-store.js';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MONITORING_FILE = dataPath('monitoring-campaign.json');
let pendingPersistence = 0;

/**
 * Persistable slice of the campaign object — JUST the fields needed to
 * rehydrate the Monitoring UI + log routing after an app restart.
 * Does NOT include workers, browser handles, etc.
 */
export const MONITORING_FIELDS = [
  'id',
  'executionId',
  'taskCampaignId',
  'campaignRunId',
  'name',
  'state',
  'mode',
  'sheetUrl',
  // Lead-source guard: the operator-chosen tab. Persisted so post-restart
  // monitoring re-fetches the SAME tab. Older slices lack it → campaign.js
  // backfills from extractSheetGid(sheetUrl) on restore.
  'sheetGid',
  'linkedinColumn',
  'profileIds',
  'profileNames',
  'participatingProfileIds',
  'sendingEndedAt',
  'monitoringUntil',
  'nextCheckAt',
  'logs',
  'templates',
  // v2.13.14: persisted so runMonitoringCheck → runAutoIntros can resolve
  // `{sender first name}` to the operator-configured nice name after an
  // app restart. Without this, post-restart monitoring intro DMs fall
  // back to the GoLogin email split.
  'senderFirstNames',
  // v2.14.x: operator-chosen cadence (15-360 min) for the monitoring
  // auto-trigger. Survives restart so the watcher tick uses the right
  // interval after rehydration; defaults to 60 if absent (e.g. older
  // state files written before this field shipped).
  'checkIntervalMinutes',
  // v2.112: operator toggle for the periodic auto-check. Absent in older
  // state files → undefined → treated as enabled (default-on).
  'autoChecksEnabled',
  // Consecutive empty-sweep count driving the adaptive check cadence (see
  // monitoring-cadence.js). Absent in older state files → treated as 0, the
  // BASE cadence — the shorter one. Its absence can only ever make checks
  // MORE frequent, never less.
  'emptyCheckStreak',
  'totalTargets',
  'totalProcessed',
];

// A small control-plane commit: no await between the caller's final revision
// check, durable replacement and in-memory activation. A concurrent Stop cannot
// interleave and leave a stale enabled snapshot that resumes after reboot.
export function commitMonitoringState(campaign) {
  if (pendingPersistence) throw new Error('A previous monitoring save or Stop is still finishing. Wait before continuing.');
  const slice = extractMonitoringSlice(campaign);
  if (!slice || slice.state !== 'monitoring') throw new Error('Monitoring commit requires a monitoring snapshot.');
  const temporary = `${MONITORING_FILE}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(slice, null, 2), { mode: 0o600 });
    renameSync(temporary, MONITORING_FILE);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export function extractMonitoringSlice(campaign) {
  if (!campaign) return null;
  const out = {};
  for (const k of MONITORING_FIELDS) {
    if (campaign[k] !== undefined) out[k] = campaign[k];
  }
  return out;
}

export async function writeMonitoringState(campaign, { strict = false } = {}) {
  pendingPersistence++;
  try {
  const slice = extractMonitoringSlice(campaign);
  if (!slice || slice.state !== 'monitoring') {
    if (strict) throw new Error('Strict monitoring persistence requires a monitoring snapshot.');
    // Either no monitoring active or campaign moved to done — clear the file
    await clearMonitoringState();
    return;
  }
  try {
    if (strict) await writeJsonAtomic(MONITORING_FILE, slice);
    else await writeFile(MONITORING_FILE, JSON.stringify(slice, null, 2));
  } catch (err) {
    if (strict) throw err;
    console.warn(`[monitoring-persistence] write failed: ${err.message}`);
  }
  } finally { pendingPersistence--; }
}

export async function readMonitoringState() {
  try {
    const raw = await readFile(MONITORING_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearMonitoringState() {
  pendingPersistence++;
  try { await unlink(MONITORING_FILE); } catch { /* not there is fine */ }
  finally { pendingPersistence--; }
}
