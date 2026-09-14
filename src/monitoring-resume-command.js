import { planMonitoringResume } from './monitoring-resume-plan.js';

// Caller holds the existing recovery admission lock. Dependencies are explicit
// so tests can prove that persistence failure or Stop cannot arm a watcher.
export async function resumeMonitoringOnly(request, { snapshot, confirmShutdown, commit, activate, now = Date.now }) {
  const original = snapshot();
  const first = planMonitoringResume(original, request, now());
  if (first.alreadyActive) return { ok: true, alreadyActive: true, nextCheckAt: original.nextCheckAt };
  const generation = original._generation, revision = original._controlRevision;
  const proof = await confirmShutdown();
  if (!proof?.ok) throw new Error('Browser shutdown is not confirmed. Monitoring was not resumed.');
  const current = snapshot();
  if (current.executionId !== original.executionId || current._generation !== generation
      || current._controlRevision !== revision) throw new Error('A newer control changed this campaign. Monitoring was not resumed.');
  const plan = planMonitoringResume(current, request, now());
  const candidate = { ...current, ...plan.patch, _controlRevision: (current._controlRevision || 0) + 1,
    _abort: false, _skipCleanup: false, stopReason: null };
  // Both dependencies must be synchronous: this is the atomic activation
  // boundary with respect to Stop and the next local sender admission.
  const saved = commit(candidate);
  if (saved && typeof saved.then === 'function') throw new Error('Monitoring commit must be synchronous.');
  activate(candidate);
  return { ok: true, state: 'monitoring', nextCheckAt: plan.nextCheckAt,
    monitoringUntil: plan.monitoringUntil, sendingResumed: false };
}
