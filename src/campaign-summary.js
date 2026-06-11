/**
 * src/campaign-summary.js — net-new, pure. Turns a campaign's live state +
 * tally (see campaign-tally.js) into ONE Dashboard row for the Ops Log
 * "Dashboard" tab: status, what it's doing, progress, and the top issue in
 * plain English ("why"). No Puppeteer, no I/O — fully unit-testable.
 */

// Issue priority: most actionable first. Each maps a reason pattern to a
// plain-English explanation and whether it needs human action ('need') or is
// auto-handled/slow ('slow').
const ISSUE_RULES = [
  { re: /session expired|logged out/i, sev: 'need', why: 'An account got logged out — log back in to continue.' },
  { re: /not in your connections|^failed|compose page/i, sev: 'need', why: "An introduction failed — the account isn't connected to the primary yet." },
  { re: /weekly limit|invitation limit/i, sev: 'slow', why: "An account hit this week's LinkedIn invite limit — it resumes automatically next week." },
  { re: /429|rate.?limit/i, sev: 'slow', why: 'LinkedIn is throttling sends to stay safe — that’s why most leads aren’t reached yet.' },
  { re: /wrong person/i, sev: 'need', why: 'LinkedIn opened the wrong profile — skipped for safety; worth a look.' },
  { re: /inmail credits/i, sev: 'slow', why: 'Out of InMail credits for this account.' },
  { re: /legacy sales nav|sales nav link/i, sev: 'slow', why: "Some leads have old Sales Navigator links that don't open." },
];

const STATUS_LABEL = {
  need: '🔴 Needs you',
  slow: '🟡 Slowed',
  ok: '🟢 Healthy',
  done: '⚪ Done',
};

function doingNow({ mode, ended, endReason, intro, dm, processed, total }) {
  if (ended) return `Finished${endReason ? ` — ${endReason}` : ''}`;
  let verb;
  switch (mode) {
    case 'connect_only': verb = 'Sending connection requests'; break;
    case 'connect_and_introduce': verb = intro > 0 ? 'Introducing accepted leads' : 'Sending requests, then introducing'; break;
    case 'connect_and_message': verb = dm > 0 ? 'Messaging accepted leads' : 'Sending requests, then messaging'; break;
    case 'introduce_back': verb = 'Introducing'; break;
    case 'message_only': verb = 'Sending messages'; break;
    case 'check_status': verb = 'Checking acceptances'; break;
    default: verb = mode || 'Running';
  }
  return `${verb} — ${processed} of ${total}`;
}

/** Pick the highest-priority issue present in the tally's byReason map. */
function topIssue(tally) {
  const reasons = Object.keys(tally.byReason || {});
  for (const rule of ISSUE_RULES) {
    const hit = reasons.find((r) => rule.re.test(r));
    if (hit) return { label: hit, sev: rule.sev, why: rule.why, count: tally.byReason[hit] };
  }
  return null;
}

/**
 * @param {object} c - { name, operator, mode, ended, endReason, totalTargets,
 *                       processed, tally }
 * @returns {object} dashboard row fields
 */
export function summariseCampaign(c = {}) {
  const tally = c.tally || { sent: 0, accepted: 0, intro: 0, dm: 0, errors: 0, parked: 0, rateLimited: 0, skipped: 0, byReason: {} };
  const total = Number(c.totalTargets || 0);
  const processed = Number(c.processed || 0);
  const top = topIssue(tally);

  let status;
  if (c.ended) status = 'done';
  else if (top && top.sev === 'need') status = 'need';
  else if (top && top.sev === 'slow') status = 'slow';
  else status = 'ok';

  const issuesCount = Object.keys(tally.byReason || {}).length;

  return {
    status,
    statusLabel: STATUS_LABEL[status],
    campaign: c.name || '',
    operator: c.operator || '',
    doingNow: doingNow({ mode: c.mode, ended: c.ended, endReason: c.endReason, intro: tally.intro, dm: tally.dm, processed, total }),
    progress: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    sent: tally.sent || 0,
    accepted: tally.accepted || 0,
    issues: issuesCount,
    topIssue: top ? top.label : '',
    why: top ? top.why : '',
  };
}
