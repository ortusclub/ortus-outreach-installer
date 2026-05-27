// Floating live console — pure helpers.
// Imported by public/js/app.js for DOM glue and by tests/live-console.test.js
// for unit verification. Keep this module DOM-free: no document/window access.

const MODE_LABELS = {
  connect_only: 'CC',
  connect_and_introduce: 'CC+IC',
  message_only: 'DM',
  inmail_only: 'IM',
  open_profile_only: 'OP-DM',
  check_status: 'CHK',
  check_dms: 'DMS',
  post_amplification: 'AMP',
};

export function computePillState(s) {
  if (!s || typeof s !== 'object') {
    return _emptyState();
  }

  const name = (s.name || '').trim() || '—';
  const modeShort = MODE_LABELS[s.mode] || (s.mode || '').toUpperCase() || '—';
  const errCount = Array.isArray(s.errors) ? s.errors.length : 0;
  const parkedCount = Array.isArray(s.parked) ? s.parked.length : 0;
  const throttleActive = !!(s.throttle && s.throttle.active);
  const isPaused = !!s.paused;
  const isMonitoring = s.state === 'monitoring';

  // Precedence: paused > throttle > parked > errors > healthy.
  let dot = 'gray';
  let pulse = false;
  let labelSuffix = modeShort;

  if (isPaused) {
    dot = 'gray';
    pulse = false;
    labelSuffix = 'paused';
  } else if (throttleActive) {
    dot = 'amber';
    pulse = false;
  } else if (parkedCount > 0) {
    dot = 'amber';
    pulse = false;
  } else if (s.running || isMonitoring) {
    dot = 'green';
    pulse = true;
    if (isMonitoring) labelSuffix = 'monitoring';
  }

  return {
    dot,
    pulse,
    label: `${name} · ${labelSuffix}`,
    name,
    mode: modeShort,
    processed: Number(s.processedToday) || 0,
    total: Number(s.totalTargets) || 0,
    lead: (s.currentAction && s.currentAction.lead) || '—',
    account: s.currentProfile || '—',
    action: (s.currentAction && s.currentAction.label) || '—',
    state: s.state || 'idle',
    logs: Array.isArray(s.logs) ? s.logs.slice(-3) : [],
    errSegment: errCount > 0 ? `· ${errCount} err` : null,
    parkedSegment: parkedCount > 0 ? `· ${parkedCount} parked` : null,
    throttleReason: throttleActive ? (s.throttle.reason || null) : null,
  };
}

function _emptyState() {
  return {
    dot: 'gray', pulse: false, label: '—', name: '—', mode: '—',
    processed: 0, total: 0, lead: '—', account: '—', action: '—',
    state: 'idle', logs: [],
    errSegment: null, parkedSegment: null, throttleReason: null,
  };
}

export function shouldShowConsole(_args) {
  throw new Error('not implemented');
}
