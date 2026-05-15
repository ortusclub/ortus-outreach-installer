import { computeMonitoringUntil, recomputeNextCheckAt } from './monitoring-time.js';

function _hhmm(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function _logTs(d) {
  return `[${d.toISOString()}]`;
}

export function transitionToMonitoring(campaign, { now, participatingProfileIds }) {
  if (campaign.state === 'monitoring' || campaign.state === 'done') return campaign;

  if (campaign.mode !== 'connect_and_introduce' || !participatingProfileIds || participatingProfileIds.length === 0) {
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
