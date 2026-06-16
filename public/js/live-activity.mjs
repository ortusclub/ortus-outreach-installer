// v2.59.19 — turn an /api/campaign/status snapshot into the card's "live line":
// WHAT the campaign is doing right now. Mode-agnostic — reads the same
// currentAction / currentProfile / nextCheckAt the backend sends for every
// mode, so it works identically for connect_only, CC+DM, message_only, etc.
//
// Returns { state, icon, l1, l2 }:
//   state — 'sending' | 'monitoring' | 'checking' | 'paused' | 'idle'
//   icon  — a glyph for the state
//   l1    — the main "what it's doing" line (the REAL backend action label
//           when sending — never invented)
//   l2    — sub-detail (account · lead, or cadence info)

export function buildLiveActivity(status) {
  if (!status) return { state: 'idle', icon: '', l1: 'No campaign running', l2: '' };

  if (status.phase === 'preflight') {
    const conn = status.primaryConn || {};
    const ids = (status.profileIds || []).filter((id) => id && id !== 'local-browser' && conn[id]);
    const accepted = ids.filter((id) => conn[id] === 'connected').length;
    return {
      state: 'checking',
      icon: '↻',
      l1: 'Preparing introductions — primary handshake',
      l2: `${accepted} of ${ids.length} connected · outreach starts when ready`,
    };
  }

  const monitoring = !status.running && status.state === 'monitoring';
  const paused = !!(status.paused || status._paused);
  const ca = status.currentAction || null;
  const account = (ca && ca.account) || status.currentProfile || '';
  const lead = (ca && ca.lead) || '';

  if (monitoring) {
    if (status.monitoringCheckInProgress) {
      return {
        state: 'checking',
        icon: '↻',
        l1: 'Checking for new acceptances…',
        l2: account ? `${account} · sweeping recent connections` : 'sweeping recent connections',
      };
    }
    const n = (status.participatingProfileIds || status.profileIds || []).length;
    const cadMin = Number(status.checkIntervalMinutes) || 60;
    const cad = cadMin >= 60 ? `${cadMin / 60}h` : `${cadMin} min`;
    const acctStr = n ? `${n} account${n === 1 ? '' : 's'} · ` : '';
    return {
      state: 'monitoring',
      icon: '◷',
      l1: 'Waiting for next check',
      l2: `${acctStr}checks every ${cad} · nothing running right now`,
    };
  }

  if (status.running) {
    if (paused) {
      return {
        state: 'paused',
        icon: '‖',
        l1: 'Paused — finishes the current lead, then waits',
        l2: 'resumes instantly · browsers stay open',
      };
    }
    return {
      state: 'sending',
      icon: '→',
      l1: (ca && ca.label) || 'Working…',
      l2: [account, lead].filter(Boolean).join(' · '),
    };
  }

  return { state: 'idle', icon: '', l1: 'No campaign running', l2: '' };
}
