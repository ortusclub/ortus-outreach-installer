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

export function interruptionCopy(value = {}) {
  const reason = value.reason || 'unexpected-exit';
  const title = reason === 'system-sleep'
    ? 'Stopped because this Mac went to sleep'
    : reason === 'app-quit'
      ? 'Stopped because the app was closed'
      : reason === 'campaign-stop-timeout'
        ? 'Stopped after the 15-second safety limit'
        : 'Stopped because this Mac became unavailable';
  const detail = value.phase === 'monitoring'
    ? 'Monitoring did not restart sending. Resume checks on this Mac or move them to the Cloud VM.'
    : 'The remaining leads are safe. Choose where to continue before sending resumes.';
  return { title, detail, needsReview: false, review: null };
}
