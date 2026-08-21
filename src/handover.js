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
