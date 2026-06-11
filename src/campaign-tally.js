/**
 * src/campaign-tally.js — net-new, pure. Accumulates a run's funnel + leak
 * counters from classified lead outcomes (see linkedin/outcome-classify.js).
 * The returned object is JSON-serialisable and shipped in the Campaign
 * Activity row (campaignLogAppendRun entry).
 */
export function emptyTally() {
  return {
    sent: 0, accepted: 0, intro: 0, dm: 0, replied: 0,
    rateLimited: 0, parked: 0, skipped: 0, errors: 0,
    byReason: {},
  };
}

export function applyOutcome(t, cls) {
  const base = t || emptyTally();
  const n = { ...base, byReason: { ...base.byReason } };
  const { phase = '', outcome = '', reason = '' } = cls || {};

  if (outcome === 'sent') {
    n.sent += 1;
    if (phase === 'Intro') n.intro += 1;
    if (phase === 'DM') n.dm += 1;
  } else if (outcome === 'accepted') {
    n.accepted += 1;
  } else if (outcome === 'rate_limited') {
    n.rateLimited += 1;
  } else if (outcome === 'parked') {
    n.parked += 1;
  } else if (outcome === 'error') {
    n.errors += 1;
  } else if (outcome === 'skipped') {
    n.skipped += 1;
  }

  if (reason && (outcome === 'skipped' || outcome === 'rate_limited' || outcome === 'parked' || outcome === 'error')) {
    n.byReason[reason] = (n.byReason[reason] || 0) + 1;
  }
  return n;
}
