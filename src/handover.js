// Pure decisions behind moving a campaign between the VM and this Mac.
//
// Kept out of server.js so the ORDER of operations is testable. That order is the
// whole safety story: the target side may not start until the source is confirmed
// stopped. Two sides sweeping at once both read Introduction Status blank, and the
// same lead gets two intro DMs.

// Which leads must the new side skip? Everything the old side already finished.
// `pending` and `in_progress` are both still-to-do: the operator chose to RETRY the
// lead that was in flight rather than drain it, accepting that a lead the old side
// had actually sent may get a second connect request.
export function processedLeadUrls(leads) {
  return (Array.isArray(leads) ? leads : [])
    .filter((l) => l && l.leadUrl && l.status !== 'pending' && l.status !== 'in_progress')
    .map((l) => l.leadUrl);
}

// Which local path a moved campaign belongs on.
//
// Routed on what the campaign has LEFT, never on its status string: a campaign
// moved mid-send must carry on sending here, and a campaign that has sent
// everything must be adopted straight into monitoring. Sending a campaign with
// nothing left through startCampaign is not a no-op, it is a stranding: the loop
// finds 0 targets, transitionToMonitoring sees nobody sent, and the campaign
// lands on 'done' while the VM has already released it.
export function handoverTarget(leads) {
  const stillToDo = (Array.isArray(leads) ? leads : [])
    .filter((l) => l && (l.status === 'pending' || l.status === 'in_progress'));
  return stillToDo.length > 0 ? 'send' : 'monitor';
}

// A campaign already in monitoring has deliberately ended its sending phase,
// even when some leads remain pending (for example while all senders are
// blocked until a later retry window). Preserve that authoritative phase during
// handover so moving monitoring never resurrects outreach on the destination.
export function handoverTargetForCampaign(status, leads) {
  return String(status || '').toLowerCase() === 'monitoring'
    ? 'monitor'
    : handoverTarget(leads);
}

// The same question for the other direction. A local campaign keeps no per-lead
// table the way the engine does: the SHEET is its ledger, stamped as it goes. So
// "what did this Mac already do" is "which rows carry a status".
//
// Deliberately mode-agnostic and deliberately greedy: ANY non-blank status column
// excludes the row. That mirrors the local send loop's own rule (process iff the
// stage/status cell is blank, campaign.js _isTarget) and errs towards contacting
// nobody twice, which is the only direction this feature may err in.
const STATUS_COLUMNS = [
  'Stage', 'Status',
  'Connection Request Status', 'Connection Status', 'Connected Status',
  'Connection Accepted Status',
  'Intro Status', 'Introduction Status',
  'DM Status',
];
export function sheetProcessedUrls(rows, urlOf) {
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row) continue;
    const url = String((typeof urlOf === 'function' ? urlOf(row) : '') || '').trim();
    if (!url) continue;
    const touched = STATUS_COLUMNS.some((h) => {
      const v = row[h] != null ? row[h] : row[h.toLowerCase()];
      return String(v == null ? '' : v).trim() !== '';
    });
    if (touched) out.push(url);
  }
  return out;
}

// Does this Mac hold a campaign the VM can take BACK, rather than one it would
// have to be given from scratch? adoptMonitoring stamps the engine's campaign id
// onto the campaign global (it is one of MONITORING_FIELDS); a campaign started
// here keeps the singleton id, and startCampaign restores that id on every fresh
// run, so a stale cloud id can never leak into a later local campaign.
export function reclaimableCloudId(campaign, singletonId) {
  const id = campaign && campaign.id;
  return id && id !== singletonId ? String(id) : '';
}

// The engine's two refusals, and what this side does about each.
//
// A refusal must leave the campaign exactly where it was, so the default is to
// keep monitoring here. `not_local` is the one exception and it is not really a
// refusal: the VM already owns the campaign, so it is THIS side that is the
// extra owner, and leaving both armed is the two-sweeps-one-intro case the whole
// feature exists to prevent.
export function reclaimRefusal(reason) {
  if (reason === 'not_local') {
    return {
      stopLocal: true,
      error: 'That campaign is already running on the Cloud VM, so there was nothing to move. This Mac has stopped watching it, so the two sides cannot check the same leads at once.',
    };
  }
  if (reason === 'not_resumable') {
    return {
      stopLocal: false,
      error: 'The VM will not take that campaign back: it is finished or cancelled there, so it cannot be resumed. Start a fresh campaign on the VM instead. Nothing changed here.',
    };
  }
  return { stopLocal: false, error: 'The VM did not take the campaign back, so nothing changed here.' };
}

// The fixed sequence. Returned as data so a test can assert the order without
// running any of it.
export function handoverPlan({ from, to }) {
  if (!to || from === to) return [];
  return [
    { kind: 'release-source', from },
    { kind: 'read-sheet' },
    { kind: 'start-target', to },
    { kind: 'reset-cadence' },
  ];
}
