import { computeMonitoringUntil, recomputeNextCheckAt } from './monitoring-time.js';

function _hhmm(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function _logTs(d) {
  return `[${d.toISOString()}]`;
}

export function transitionToMonitoring(campaign, { now, participatingProfileIds }) {
  if (campaign.state === 'monitoring' || campaign.state === 'done') return campaign;

  // v2.62: both connect-then-followup modes run a phase-2 monitoring loop —
  // CC+IC fires runAutoIntros, CC+DM fires runAutoDms (see runMonitoringCheck).
  // The caller gate (campaign.js) and the monitoring tick already route both;
  // this helper must accept both or CC+DM silently drops straight to 'done'.
  const monitoredMode = campaign.mode === 'connect_and_introduce' || campaign.mode === 'connect_and_message';
  if (!monitoredMode || !participatingProfileIds || participatingProfileIds.length === 0) {
    return { ...campaign, state: 'done' };
  }

  const sendingEndedAt = new Date(now);
  const monitoringUntil = computeMonitoringUntil(sendingEndedAt);
  const cadenceMin = campaign.checkIntervalMinutes || 60;
  const nextCheckAt = recomputeNextCheckAt(sendingEndedAt, sendingEndedAt, cadenceMin);
  const logs = [...(campaign.logs || []), `${_logTs(sendingEndedAt)} 🛏 Monitoring started · next check at ${_hhmm(nextCheckAt)} (cadence=${cadenceMin}m)`];

  return {
    ...campaign,
    state: 'monitoring',
    sendingEndedAt: sendingEndedAt.toISOString(),
    monitoringUntil: monitoringUntil.toISOString(),
    nextCheckAt: nextCheckAt.toISOString(),
    participatingProfileIds: [...participatingProfileIds],
    logs,
    // Persist the resolved cadence so post-restart rehydration uses it.
    checkIntervalMinutes: cadenceMin,
  };
}
