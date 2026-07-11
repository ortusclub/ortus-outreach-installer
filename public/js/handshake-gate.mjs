// Pure trigger gate for the Path A cloud handshake — browser-safe (no node
// deps) so public/js/app.js imports it AND node --test can unit-test it. Mirrors
// needsCloudHandshake() in src/cloud-preflight-handshake.js, but reads the
// campaign-submit `body` shape the client already has.
//
// Path A runs ONLY for a cloud CC+IC campaign whose primary is local-only and
// whose auto-accept is on — the exact case the engine can't handle (no operator
// Chrome on the VM; the primary's browser is only on this Mac).

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
  sent:               { icon: 'dot',   label: 'Request sent',      done: false },
  'sent-no-identity': { icon: 'dot',   label: 'Sent · accept manually', done: false },
  accepting:          { icon: 'spin',  label: 'Accepting…',        done: false },
  connected:          { icon: 'check', label: 'Connected',         done: true },
  error:              { icon: 'x',     label: 'Error',             done: false },
};

export function handshakeRowView(state) {
  return ROW[state] || ROW.pending;
}
