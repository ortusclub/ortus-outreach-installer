import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dataPath } from './paths.js';

const MONITORING_FILE = dataPath('monitoring-campaign.json');

/**
 * Persistable slice of the campaign object — JUST the fields needed to
 * rehydrate the Monitoring UI + log routing after an app restart.
 * Does NOT include workers, browser handles, etc.
 */
export const MONITORING_FIELDS = [
  'id',
  'name',
  'state',
  'mode',
  'sheetUrl',
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
];

export function extractMonitoringSlice(campaign) {
  if (!campaign) return null;
  const out = {};
  for (const k of MONITORING_FIELDS) {
    if (campaign[k] !== undefined) out[k] = campaign[k];
  }
  return out;
}

export async function writeMonitoringState(campaign) {
  const slice = extractMonitoringSlice(campaign);
  if (!slice || slice.state !== 'monitoring') {
    // Either no monitoring active or campaign moved to done — clear the file
    await clearMonitoringState();
    return;
  }
  try {
    await writeFile(MONITORING_FILE, JSON.stringify(slice, null, 2));
  } catch (err) {
    console.warn(`[monitoring-persistence] write failed: ${err.message}`);
  }
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
  try { await unlink(MONITORING_FILE); } catch { /* not there is fine */ }
}
