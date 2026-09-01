import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dataPath } from './paths.js';

const FILE = dataPath('runtime-interruption.json');

export function readRuntimeInterruption() {
  try {
    if (!existsSync(FILE)) return null;
    const value = JSON.parse(readFileSync(FILE, 'utf8'));
    return value && value.active ? value : null;
  } catch {
    return null;
  }
}

export function writeRuntimeInterruption(snapshot = {}) {
  const value = {
    active: true,
    reason: snapshot.reason || 'unexpected-exit',
    recordedAt: snapshot.recordedAt || new Date().toISOString(),
    runsOn: 'local',
    ...snapshot,
  };
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, FILE);
  return value;
}

export function clearRuntimeInterruption() {
  try { unlinkSync(FILE); } catch { /* absent is already clear */ }
}

// `active-run` is a HEARTBEAT, not an interruption. It is written on every
// setCurrentAction so that a process that dies mid-campaign leaves a trace; a
// campaign that is simply alive writes it constantly. Rendering it as an
// interruption made a running campaign's own liveness marker say "Stopped
// because this Mac became unavailable", timestamped at the last heartbeat
// (operator, 2026-08-28: a journal from 12:38, reason active-run, currentAction
// "Acceptance check complete", shown as a stop nobody performed).
export function isInterruption(value) {
  return !!value && value.active === true && value.reason !== 'active-run';
}

// Does this journal describe the campaign on screen? A journal outlives the
// process that wrote it, so without this check a stale one re-labels whatever
// campaign comes next. Both sides fall back to the singleton id.
export function interruptionMatches(value, campaignId) {
  const a = String((value && value.campaignId) || 'legacy-singleton');
  const b = String(campaignId || 'legacy-singleton');
  return a === b;
}

export function interruptionCopy(value = {}) {
  const reason = value.reason || 'unexpected-exit';
  const title = reason === 'system-sleep'
    ? 'Stopped because this Mac went to sleep'
    : reason === 'app-quit'
      ? 'Stopped because the app was closed'
      : reason === 'campaign-stop-timeout'
        ? 'Stopped after the 15-second safety limit'
        : reason === 'unexpected-exit'
          ? 'Stopped because this Mac became unavailable'
          // Never invent a cause for a reason this function does not know.
          : 'Stopped, and the app could not record why';
  const detail = value.phase === 'monitoring'
    ? 'Monitoring did not restart sending. Resume checks on this Mac or move them to the Cloud VM.'
    : 'The remaining leads are safe. Choose where to continue before sending resumes.';
  return { title, detail, needsReview: false, review: null };
}
