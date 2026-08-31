import { monitoringRecovery } from './monitor-sweep-summary.mjs';

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

// A check time an operator can read.
//
// The engine sends `next.checkAt` as an ISO string, and this file printed it
// straight into the card: "NEXT CHECK  2026-08-28T10:28:49.180Z" (operator
// screenshot, 2026-08-28). The other monitoring renderer has always said
// "today at 12:36"; only the campaign this contract is enabled for was showing
// the raw value. Same wording here, and it no longer says "today" about a check
// that is scheduled for tomorrow.
export function nextCheckLabel(value, now = Date.now()) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return 'being scheduled';
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(new Date(now))) / 86400000);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  if (days === -1) return `yesterday at ${clock}`;
  return `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${clock}`;
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
  const pending = Number(progress.pending) || 0;
  const nextCheck = nextCheckLabel(snapshot.next?.checkAt);
  // A sweep that did not reach every account. The engine sends the raw error;
  // the recovery copy that turns "damiano@ortus.solutions — needs re-login"
  // into "Damiano's LinkedIn session expired · Log Damiano back into LinkedIn in
  // GoLogin, then retry this check" already exists in this app and the canonical
  // path simply never called it. The snapshot owns the STATE; the wording stays
  // where the wording has always been.
  const checkError = String(snapshot.next?.checkError || '').trim();
  const recovery = (expected > 0 && checked < expected && checkError)
    ? monitoringRecovery(checkError) : null;
  let facts;
  let milestones;
  let label = String(snapshot.headline || '');
  let sub = String(snapshot.detail || '');
  // "N pending leads remain safe" is true but incomplete: what an operator needs
  // to know is that those leads are not moving. The older card has always said
  // so, and dropping the clause is how the same fact stops being actionable.
  let safety = String(snapshot.safety || '');
  if (phase === 'monitoring' && pending > 0) {
    safety = `${pending} pending lead${pending === 1 ? '' : 's'} remain safely queued · sending is stopped`;
  }

  if (phase === 'monitoring' && recovery) {
    // Monitoring continues, but a card that leads with "monitoring is active,
    // no browser remains open" while an account is locked out is complacent —
    // it was showing exactly that beside "Review the named account, then retry".
    label = recovery.headline;
    sub = `${checked} of ${expected} accounts were checked · ${recovery.detail}`;
    facts = [
      ['Last check', `${checked} of ${expected} accounts`],
      ['Result', recovery.result],
      ['Next check', nextCheck],
      ['Operator action', recovery.action],
    ];
    milestones = [
      ['Last check', `${checked} checked`, 'done'],
      ['Browsers', 'closed between checks', 'done'],
      ['Unavailable', `${Math.max(0, expected - checked)} not checked`, 'active'],
      ['Next', nextCheck, 'future'],
    ];
  } else if (phase === 'monitoring') {
    facts = [
      // The same four the older monitoring card has always shown, with the
      // engine's real counts rather than that card's optimistic literals: it
      // hardcodes "complete" and falls back to the full account count, so a
      // sweep that reached nobody still reported "3 of 3".
      ['Last check', expected ? 'complete' : 'not run yet'],
      ['Accounts checked', expected ? `${checked} of ${expected}` : 'waiting for the next check'],
      ['Next check', nextCheck],
      ['Operator action', 'none required'],
    ];
    milestones = [
      ['Last check', expected ? 'complete' : 'not run yet', expected ? 'done' : 'future'],
      ['Accounts', expected ? `${checked} checked` : 'checked each sweep', expected ? 'done' : 'future'],
      ['Browsers', 'closed between checks', 'done'],
      ['Waiting', `next check ${nextCheck}`, 'active'],
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
    label,
    sub,
    safety,
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
