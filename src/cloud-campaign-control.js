import { stopCloudPrimaryTasks } from './primary-task-control.js';
import { cloudTaskControl, resumeCloudTaskOwner, recordCloudControlReceipt, clearEmptyStoppedCloudControl, confirmEmptyCloudStopFromVm } from './primary-tasks.js';

// The VM receipt covers VM work only. A full campaign receipt must also report
// this app's delegated work. Never roll back local protection on a network error.
export async function stopCloudWithLocalTasks(id, options, deps) {
  const local = options.keepMonitoring
    ? Promise.resolve({ stopped: true, preservedForMonitoring: true })
    : stopCloudPrimaryTasks(id, { pause: options.pause, file: deps.file, timeoutMs: deps.timeoutMs });
  const remote = Promise.resolve().then(() => deps.stopRemote(id, options));
  const [l, r] = await Promise.allSettled([local, remote]);
  const delegated = l.status === 'fulfilled' ? l.value : { stopped: false, error: l.reason?.message || String(l.reason) };
  const vm = r.status === 'fulfilled' && r.value ? r.value : { error: r.reason?.message || 'VM did not return a receipt' };
  const remoteConfirmed = !vm.error && vm.ok !== false && !vm.stopping
    && ['paused', 'cancelled', 'done', 'monitoring'].includes(vm.status || vm.campaign?.status);
  if (delegated.commandId) {
    try { await recordCloudControlReceipt(id, delegated.commandId, remoteConfirmed && delegated.stopped, deps.file); }
    catch (error) { delegated.stopped = false; delegated.error = `Could not save shutdown receipt: ${error.message}`; }
  }
  const confirmed = remoteConfirmed && delegated.stopped;
  return { ...vm, delegated, ok: confirmed,
    pending: !!vm.pending || (!confirmed && !vm.error),
    stopping: !confirmed };
}

export async function withLocalCloudControl(snapshot, file) {
  if (!snapshot || snapshot.error) return snapshot;
  const decorate = async campaign => {
    if (!campaign?.id) return campaign;
    let marker;
    try { marker = await cloudTaskControl(campaign.id, file); }
    catch (error) {
      return { ...campaign, vmStatus: campaign.status, status: 'stopping',
        delegatedStopUnconfirmed: true, stopConfirmed: false, localControlError: error.message };
    }
    if (!marker || marker.shutdownConfirmed === true) return campaign;
    if (marker.status === 'stopped' && campaign.status === 'cancelled'
      && await confirmEmptyCloudStopFromVm(campaign.id, marker.commandId, file)) return campaign;
    return { ...campaign, vmStatus: campaign.status,
      status: marker.status === 'paused' ? 'pausing' : 'stopping',
      delegatedStopUnconfirmed: true, stopConfirmed: false };
  };
  if (snapshot.campaign) return { ...snapshot, campaign: await decorate(snapshot.campaign) };
  if (Array.isArray(snapshot.campaigns)) return { ...snapshot, campaigns: await Promise.all(snapshot.campaigns.map(decorate)) };
  return snapshot;
}

export async function resumeCloudWithLocalTasks(id, deps) {
  let before = await cloudTaskControl(id, deps.file);
  if (before?.status === 'stopped') {
    // A failed or superseded Stop can leave this local marker behind even
    // though the VM is still paused. The operator's explicit Resume may clear
    // it only when there are no delegated tasks whose Stop was irreversible.
    const snapshot = await deps.getRemote?.(id);
    const vm = snapshot?.campaign || snapshot;
    if (vm?.status !== 'paused') {
      return { ok: false, error: 'The VM no longer reports this campaign as paused. Refresh its state before resuming; nothing was started.', conflict: true };
    }
    if (!(await clearEmptyStoppedCloudControl(id, before.commandId, deps.file))) {
      return { ok: false, error: 'The VM is paused, but a local Stop record still protects campaign work. Resume needs a recovery review; nothing was started.', conflict: true };
    }
    before = null;
  }
  const remote = await deps.resumeRemote(id);
  if (remote?.error || remote?.ok === false || remote?.status !== 'running') return remote || { ok: false, error: 'VM did not confirm Resume' };
  const resumed = await resumeCloudTaskOwner(id, before?.commandId, deps.file);
  if (!resumed) return { ...remote, ok: false, conflict: true, error: 'A newer Pause or Stop superseded Resume. Local background work remains blocked.' };
  return { ...remote, delegatedResumed: true };
}
