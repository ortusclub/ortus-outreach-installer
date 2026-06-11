/**
 * src/linkedin/outcome-classify.js — net-new, pure. Maps the campaign loop's
 * per-lead result ({action, reason, mode}) to the logging/funnel vocabulary
 * used by the Operations Log (Events tab) and the Campaign Activity scorecard.
 *
 * Never throws; unknown inputs fall through to a safe { skipped, unknown }
 * classification so a new action name can't crash the loop. The action set
 * mirrors campaign.js buildSheetDataForAction + SUCCESS_ACTIONS; the reason
 * strings mirror the real "Skipped: <reason>" values the loop produces.
 *
 *   phase:   Request | Accept | Intro | DM | OpenProfile | InMail | Account
 *   outcome: sent | accepted | pending | rate_limited | parked | skipped | error
 */

const SENT_BY_ACTION = {
  connection_sent: 'Request',
  op_message_sent: 'OpenProfile',
  inmail_sent:     'InMail',
};

// Reason → { outcome, phase, label }. First substring match wins. `label`
// normalises noisy reason text into a stable bucket for the leak views.
const REASON_RULES = [
  { match: /429|rate.?limit/i,                 outcome: 'rate_limited', phase: 'Request', label: 'Rate-limited (HTTP 429)' },
  { match: /weekly limit|invitation limit/i,   outcome: 'parked',       phase: 'Account', label: 'Weekly limit reached' },
  { match: /session expired/i,                 outcome: 'skipped',      phase: 'Account', label: 'Session expired' },
  { match: /inmail credits/i,                  outcome: 'skipped',      phase: 'InMail',  label: 'InMail credits exhausted' },
  { match: /legacy sales nav|sales nav link/i, outcome: 'skipped',      phase: 'Request', label: 'Legacy Sales Nav URL' },
];

function phaseForMessage(mode) {
  if (mode === 'introduce_back' || mode === 'connect_and_introduce') return 'Intro';
  return 'DM';
}

export function classifyOutcome({ action = '', reason = '', mode = '' } = {}) {
  const a = String(action);
  const r = String(reason || '').trim();

  // ── Successes ──
  if (a === 'connection_sent')   return { phase: 'Request', outcome: 'sent', reason: '' };
  if (a === 'message_sent')      return { phase: phaseForMessage(mode), outcome: 'sent', reason: '' };
  if (SENT_BY_ACTION[a])         return { phase: SENT_BY_ACTION[a], outcome: 'sent', reason: '' };
  if (a === 'status_accepted' || a === 'already_connected')
    return { phase: 'Accept', outcome: 'accepted', reason: '' };
  if (a === 'status_pending')    return { phase: 'Accept', outcome: 'pending', reason: '' };
  if (a === 'already_processed') return { phase: 'Request', outcome: 'sent', reason: '' };

  // ── Failures / skips — classify by reason ──
  if (a === 'error' || a === 'skip' || a === 'status_declined' || r) {
    for (const rule of REASON_RULES) {
      if (rule.match.test(r)) return { phase: rule.phase, outcome: rule.outcome, reason: rule.label };
    }
    if (a === 'error') {
      return { phase: mode === 'connect_and_introduce' ? 'Intro' : 'Request', outcome: 'error', reason: r };
    }
    return { phase: 'Request', outcome: 'skipped', reason: r };
  }

  return { phase: 'Request', outcome: 'skipped', reason: r || 'unknown' };
}
