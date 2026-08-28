// Pure trigger gate for the Path A cloud handshake — browser-safe (no node
// deps) so public/js/app.js imports it AND node --test can unit-test it. Mirrors
// needsCloudHandshake() in src/cloud-preflight-handshake.js, but reads the
// campaign-submit `body` shape the client already has.
//
// Path A runs ONLY for a cloud CC+IC campaign whose primary is local-only and
// whose auto-accept is on — the exact case the engine can't handle (no operator
// Chrome on the VM; the primary's browser is only on this Mac).

// `primaryHandshakeOn: 'vm'` used to switch this off, on the promise that the
// engine would do the handshake instead. It never did — nothing in the engine
// repository reads that key (grepped 2026-08-28, zero matches), so the senders
// were simply never connected to the primary, and the engine's own sender→
// primary connect is lazy and fires per-lead at introduction time, gated on a
// lead having ALREADY been accepted. A VM campaign that reaches monitoring with
// zero acceptances therefore sends the primary nothing and no introduction can
// ever fire. The option is gone from the launch modal, and the value is ignored
// here too so an old draft carrying it cannot silently skip the handshake.
export function needsHandshakeFromBody(body = {}) {
  const t = (body && body.templates) || {};
  return body.mode === 'connect_and_introduce'
    && t.autoAcceptPrimary === true
    && (t.primarySource || 'local-browser') === 'local-browser';
}

// UI mapping: one sender's handshake state → row presentation. Kept here so the
// wizard and any future surface render identical labels.
const ROW = {
  pending:            { icon: 'wait',  label: 'Waiting',           done: false },
  connecting:         { icon: 'wait',  label: 'Connecting…',       done: false },
  sent:               { icon: 'dot',   label: 'Waiting to be accepted', done: false },
  'sent-no-identity': { icon: 'dot',   label: 'Sent · accept manually', done: false },
  accepting:          { icon: 'spin',  label: 'Accepting…',        done: false },
  connected:          { icon: 'check', label: 'Connected',         done: true },
  error:              { icon: 'x',     label: 'Error',             done: false },
};

export function handshakeRowView(state) {
  return ROW[state] || ROW.pending;
}

// ── Which of the two local steps the handshake is on ────────────────────────
// The wizard used to show a single bar counting connections, so once the last
// invite was out there was nothing left moving: the 20s settle wait and the
// primary's accept pass both read as a hang, and the accept itself was never
// visible (operator, 2026-08-28 — "the handshake closes and then only then it
// autoaccepts"). Step 1 is the senders inviting the primary; step 2 is the
// primary's own browser accepting those invites. A sender is past step 1 the
// moment it is no longer pending/connecting, whatever the outcome.
// `everInvited` is the set of senders that actually sent an invitation at some
// point in this run. Without it the strip cannot tell "the primary accepted two
// invites" from "both senders were already 1st-degree, so there was nothing to
// accept and the primary's browser never opened" — and it claimed the second
// case as a completed step 2 (operator, 2026-08-28 14:09; the run's own log says
// "Connected to primary (1st)" twice and "0 accepted, 0 still pending").
export function handshakeStepView(senders = [], summary = null, everInvited = null) {
  const states = (senders || []).map((s) => String((s && s.state) || 'pending'));
  const total = states.length;
  const connected = states.filter((s) => s === 'connected').length;
  const invited = states.filter((s) => s !== 'pending' && s !== 'connecting').length;
  const step = total > 0 && invited === total ? 2 : 1;
  const acceptCount = everInvited ? everInvited.size : null;
  return {
    step,
    total,
    connected,
    invited,
    step1Done: step === 2,
    step2Done: total > 0 && connected === total,
    // null while unknown (nothing has moved yet); false once we know for certain
    // that no invitation was ever sent, so no accept can be owed.
    needsAccept: acceptCount == null ? null : acceptCount > 0,
    pending: summary ? Number(summary.pending) || 0 : 0,
  };
}

// What the wizard says when the job finishes. `ok` auto-closes and dispatches,
// as before. `partial` is the case the wizard used to report as success: the
// invites went out but the primary never accepted them here — in the measured
// run the primary's Chrome would not launch at all, the accepts were handed to
// the background runner, and the modal closed saying "done" (dev-app.log,
// 2026-08-28: "primary accept session failed … 1 connected, 0 accepted, 1 still
// pending"). That one stops and asks.
export function handshakeOutcome({ senders = [], summary = null, error = '' } = {}) {
  if (error) return { kind: 'error', headline: 'Handshake error', detail: String(error) };
  const v = handshakeStepView(senders, summary);
  const unaccepted = Math.max(0, v.total - v.connected);
  if (unaccepted === 0) return { kind: 'ok', headline: 'All senders are connected to the primary', detail: '' };
  const who = (senders || [])
    .filter((s) => String((s && s.state) || '') !== 'connected')
    .map((s) => String((s && s.name) || s.profileId || 'a sender'));
  const names = who.length === 1 ? who[0] : `${who.length} senders`;
  return {
    kind: 'partial',
    headline: `${v.connected} of ${v.total} connected`,
    detail: `${names} sent the invitation but the primary did not accept it here. The app will accept it in the background the next time your primary Chrome opens, and the campaign picks it up on its next check.`,
  };
}
