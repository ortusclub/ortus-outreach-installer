// Pure readback builder for the Primary "Manifest" panel. Turns the live
// primary/auto-accept/cadence/follow-up settings into plain-English ✓/— lines +
// a STANDARD/CUSTOMIZED flag + an optional cloud-handshake notice. No DOM.
//
// Modes: connect_and_introduce (full: accept + cadence + follow-up),
// connect_and_message (cadence only), introduce_back (identity only → no lines).

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CADENCE_LABEL = {
  60: 'every 1 hour', 120: 'every 2 hours', 240: 'every 4 hours',
  360: 'every 6 hours', 720: 'every 12 hours',
};
const DELAY_LABEL = {
  10: '10 minutes', 20: '20 minutes', 30: '30 minutes',
  45: '45 minutes', 60: '1 hour', 120: '2 hours',
};

function actorLabel(primarySource, primaryName) {
  if (primarySource && primarySource !== 'local-browser') return 'a GoLogin profile';
  const first = String(primaryName || '').trim().split(/\s+/)[0];
  return first ? `${esc(first)}'s local browser` : 'your local browser';
}

// The default profile every operator sees on a fresh CC+IC wizard. Deviations
// flip STANDARD → CUSTOMIZED. Mirrors the HTML defaults.
const STANDARD = {
  autoAcceptPrimary: true, autoAcceptAllPending: false, primarySource: 'local-browser',
  primaryCheckTiming: 'after_connections', checkCadenceMinutes: 60,
  autoChecksEnabled: true, followUpEnabled: true, followUpDelayMinutes: 10,
};

export function buildManifestReadback(s = {}) {
  const mode = s.mode || 'connect_and_introduce';
  const isCCIC = mode === 'connect_and_introduce';
  const isCCDM = mode === 'connect_and_message';
  const localPrimary = !s.primarySource || s.primarySource === 'local-browser';
  const cloudLocalPrimary = s.runTarget === 'cloud' && localPrimary;
  const actor = actorLabel(s.primarySource, s.primaryName);
  const nm = esc(s.primaryName || '(unnamed)');
  const lines = [];

  if (isCCIC) {
    // Line 1 — auto-accept
    const timing = s.primaryCheckTiming === 'immediately' ? 'Immediately at start' : 'After connections complete';
    const allPending = s.autoAcceptAllPending
      ? ' <span class="tok">+ all other pending invites ⚠️</span>' : '';
    lines.push({
      key: 'accept', on: !!s.autoAcceptPrimary,
      html: s.autoAcceptPrimary
        ? `<b>${timing}</b>, each sender requests <b>${nm}</b> — <b>${actor}</b> accepts automatically${allPending}`
        : `Auto-accept off — connect the senders to ${nm} manually before intros`,
    });
  }
  if (isCCIC || isCCDM) {
    // Cadence line
    const cad = CADENCE_LABEL[s.checkCadenceMinutes] || `every ${esc(s.checkCadenceMinutes)} min`;
    lines.push({
      key: 'cadence', on: s.autoChecksEnabled !== false,
      html: s.autoChecksEnabled !== false
        ? `Acceptances checked <b>${cad}</b>; intros fire as they land`
        : `Automatic checks off — run them with <b>⚡ Check now</b>`,
    });
  }
  if (isCCIC) {
    // Follow-up line — replaced by the handshake line when cloud + local primary.
    if (cloudLocalPrimary) {
      lines.push({
        key: 'followup', on: false,
        html: `☁︎ <b>Your Mac accepts once</b> (locked first step), then everything runs on the VM — follow-up off for this run`,
      });
    } else {
      const delay = DELAY_LABEL[s.followUpDelayMinutes] || `${esc(s.followUpDelayMinutes)} min`;
      lines.push({
        key: 'followup', on: !!s.followUpEnabled,
        html: s.followUpEnabled
          ? `First follow-up <b>${delay}</b> after the last intro`
          : `No automated follow-up`,
      });
    }
  }

  // STANDARD only when CC+IC, local run, and every knob at default.
  let state = 'standard';
  if (!isCCIC || s.runTarget === 'cloud') {
    state = 'customized';
  } else {
    for (const k of Object.keys(STANDARD)) {
      if (s[k] !== undefined && s[k] !== STANDARD[k]) { state = 'customized'; break; }
    }
  }

  const cloudNotice = cloudLocalPrimary
    ? `Running in the cloud: your Mac accepts the senders' invites once (locked first step), then everything runs on the VM. Follow-up is off for this run.`
    : null;

  return { lines, state, cloudNotice };
}
