import { usesMonitoringCadence, isRetiredMode } from './campaign-modes.mjs';

// One vocabulary for controls on cards, paused campaigns and stop dialogs.
// A one-off check is deliberately not described as enabling a schedule.
export function continuationPolicy(mode) {
  const acceptance = usesMonitoringCadence(mode);
  const action = mode === 'connect_and_message' ? 'direct messages' : 'introductions';
  return {
    acceptance,
    retired: isRetiredMode(mode),
    remaining: 'Resume remaining work',
    remainingDetail: 'Continue eligible unfinished work. Confirmed actions stay recorded; uncertain outcomes remain held for review. Configured later phases can still run.',
    checkLabel: 'One acceptance check; keep sending paused',
    monitoringDetail: acceptance
      ? `No new invitations. Acceptance checks can send configured ${action} and follow-ups. This is not read-only.`
      : 'This campaign has no supported acceptance-monitoring phase. Full Stop remains available.',
    scopeDetail: 'Choose this campaign’s accounts or all matching senders in the current sheet tab for every scheduled check.',
  };
}

export async function requestConfirmedResume(fetcher, url, options) {
  const response = await fetcher(url, options);
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || 'Resume was not confirmed. Refresh the campaign before retrying.');
  return body;
}
