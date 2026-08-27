export const CAMPAIGN_STATUS_CONTRACT_VERSION = 1;

const ACTIVE_ACTIVITIES = new Set(['starting', 'sending', 'introducing', 'checking', 'stopping']);

export function isCampaignStatusSnapshot(value) {
  return Boolean(value
    && Number(value.contractVersion) === CAMPAIGN_STATUS_CONTRACT_VERSION
    && String(value.campaignId || '').trim()
    && Number.isFinite(Number(value.sequence))
    && Number.isFinite(Number(value.observedAt)));
}

// A response that started earlier is allowed to arrive later, but it is never
// allowed to repaint the campaign. Sequence is engine-owned; observedAt breaks
// ties between two snapshots of the same durable transition.
export function selectCampaignStatusSnapshot(previous, incoming) {
  if (!isCampaignStatusSnapshot(incoming)) return isCampaignStatusSnapshot(previous) ? previous : null;
  if (!isCampaignStatusSnapshot(previous)) return incoming;
  if (String(previous.campaignId) !== String(incoming.campaignId)) return incoming;
  const previousSequence = Number(previous.sequence);
  const incomingSequence = Number(incoming.sequence);
  if (incomingSequence < previousSequence) return previous;
  if (incomingSequence === previousSequence && Number(incoming.observedAt) < Number(previous.observedAt)) return previous;
  return incoming;
}

function phaseFor(snapshot) {
  if (snapshot.lifecycle === 'monitoring' && snapshot.activity === 'waiting') return 'monitoring';
  if (snapshot.lifecycle === 'paused') return 'paused';
  if (snapshot.lifecycle === 'done' || snapshot.lifecycle === 'stopped') return 'done';
  if (snapshot.lifecycle === 'error') return 'error';
  return String(snapshot.activity || 'starting');
}

function currentActionFor(snapshot) {
  const phase = phaseFor(snapshot);
  const progress = snapshot.progress || {};
  const account = String(snapshot.currentAccount || '');
  const lead = String(snapshot.currentLead || '');
  const runtime = snapshot.runtime === 'local' ? 'This Mac' : 'Cloud VM';
  const checked = Number(progress.accountsChecked) || 0;
  const expected = Number(progress.accountsExpected) || 0;
  let facts;
  let milestones;

  if (phase === 'monitoring') {
    facts = [
      ['Monitoring', 'active'],
      ['Accounts checked', expected ? `${checked} of ${expected}` : 'waiting for the next check'],
      ['Next check', snapshot.next?.checkAt || 'being scheduled'],
      ['Operator action', snapshot.next?.action || 'none required'],
    ];
    milestones = [
      ['Last check', checked ? `${checked} checked` : 'complete', 'done'],
      ['Browsers', 'closed between checks', 'done'],
      ['Monitoring', 'active', 'active'],
      ['Next', snapshot.next?.checkAt ? 'check scheduled' : 'being scheduled', 'future'],
    ];
  } else if (phase === 'checking') {
    facts = [
      ['Check', 'running'],
      ['Current account', account || 'selecting'],
      ['Accounts checked', expected ? `${checked} of ${expected}` : `${checked}`],
      ['Runtime', runtime],
    ];
    milestones = [
      ['Requested', 'complete', 'done'],
      ['Browser', account ? 'open' : 'selecting', account ? 'done' : 'active'],
      ['Connections', snapshot.headline || 'reading', 'active'],
      ['Results', 'waiting', 'future'],
    ];
  } else if (phase === 'paused') {
    facts = [['Campaign state', 'paused safely'], ['Runtime', runtime], ['Next', snapshot.next?.action || 'resume when ready']];
    milestones = [['Queue', 'saved', 'done'], ['Campaign', 'paused', 'active'], ['Resume', 'continues safely', 'future']];
  } else if (phase === 'done' || phase === 'error') {
    facts = [['Campaign state', snapshot.lifecycle], ['Processed', `${Number(progress.completed) || 0}`], ['Remaining', `${Number(progress.pending) || 0}`], ['Next', snapshot.next?.action || 'none']];
    milestones = [['Campaign', snapshot.lifecycle, phase === 'error' ? 'active' : 'done']];
  } else {
    facts = [
      ['Current account', account || 'selecting'],
      ['Current lead', lead || 'selecting'],
      ['This batch', `${Number(progress.batchDone) || 0} of ${Number(progress.batchSize) || 0}`],
      ['Runtime', runtime],
    ];
    milestones = [
      ['Campaign', 'running', 'done'],
      ['Browser', account ? 'open' : 'selecting', account ? 'done' : 'active'],
      ['Lead', lead || 'selecting', 'active'],
      ['Result', 'waiting for verification', 'future'],
    ];
  }

  return {
    phase,
    label: String(snapshot.headline || ''),
    sub: String(snapshot.detail || ''),
    safety: String(snapshot.safety || ''),
    account,
    lead,
    selecting: lead,
    done: Number(progress.batchDone) || 0,
    total: Number(progress.batchSize) || 0,
    accountsDone: checked,
    facts,
    milestones,
  };
}

// This overlay deliberately leaves counts, logs and account pills on the
// existing object. The canonical snapshot owns lifecycle and live presentation;
// logs remain visible below the card but cannot drive its headline or phase.
export function overlayCampaignStatus(legacy, snapshot) {
  if (!isCampaignStatusSnapshot(snapshot)) return legacy;
  const lifecycle = String(snapshot.lifecycle || 'unknown');
  const activity = String(snapshot.activity || 'starting');
  const monitoring = lifecycle === 'monitoring';
  const active = ACTIVE_ACTIVITIES.has(activity);
  return {
    ...(legacy || {}),
    _canonicalStatusV1: snapshot,
    state: lifecycle,
    engineStatus: lifecycle,
    running: lifecycle === 'running' || monitoring,
    monitoring,
    monitoringPhase: monitoring,
    monitoringCheckInProgress: activity === 'checking',
    paused: lifecycle === 'paused',
    runsOn: snapshot.runtime === 'local' ? 'local' : 'vm',
    live: active,
    liveAccount: String(snapshot.currentAccount || ''),
    currentAction: currentActionFor(snapshot),
    nextCheckAt: snapshot.next?.checkAt || legacy?.nextCheckAt || null,
    resumeAt: snapshot.next?.resumeAt || legacy?.resumeAt || null,
  };
}
