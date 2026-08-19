// What a cloud campaign that hasn't started yet should say.
//
// Today every wait renders as the single word "Queued": the two-minute cold
// start, someone else's campaigns holding all thirty slots, and a campaign that
// cannot send at all because its own accounts are capped or parked. Three
// different situations, one of which the operator must act on and two of which
// they must not. This decides which one is true.
//
// FACTS ONLY — deliberately no "starts in ~N min" for the queue wait. Campaign
// durations measured across the engine's own history on 2026-08-19 ran p50 5
// min, p90 2427 min, max 5762: nothing in that spread supports an estimate, and
// a wrong one teaches operators to distrust the card. The single time figure
// here is the worker cold start, which is a property of the pod and not a guess
// about anyone's campaign.
//
// DOM-free on purpose so the board strip, the campaign-tab card and the tests
// all read the same definition. Returns null when there is nothing to say.

/** An account that cannot send right now, and why. */
function blockedAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const atLimit = list.filter((a) => a && !a.parked && !a.needsLogin
    && Number(a.dailyLimit) > 0 && Number(a.dailyCount) >= Number(a.dailyLimit));
  const parked = list.filter((a) => a && a.parked);
  const needsLogin = list.filter((a) => a && a.needsLogin);
  return { atLimit, parked, needsLogin, total: list.length,
    blocked: atLimit.length + parked.length + needsLogin.length };
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// Not toLocaleString: its default locale differs between this app's Electron
// renderer and a bare node test run, so the same number rendered two ways and
// only one of them could be asserted.
function grouped(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/**
 * @param campaign  the board's campaign row — needs `id`, `status`, `leadCount`
 * @param capacity  GET /api/campaign/cloud-capacity — `queue`, `active`, `ceiling`, `full`
 * @param accounts  GET /api/campaign/cloud/:id/accounts, when the card has them
 * @returns {null|{kind,badge,line,note}} `line` and `note` may contain <b> only
 */
export function queueState(campaign = {}, capacity = {}, accounts = null) {
  if (!campaign || campaign.status !== 'queued') return null;

  const leads = Number(campaign.leadCount || campaign.leads || 0);
  const waiting = leads > 0 ? ` · <b>${grouped(leads)} leads</b> waiting` : '';

  // C first: an account-side block is the only one the operator can fix, and it
  // is true regardless of what the queue looks like. Only when EVERY account is
  // blocked — one live account is enough for the campaign to be merely waiting.
  const acc = blockedAccounts(accounts);
  if (acc.total > 0 && acc.blocked === acc.total) {
    const parts = [];
    if (acc.atLimit.length) parts.push(`<b>${acc.atLimit.length}</b> at the daily limit`);
    if (acc.parked.length) parts.push(`<b>${acc.parked.length}</b> parked`);
    if (acc.needsLogin.length) parts.push(`<b>${acc.needsLogin.length}</b> needing a login`);
    return {
      kind: 'accounts',
      badge: 'WAITING ON YOUR ACCOUNTS',
      line: `No account can send — ${parts.join(' · ')}${waiting}`,
      note: 'Nothing is ahead of you in the cloud — the hold-up is the accounts. '
        + 'Daily limits reset at midnight; a parked account needs a GoLogin login.',
    };
  }

  // Position is the engine's own FIFO order read back, not a guess. Absent from
  // the queue (or no capacity reading at all) → say nothing rather than invent.
  const queue = Array.isArray(capacity.queue) ? capacity.queue : [];
  const idx = queue.indexOf(campaign.id);
  if (capacity.unavailable || idx < 0) return null;

  const ahead = idx;
  const active = Number(capacity.active) || 0;
  const ceiling = Number(capacity.ceiling) || 0;

  if (ahead === 0 && !capacity.full) {
    return {
      kind: 'starting',
      badge: 'IN THE QUEUE',
      line: `Waking a VM worker — nothing ahead of you${waiting}`,
      note: 'A worker takes about two minutes to wake, so this is normal for the '
        + 'first couple of minutes after a launch. Nothing was lost, and you can close the app.',
    };
  }

  const load = ceiling ? ` — <b>${active} of ${ceiling}</b> campaigns running` : '';
  return {
    kind: 'queued',
    badge: ahead === 0 ? 'NEXT IN LINE' : `${ahead + 1}${ordinal(ahead + 1)} IN LINE`,
    line: `The cloud is full${load}${waiting}`,
    note: ahead === 0
      ? 'Yours is next. It starts by itself as soon as a slot frees — you don\'t need to do anything.'
      : `${plural(ahead, 'campaign', 'campaigns')} ahead of yours. It starts by itself as soon as a `
        + 'slot frees — you don\'t need to do anything.',
  };
}

/** 1ST, 2ND, 3RD, 4TH… the badge is uppercase, so these are too. */
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return 'TH';
  return ['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH';
}

/** The header strip's VM tile: how much of the cloud is actually awake.
 *
 * Deliberately NOT a RAM/CPU gauge. The VM is not a machine that is always on —
 * it is GKE pods that scale to ZERO when no campaign needs them, so a memory
 * figure would be blank or invented for most of the day. Deliberately not a bare
 * slot count either: the ceiling is 30 and the highest ever recorded is 4, so
 * "0 of 30" would read the same forever and teach the operator to ignore it.
 *
 * Pods awake answers both useful questions at once — 0/6 means asleep (normal,
 * and costing nothing), 6/6 means genuinely full and the next campaign queues.
 *
 * `live` is whether any cloud campaign is running/queued/monitoring. When
 * nothing is, pods are zero BY DEFINITION and the caller must not spend a
 * request to confirm it — the board poll is already at the browser's six-
 * connections-per-host limit.
 *
 * Returns { text, cls, title }. cls is '' | 'warn' | 'err' | 'small'.
 */
export function vmCapacityTile(capacity = {}, live = false) {
  const cap = capacity || {};
  if (!live) {
    return { text: 'ASLEEP', cls: 'small',
      title: 'No cloud campaign is running, so the VM has scaled to zero. It wakes by itself when one starts.' };
  }
  if (cap.unavailable) {
    return { text: '—', cls: 'small',
      title: 'Could not reach the VM to ask how busy it is. This says nothing about whether your campaigns are running.' };
  }
  const busy = Number(cap.podsBusy) || 0;
  const max = Number(cap.maxPods) || 0;
  if (!max) {
    return { text: '—', cls: 'small',
      title: 'The VM did not report how many workers it can run.' };
  }
  const active = Number(cap.active) || 0;
  const ceiling = Number(cap.ceiling) || 0;
  const slots = ceiling ? ` · ${active} of ${ceiling} campaign slot${ceiling === 1 ? '' : 's'} in use` : '';
  // `full` is the engine's own answer, not ours to recompute — it is what
  // decides whether a new campaign queues.
  const cls = cap.full ? 'err' : (busy >= max - 1 ? 'warn' : '');
  const title = cap.full
    ? `Every VM worker is busy — a campaign started now waits for a slot${slots}.`
    : `${busy} of ${max} VM worker${max === 1 ? '' : 's'} awake${slots}. Workers scale to zero when idle.`;
  return { text: `${busy}/${max}`, cls, title };
}
