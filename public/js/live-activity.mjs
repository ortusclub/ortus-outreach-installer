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

// How long a wake may take before the "~2 min" estimate stops being honest.
// Pod boot measured 65-98s on 2026-07-30; 5 min is comfortably above that.
const WAKING_OVERRUN_MS = 5 * 60 * 1000;
// Above the longest observed sweep (3m16s) and below the engine's 45-minute
// monitor reap, so "auto-recovers" is true whenever this fires.
const CHECKING_OVERRUN_MS = 15 * 60 * 1000;

/**
 * The monitoring hero's state, derived once and shared by every surface.
 *
 *   'counting' — a check is scheduled; show the countdown
 *   'waking'   — the task is DUE but unclaimed; KEDA is booting a worker
 *   'checking' — a worker holds the task; a sweep is running
 *
 * `overrun` means the state has outlasted its promise and the caption should
 * say so instead of repeating an estimate that has stopped being true.
 *
 * Absent task fields (older engine, failed detail fetch) → 'counting'. Never
 * invent a wake.
 */
export function monitorHeroState(status, now = Date.now()) {
  if (!status) return { state: 'counting', overrun: false };

  const claimed = status.monitorTaskStatus === 'claimed' || !!status.monitoringCheckInProgress;
  if (claimed) {
    const started = Date.parse(status.monitorCheckStartedAt || '');
    return {
      state: 'checking',
      overrun: Number.isFinite(started) && (now - started) > CHECKING_OVERRUN_MS,
    };
  }

  const due = Date.parse(status.monitorTaskDueAt || '');
  if (status.monitorTaskStatus === 'pending' && Number.isFinite(due) && now >= due) {
    return { state: 'waking', overrun: (now - due) > WAKING_OVERRUN_MS };
  }

  return { state: 'counting', overrun: false };
}

/**
 * What the monitoring hero should DISPLAY — the big value, its caption, and the
 * state class — for a given status. One helper so every surface renders the same
 * thing.
 *
 * This exists because they didn't. The expanded board card is a cloneNode(true)
 * of the live card #2 DOM, so it inherits card #2's caption text and state class
 * at clone time; its own filler refreshed only the number. When card #2 was
 * mid-sweep the board card froze at caption "now" in checking-gold while its
 * countdown ticked on beside it — operator screenshot 2026-07-31 showing
 * "52:05 NOW" in gold. Any renderer that sets the number must set the caption
 * and the class from the SAME decision, so they cannot drift again.
 *
 * `fmtCountdown` is injected because the formatter lives in app.js; pass a
 * function taking milliseconds-remaining.
 */
export function monitorHeroView(status, fmtCountdown, now = Date.now()) {
  const hero = monitorHeroState(status, now);
  if (hero.state === 'checking') {
    return {
      count: 'CHECKING',
      cap: hero.overrun ? 'sweep looks stalled — auto-recovers' : 'now',
      state: 'checking',
    };
  }
  if (hero.state === 'waking') {
    return {
      count: 'WAKING',
      cap: hero.overrun ? 'still waking — worker hasn’t picked it up' : 'sweeping in ~2 min',
      state: 'waking',
    };
  }
  return {
    count: status && status.nextCheckAt
      ? fmtCountdown(new Date(status.nextCheckAt).getTime() - now)
      : '—',
    cap: 'until next check',
    state: 'counting',
  };
}

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
    const hero = monitorHeroState(status);
    if (hero.state === 'checking') {
      return {
        state: 'checking',
        icon: '↻',
        l1: 'Checking for new acceptances…',
        l2: hero.overrun
          ? 'sweep looks stalled — auto-recovers'
          : (account ? `${account} · sweeping recent connections` : 'sweeping recent connections'),
      };
    }
    const n = (status.participatingProfileIds || status.profileIds || []).length;
    const cadMin = Number(status.checkIntervalMinutes) || 60;
    const cad = cadMin >= 60 ? `${cadMin / 60}h` : `${cadMin} min`;
    const acctStr = n ? `${n} account${n === 1 ? '' : 's'} · ` : '';
    if (hero.state === 'waking') {
      // The worker is scale-to-zero between sweeps, so a due check spends ~2 min
      // waiting for a pod. Saying "nothing running right now" here would be the
      // false line that made the 2026-07-30 stall unreadable.
      return {
        state: 'waking',
        icon: '◍',
        l1: 'Waking a worker',
        l2: hero.overrun ? 'still waking — worker hasn’t picked it up' : 'sweeping in ~2 min',
      };
    }
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
