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
/** "1h" / "30 min" — the form the monitoring card has always used. */
export function cadenceLabel(min) {
  const n = Number(min) || 60;
  return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n} min`;
}

/**
 * Is this campaign checking less often than its operator asked for?
 *
 * The app deliberately does NOT carry the cadence table — the engine sends the
 * effective interval and the base one, and slowed is simply the difference. Two
 * copies of that table would eventually disagree, and the card would confidently
 * describe a slowdown that was not happening.
 */
export function checkSlowdown(status) {
  const eff = Number(status && status.checkIntervalMinutes) || 0;
  const base = Number(status && status.checkIntervalBaseMinutes) || 0;
  if (!eff || !base || eff <= base) return null;
  return { eff, base, streak: Math.max(0, Number(status.emptyCheckStreak) || 0) };
}

/**
 * The cadence phrase for the COLLAPSED board strip's one-line monitoring
 * summary — `{label} {value}`, so the caller can bold the value as it always has.
 *
 * Not slowed → byte-identical to what that line has always printed
 * (`every 60m`). Slowed → the hero caption's own words (`slowed to 4h`), because
 * the strip used to print the slowed interval as `every 4h` and there is nothing
 * in that sentence to tell the operator it wasn't the setting they chose.
 * Same checkSlowdown / cadenceLabel as the hero — no second copy of anything.
 */
export function stripCadence(status) {
  const slow = checkSlowdown(status);
  return slow
    ? { label: 'slowed to', value: cadenceLabel(slow.eff) }
    : { label: 'every', value: `${Number(status && status.checkIntervalMinutes) || 60}m` };
}

export function monitorHeroState(status, now = Date.now()) {
  if (!status) return { state: 'counting', overrun: false };

  const claimed = status.monitorTaskStatus === 'claimed' || !!status.monitoringCheckInProgress;
  if (claimed) {
    const started = Date.parse(status.monitorCheckStartedAt || '');
    const completed = Date.parse(status.monitorCheckCompletedAt || '');
    // A manual "check now" request can be active before the engine writes a new
    // started timestamp. Do not measure that request against the PREVIOUS
    // sweep's timestamp or a perfectly normal VM wake-up is labelled stalled.
    const currentStart = Number.isFinite(started)
      && (!Number.isFinite(completed) || started > completed);
    return {
      state: 'checking',
      overrun: currentStart && (now - started) > CHECKING_OVERRUN_MS,
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
  // A sweep in flight or a worker waking outranks the slowdown — both branches
  // above return first. Here the number IS a countdown, so the caption may name
  // what it is counting toward.
  const slow = checkSlowdown(status);
  return {
    count: status && status.nextCheckAt
      ? fmtCountdown(new Date(status.nextCheckAt).getTime() - now)
      : '—',
    cap: slow ? `next check · slowed to ${cadenceLabel(slow.eff)}` : 'until next check',
    state: 'counting',
  };
}

/**
 * What the 1-second display tick should write into a monitoring countdown —
 * or null meaning "leave the number alone".
 *
 * Two callers tick a countdown once a second (the campaign-tab card and each
 * expanded board strip) and both need the same two refusals:
 *
 *   - while the hero reads CHECKING or WAKING the number on screen is a STATE
 *     WORD, not a countdown; overwriting it every second is what produced a
 *     ticking "52:05" under a gold "now" caption.
 *   - with no nextCheckAt there is nothing to count toward, so show a dash
 *     rather than a countdown to the epoch.
 *
 * @param {object} o
 * @param {string|number|null} o.nextCheckAt  when the next sweep is due
 * @param {boolean} o.busy                    hero is showing CHECKING/WAKING
 * @param {(ms:number)=>string} o.fmtCountdown
 * @param {number} [o.now]
 * @returns {string|null} text to write, or null to leave the DOM untouched
 */
export function monitorTickText({ nextCheckAt, busy, fmtCountdown, now = Date.now() }) {
  if (busy) return null;
  if (!nextCheckAt) return '—';
  const at = typeof nextCheckAt === 'number' ? nextCheckAt : new Date(nextCheckAt).getTime();
  if (!Number.isFinite(at)) return '—';
  return fmtCountdown(at - now);
}

/**
 * The three things the VM actually does to a NAMED person, and how each reads.
 *
 * `introducing` is a phase of its own even though it runs inside the acceptance
 * sweep: the card used to say "Checking for new acceptances…" from the first
 * intro to the last, which is why intros felt like nothing was happening.
 *
 * Every glyph is INDETERMINATE. Lead duration is unknown, so a ring or a bar
 * would be claiming knowledge nothing has; elapsed seconds is the only honest
 * number and the stage shows that instead.
 */

/** How long a pause may last before the engine stops the campaign for good.
 * Mirrors PAUSE_MAX_MS in the engine's campaign-store.js. A pause holds the
 * campaign's accounts — nobody else can send from them — and freezes its unsent
 * leads, which is fine for a coffee break and wrong for a week. */
export const PAUSE_MAX_MS = 48 * 60 * 60 * 1000;

/**
 * The paused card's second line: when this pause stops being a pause.
 *
 * Returns '' when `pausedAt` is missing or unparseable — a local campaign has no
 * stamp at all, and a cloud campaign paused by an older engine build may not
 * either. Inventing a deadline for those would be a countdown to a moment
 * nothing acts on.
 */
export function pauseAutoStop(pausedAt, now = Date.now()) {
  const started = Date.parse(pausedAt || '');
  if (!Number.isFinite(started)) return '';
  const left = started + PAUSE_MAX_MS - now;
  // Past the deadline the engine's next tick cancels it. Say that, rather than
  // counting down through zero into negative hours.
  if (left <= 0) return 'auto-stopping now — paused too long';
  const mins = Math.floor(left / 60000);
  if (mins < 60) return `auto-stops in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  // Under two hours the minutes matter — it is about to happen. Above that they
  // are noise on a 48-hour clock.
  return hrs < 2 ? `auto-stops in ${hrs}h ${rem}m` : `auto-stops in ${hrs}h`;
}

