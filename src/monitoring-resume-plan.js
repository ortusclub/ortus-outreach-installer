import { usesMonitoringCadence, clampCadenceMinutes } from '../public/js/campaign-modes.mjs';
import { taskOwnerOf } from './task-owner.js';

// Planning is intentionally read-only. The command must still compare this
// identity/revision under its control lock and persist before arming a watcher.
export function planMonitoringResume(snapshot, request, now = Date.now()) {
  if (!snapshot || !request?.executionId || request.executionId !== snapshot.executionId) {
    throw new Error('The selected campaign execution changed. Refresh before continuing.');
  }
  if (!Number.isFinite(now)) throw new Error('Invalid monitoring clock.');
  if (!usesMonitoringCadence(snapshot.mode)) throw new Error('This campaign type has no acceptance-monitoring phase.');
  if (snapshot.running || snapshot.paused || snapshot.pauseRequested || snapshot.monitoringCheckInProgress
      || !['idle', 'done', 'monitoring'].includes(snapshot.state)) {
    throw new Error('Sending, pause, recovery or a check must settle before restoring automatic monitoring.');
  }
  const owner = taskOwnerOf(snapshot);
  if (!owner) throw new Error('The saved campaign has no proven task owner.');
  if (!snapshot.sheetUrl || !Array.isArray(snapshot.participatingProfileIds)
      || !snapshot.participatingProfileIds.length
      || snapshot.participatingProfileIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('The original monitoring sheet and participating accounts must be established first.');
  }
  const until = Date.parse(snapshot.monitoringUntil || '');
  const ended = Date.parse(snapshot.sendingEndedAt || '');
  if (!Number.isFinite(until) || !Number.isFinite(ended) || ended > now || until <= ended) {
    throw new Error('The original monitoring window is missing or invalid; it cannot be invented or extended here.');
  }
  if (until <= now) throw new Error('The original monitoring window has expired.');
  const cadence = clampCadenceMinutes(snapshot.checkIntervalMinutes);
  const existingDue = Date.parse(snapshot.nextCheckAt || '');
  const alreadyActive = snapshot.state === 'monitoring' && snapshot.autoChecksEnabled !== false;
  if (alreadyActive && (!Number.isFinite(existingDue) || existingDue >= until)) {
    throw new Error('Monitoring is marked active but its schedule is missing or invalid. Review recovery before continuing.');
  }
  // Preserve a valid future boundary; a past/absent one gets one full interval,
  // never an immediate catch-up sweep triggered by opening the continuation UI.
  const due = Number.isFinite(existingDue) && existingDue > now ? existingDue : now + cadence * 60000;
  if (due >= until) throw new Error('No scheduled check fits inside the remaining monitoring window.');
  return {
    executionId: snapshot.executionId, owner,
    alreadyActive,
    nextCheckAt: new Date(due).toISOString(), monitoringUntil: new Date(until).toISOString(),
    checkIntervalMinutes: cadence,
    // No sender configuration, lead-status reset, limits or account changes.
    patch: { state: 'monitoring', autoChecksEnabled: true, nextCheckAt: new Date(due).toISOString() },
  };
}