export const LIVE_PHASES = {
  starting:    { verb: 'Starting campaign worker', icon: '◌', state: 'starting', glyph: 'boot' },
  sending:     { verb: 'Sending connection',   icon: '➤', state: 'sending',  glyph: 'fly' },
  introducing: { verb: 'Writing introduction', icon: '✎', state: 'sending',  glyph: 'typ' },
  checking:    { verb: 'Checking acceptances', icon: '↻', state: 'checking', glyph: 'swp' },
  monitoring:  { verb: 'Monitoring is active', icon: '◷', state: 'monitoring', glyph: 'wait' },
  // Not a thing the VM is DOING — a thing it can't do. A campaign whose every
  // account is capped or benched stays status:'running' forever, so the card
  // showed a green RUNNING dot over "Working…" while nothing had been sent for
  // ten hours (operator screenshot 2026-08-05: last send 03:45, the engine
  // logging "No account free right now" every 10 minutes since).
  waiting:     { verb: 'Waiting for a free account', icon: '◷', state: 'waiting', glyph: 'wait' },
};

export function buildLiveActivity(status, now = Date.now()) {
  if (!status) return { state: 'idle', icon: '', l1: 'No campaign running', l2: '' };

  if (status.state === 'interrupted' || status.interrupted) {
    const i = status.interruption || {};
    const monitoring = i.phase === 'monitoring' || status.monitoringPhase;
    return {
      state: 'interrupted',
      icon: '■',
      phase: 'interrupted',
      l1: i.title || (monitoring
        ? 'Monitoring stopped because this Mac became unavailable'
        : 'Campaign stopped because this Mac became unavailable'),
      l2: i.detail || (monitoring
        ? 'Sending remains stopped. Resume acceptance checks here or move monitoring to the Cloud VM.'
        : 'The remaining leads are safe. Choose where to continue.'),
      verb: monitoring ? 'Monitoring stopped safely' : 'Campaign stopped safely',
      who: '',
      sub: i.recordedAt ? `recorded ${i.recordedAt}` : '',
    };
  }

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
  const monitoringPaused = !!status.monitoringPhase && paused && status.state !== 'monitoring';
  const ca = status.currentAction || null;
  const account = (ca && ca.account) || status.currentProfile || '';
  const lead = (ca && ca.lead) || '';

  // A real per-person phase tick from the engine beats every derived state
  // below — it names WHAT is happening and to WHOM, which is the whole point.
  // It outranks the monitoring branch deliberately: intros fire inside the
  // sweep, so without this an intro run reports as "Checking for new
  // acceptances…". Paused still wins (the phase is stale the moment we pause).
  const P = ca && LIVE_PHASES[ca.phase];
  if (P && (!paused || monitoring)) {
    return {
      state: P.state, icon: P.icon, phase: ca.phase,
      l1: ca.label || P.verb,
      l2: [account, lead].filter(Boolean).join(' · '),
      verb: P.verb, who: lead || account || '', sub: ca.sub || '',
    };
  }

  if (monitoringPaused) {
    const n = (status.participatingProfileIds || status.profileIds || []).length;
    const cadMin = Number(status.checkIntervalMinutes) || 60;
    const cad = cadMin >= 60 ? `${cadMin / 60}h` : `${cadMin} min`;
    return {
      state: 'paused', icon: '‖', l1: 'Paused between checks',
      l2: `${n ? `${n} account${n === 1 ? '' : 's'} · ` : ''}monitoring remains active · next check runs automatically every ${cad}`,
    };
  }

  if (monitoring) {
    const hero = monitorHeroState(status);
    if (hero.state === 'checking') {
      return {
        state: 'checking',
        icon: '↻',
        // The detailed card keys off `phase`. Manual This-Mac checks are
        // marked in-progress before their first browser event/currentAction,
        // so omitting this sent them back to the legacy blue banner.
        phase: 'checking',
        l1: 'Checking for new acceptances…',
        l2: hero.overrun
          ? 'sweep looks stalled — auto-recovers'
          : (account ? `${account} · sweeping recent connections` : 'sweeping recent connections'),
        verb: 'Checking acceptances',
        who: account || 'Selecting the next account',
        sub: account ? 'Reading sent invitations' : 'Choosing the first eligible campaign account',
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
    const slow = checkSlowdown(status);
    if (slow) {
      // Says three things, in the order an operator asks them: it is deliberate,
      // here is the evidence, here is what undoes it. Without the third the
      // slowdown reads as permanent and the operator goes looking for a setting
      // to change.
      return {
        state: 'monitoring',
        icon: '◷',
        l1: 'Quiet — checking less often',
        l2: `nothing accepted in the last ${slow.streak} check${slow.streak === 1 ? '' : 's'} · `
          + (slow.base === 60 ? 'hourly' : `every ${cadenceLabel(slow.base)}`)
          + ' again as soon as one lands',
      };
    }
    return {
      // Between scheduled sweeps the browser work is intentionally paused.
      // Calling that merely "waiting" made an operator-paused campaign look as
      // if its pause had been lost during a VM ↔ Mac handover. Keep both truths
      // visible: sending/browser work is paused, monitoring remains armed.
      state: 'monitoring', phase: 'monitoring',
      icon: '◷',
      l1: 'Nothing is running right now — this is expected',
      l2: `${acctStr}monitoring is armed · next check runs automatically every ${cad}`,
      verb: 'Monitoring is active', who: 'Waiting between checks', sub: 'No browser stays open between sweeps',
    };
  }

  if (status.running) {
    if (paused) {
      const stop = pauseAutoStop(status.pausedAt, now);
      const started = Date.parse(status.pausedAt || '');
      // Past the deadline the reassurance becomes a contradiction: this campaign
      // is about to be cancelled, so "resumes instantly" is the one thing it
      // will not do. The deadline line stands alone.
      const expired = Number.isFinite(started) && now >= started + PAUSE_MAX_MS;
      return {
        state: 'paused',
        icon: '‖',
        l1: 'Paused — finishes the current lead, then waits',
        // The deadline only appears when we know WHEN the pause started. A local
        // campaign has no pausedAt — its pause lives in memory and dies with the
        // app — so it keeps the old wording rather than being told about a 48h
        // rule that nothing enforces for it.
        l2: !stop ? 'resumes instantly · browsers stay open'
          : expired ? stop
            : `${stop} · resumes instantly, browsers stay open`,
      };
    }
    return {
      state: 'sending',
      icon: '→',
      l1: (ca && ca.label) || 'Waiting for a verified engine update',
      l2: [account, lead, ca && ca.phase && !LIVE_PHASES[ca.phase] ? `reported phase: ${ca.phase}` : ''].filter(Boolean).join(' · '),
    };
  }

  return { state: 'idle', icon: '', l1: 'No campaign running', l2: '' };
}
