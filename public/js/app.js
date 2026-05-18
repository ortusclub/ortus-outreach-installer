/* global fetch */

// Phase 11.3 — app.js is now an ES module so we can import the Replies renderer
// directly (no setTimeout race between classic + module script loading).
// Every function referenced from an inline onclick handler in index.html is
// re-exposed on `window` at the bottom of this file.
import { renderRepliesPanel } from '/js/replies-panel.mjs';
import {
  getTipsForMode,
  renderModalTipsHtml,
  renderSidebarTipsHtml,
  isTipsSilenced,
  silenceTipsForMode,
} from '/js/post-launch-tips.mjs';
import {
  startTour,
  tourNext,
  tourBack,
  tourSkip,
  endTour,
  replayTour,
  maybeAutoStartTour,
  isTourCompleted,
} from '/js/tour.mjs';

let selectedProfileIds = [];
let selectedProfileNames = {};
let allProfilesData = [];
let localBrowserFirstName = (typeof localStorage !== 'undefined' && localStorage.getItem('localBrowserFirstName')) || '';

function resolveSenderFirstName(profileId, profileName) {
  if (profileId === 'local-browser') {
    // v2.11.15: manual override wins, but if the operator hasn't set
    // localBrowserFirstName, auto-resolve to the SoO firstName for the
    // signed-in user — same source the "Good morning, Antonio" greeting
    // uses (app.js:3320). Operator no longer has to type their own name
    // in two places.
    const manual = (localBrowserFirstName || '').trim();
    if (manual) return manual;
    const emailEl = document.getElementById('user-chip-email');
    const email = ((emailEl?.textContent) || '').trim().toLowerCase();
    const sooEntry = email && sooData && sooData[email];
    const raw = sooEntry && sooEntry.firstName ? sooEntry.firstName.trim() : '';
    if (!raw) return '';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  const soo = findSoOForProfile(profileName);
  if (!soo) return '';
  return (soo['First Name'] || soo.firstName || '').toString().trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Preview
// ─────────────────────────────────────────────────────────────────────────────

// LinkedIn-imposed length limits. undefined = no hard limit.
const CHAR_LIMITS = {
  connectionNote: 300,
  followUpMessage: undefined,
  inmailSubject: 200,
  inmailBody: 1900,
  opProfileSubject: undefined,
  opProfileBody: undefined,
  introTitle: undefined,
};

// Display labels used in the modal card section headers.
const PREVIEW_FIELD_LABELS = {
  connectionNote: 'Connection Note',
  followUpMessage: 'Follow-up Message',
  inmailSubject: 'InMail Subject',
  inmailBody: 'InMail Body',
  opProfileSubject: 'Open Profile Subject',
  opProfileBody: 'Open Profile Body',
  introTitle: 'Group conversation title',
};

// Collects the same form state that startCampaign() sends to /api/campaign/start.
// Mirrors app.js:1122-1185 so the server-side normalization works identically.
function gatherCampaignFormState() {
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  const linkedinColumn = document.getElementById('linkedin-col-select')?.value || '';
  const mode = document.getElementById('campaign-mode').value;
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';

  const templates = {
    connectionNote: (mode === 'connect_only' && !addNoteOn) ? '' : document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    // 2.8.50: Introduction Messages sub-mode of message_only
    // v2.11.13: read from introModeActive (in-memory) instead of localStorage
    // because Chrome enterprise/privacy enforcement can block storage reads.
    introMode: mode === 'introduce_back',
    introName: document.getElementById('intro-name')?.value?.trim() || '',
    introTitle: document.getElementById('intro-title')?.value || 'Introduction: {first name} <> {intro name}',
  };

  const senderFirstNames = {};
  for (const id of selectedProfileIds) {
    const pName = selectedProfileNames[id] || id;
    senderFirstNames[id] = resolveSenderFirstName(id, pName);
  }

  return {
    sheetUrl,
    linkedinColumn,
    templates,
    profileIds: [...selectedProfileIds],
    senderFirstNames,
  };
}

// Returns { disabled: bool, reason: string | null } — drives the Preview button state.
function getPreviewDisabledReason() {
  const sheetUrl = document.getElementById('sheet-url')?.value?.trim() || '';
  if (!sheetUrl) return { disabled: true, reason: 'Enter a Google Sheet URL first' };
  const anyTemplate = [
    document.getElementById('tpl-note')?.value,
    document.getElementById('tpl-followup')?.value,
    document.getElementById('tpl-inmail-subject')?.value,
    document.getElementById('tpl-inmail-body')?.value,
    document.getElementById('tpl-op-subject')?.value,
    document.getElementById('tpl-op-body')?.value,
  ].some(v => v && v.trim());
  if (!anyTemplate) return { disabled: true, reason: 'Fill in at least one template to preview' };
  return { disabled: false, reason: null };
}

function refreshPreviewButtonState() {
  const btn = document.getElementById('btn-preview-messages');
  if (!btn) return;
  const { disabled, reason } = getPreviewDisabledReason();
  btn.disabled = disabled;
  btn.title = disabled ? reason : 'Render current templates against 3 sample leads';
}

async function handlePreviewClick() {
  const btn = document.getElementById('btn-preview-messages');
  const { disabled } = getPreviewDisabledReason();
  if (disabled) { refreshPreviewButtonState(); return; }

  const state = gatherCampaignFormState();
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const res = await fetch('/api/templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json();
    if (!res.ok) {
      renderPreviewModal([], data.error || `Request failed (${res.status})`);
    } else {
      renderPreviewModal(data.previews || [], data.error || null);
    }
  } catch (err) {
    renderPreviewModal([], err.message || 'Network error');
  } finally {
    btn.textContent = originalText;
    refreshPreviewButtonState();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPreviewModal(previews, error) {
  const modal = document.getElementById('preview-modal');
  const body = document.getElementById('preview-modal-body');
  const closeBtn = document.getElementById('preview-modal-close');
  const backdrop = document.getElementById('preview-modal-backdrop');
  if (!modal || !body) return;

  let html = '';
  if (error) {
    html += `<div class="preview-modal__error">Error: ${escapeHtml(error)}</div>`;
  }
  if (!error && previews.length === 0) {
    html += `<div class="preview-modal__empty">No leads with LinkedIn URLs found in the sheet.</div>`;
  }

  for (const p of previews) {
    const leadName = [p.lead.firstName, p.lead.lastName].filter(Boolean).join(' ') || '(no name)';
    html += `<div class="preview-card">`;
    html += `  <div class="preview-card__lead">`;
    html += `    <strong>${escapeHtml(leadName)}</strong>`;
    if (p.lead.company) html += ` <span class="preview-card__company">— ${escapeHtml(p.lead.company)}</span>`;
    if (p.lead.url) html += ` <a href="${escapeHtml(p.lead.url)}" target="_blank" rel="noopener" class="preview-card__url">${escapeHtml(p.lead.url)}</a>`;
    html += `  </div>`;

    for (const key of Object.keys(PREVIEW_FIELD_LABELS)) {
      const text = p.rendered?.[key];
      if (!text) continue;
      const limit = CHAR_LIMITS[key];
      const len = text.length;
      const over = limit !== undefined && len > limit;
      const countLabel = limit !== undefined ? `${len} / ${limit} chars` : `${len} chars`;
      html += `<div class="preview-card__field">`;
      html += `  <div class="preview-card__field-header">`;
      html += `    <span class="preview-card__field-name">${escapeHtml(PREVIEW_FIELD_LABELS[key])}</span>`;
      html += `    <span class="preview-card__count ${over ? 'preview-card__count--over' : ''}">${escapeHtml(countLabel)}</span>`;
      html += `  </div>`;
      html += `  <pre class="preview-card__text">${escapeHtml(text)}</pre>`;
      html += `</div>`;
    }

    if (p.warnings && p.warnings.length) {
      html += `<div class="preview-card__warnings">`;
      html += `  <div class="preview-card__warnings-title">Warnings</div>`;
      html += `  <ul>${p.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
      html += `</div>`;
    }
    html += `</div>`; // .preview-card
  }

  body.innerHTML = html;
  modal.hidden = false;

  const onClose = () => {
    modal.hidden = true;
    closeBtn.removeEventListener('click', onClose);
    backdrop.removeEventListener('click', onClose);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
  closeBtn.addEventListener('click', onClose);
  backdrop.addEventListener('click', onClose);
  document.addEventListener('keydown', onKey);
}

// Keep the Preview button state in sync as the user types / changes selections.
document.addEventListener('DOMContentLoaded', () => {
  refreshPreviewButtonState();
  const watchIds = [
    'sheet-url',
    'tpl-note', 'tpl-followup',
    'tpl-inmail-subject', 'tpl-inmail-body',
    'tpl-op-subject', 'tpl-op-body',
  ];
  for (const id of watchIds) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', refreshPreviewButtonState);
  }
  // 2.8.29 / 2.8.32: refresh coverage preview when sheet URL changes (debounced).
  let csDebounce = null;
  const sheetEl = document.getElementById('sheet-url');
  if (sheetEl) sheetEl.addEventListener('input', () => {
    const m = document.getElementById('campaign-mode').value;
    clearTimeout(csDebounce);
    if (m === 'check_status') {
      csDebounce = setTimeout(refreshCheckStatusPreview, 600);
    } else if (m === 'message_only') {
      csDebounce = setTimeout(refreshMessageOnlyPreview, 600);
    }
  });
  // Phase 2.8.12: poll status once on load so the cockpit picks up an
  // already-running campaign across page refreshes. If a campaign is live,
  // this also kickstarts continuous polling via the running-detect path.
  pollStatus().then(() => {
    if (__cockpit.running) startPolling();
  }).catch(() => {});

  // Phase 2.8.14: relocate the Throughput section (#nav-pace) to sit right
  // under the Accounts section (#nav-accounts) so the live total recalculation
  // is contextual to the account selection above it.
  const pace = document.getElementById('nav-pace');
  const accounts = document.getElementById('nav-accounts');
  if (pace && accounts && pace.parentElement && pace.parentElement === accounts.parentElement) {
    accounts.parentElement.insertBefore(pace, accounts.nextSibling);
  }
  // Sync visible→hidden once and run an initial recalc.
  if (typeof alphaSyncRate === 'function') alphaSyncRate();

  // Onboarding tour — auto-start on first ever app load (no localStorage flag).
  // No-op if flag is already set. Defers internally so layout settles first.
  try { maybeAutoStartTour(); } catch (err) { console.warn('[tour] auto-start failed:', err.message); }
});

let serverLogInterval = null;
let notificationsEnabled = false;

// ─────────────────────────────────────────────────────────────────────────────
// Browser notifications (in-tab only) + server-side email for scheduled events
// ─────────────────────────────────────────────────────────────────────────────
function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('This browser does not support in-tab notifications.');
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((p) => {
      notificationsEnabled = p === 'granted';
      alert(notificationsEnabled
        ? 'In-tab notifications enabled (only fire when the dashboard is open). Scheduled campaigns also send email.'
        : `Notifications are ${p}. Scheduled campaigns will still email you.`);
    });
  } else {
    notificationsEnabled = Notification.permission === 'granted';
    alert(notificationsEnabled
      ? 'In-tab notifications are already enabled.'
      : `Notifications are ${Notification.permission}. To re-enable, clear site permissions in the address bar.`);
  }
}

function notify(title, body) {
  if (notificationsEnabled) {
    try { new Notification(title, { body }); } catch { /* */ }
  }
}

async function sendTestNotification() {
  // Phase 2.8.19 (C4): record result so the sidebar Notifications panel can show
  // "<time> ago · delivered" or "<time> ago · failed" on the Last test row.
  const recordResult = (result) => {
    try { localStorage.setItem('ortus-last-notify-test', JSON.stringify({ at: Date.now(), result })); } catch (_) {}
    if (typeof refreshNotifPanel === 'function') refreshNotifPanel();
  };
  try {
    const res = await fetch('/api/notify/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      recordResult('failed');
      alert('Test failed: ' + (data.error || `HTTP ${res.status}`));
      return;
    }
    recordResult('delivered');
    alert(`Test email sent.\nRecipients reached: ${data.sent ?? 0}${data.reason ? '\nNote: ' + data.reason : ''}`);
  } catch (err) {
    recordResult('failed');
    alert('Test failed: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron-safe replacement for window.prompt()
// Electron's BrowserWindow disables window.prompt() by design, so using it
// silently fails (Save Template did nothing in the packaged DMG). This helper
// shows a small modal defined in index.html and resolves with the trimmed
// input string (or null on cancel / ESC / empty). Keep it generic — callers
// pass label + optional defaultValue.
// ─────────────────────────────────────────────────────────────────────────────
function promptModal({ label = 'Enter value:', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('prompt-modal');
    const labelEl = document.getElementById('prompt-modal-label');
    const input = document.getElementById('prompt-modal-input');
    const saveBtn = document.getElementById('prompt-modal-save');
    const cancelBtn = document.getElementById('prompt-modal-cancel');
    if (!modal || !input || !saveBtn || !cancelBtn || !labelEl) { resolve(null); return; }
    labelEl.textContent = label;
    input.value = defaultValue;
    modal.hidden = false;
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 0);

    const cleanup = () => {
      modal.hidden = true;
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    };
    const onSave = () => { const v = (input.value || '').trim(); cleanup(); resolve(v || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Log Panel
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.8.19 (B3) — unified log: server lines render into a sub-container
// inside #log-panel when the "Show server lines" checkbox is on. The inline
// #server-log-panel was deleted; the sidebar "Open log" button now scrolls to
// Live Status and expands it.
function openUnifiedLog() {
  // Re-uses scrollToSection so the dashboard → wizard route swap happens
  // automatically when the operator clicks "Open log" from outside the wizard.
  scrollToSection('nav-status');
}

async function refreshServerLines() {
  const cb = document.getElementById('show-server-lines');
  if (!cb || !cb.checked) return;
  const panel = document.getElementById('log-panel');
  if (!panel) return;
  try {
    const res = await fetch('/api/server-log');
    if (!res.ok) return;
    const lines = await res.json();
    let container = panel.querySelector('#server-lines-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'server-lines-container';
      panel.appendChild(container);
    }
    container.innerHTML = lines.map((line) => {
      let cls = 'info';
      if (line.includes('[ERR]')) cls = 'err';
      else if (line.includes('[WARN]')) cls = 'warn';
      return `<div class="entry ${cls}" style="opacity:.6"><span style="color:var(--gray); font-size:0.6rem; letter-spacing:0.14em; margin-right:6px; text-transform:uppercase">srv</span>${escHtml(line)}</div>`;
    }).join('');
  } catch (_) { /* */ }
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'show-server-lines') {
    if (e.target.checked) {
      refreshServerLines();
      if (!serverLogInterval) serverLogInterval = setInterval(refreshServerLines, 4000);
    } else {
      if (serverLogInterval) { clearInterval(serverLogInterval); serverLogInterval = null; }
      const panel = document.getElementById('log-panel');
      const container = panel?.querySelector('#server-lines-container');
      if (container) container.remove();
    }
  }
});

async function clearServerLog() {
  // Backwards-compat name kept in case any other module calls it.
  // Hits the backend ring buffer DELETE and removes the local sub-container.
  try { await fetch('/api/server-log', { method: 'DELETE' }); } catch { /* */ }
  const panel = document.getElementById('log-panel');
  const container = panel?.querySelector('#server-lines-container');
  if (container) container.innerHTML = '';
  try { localStorage.setItem('ortus-log-cleared-at', new Date().toISOString()); } catch (_) {}
}

// Note: the previous standalone server-log helpers were removed in 2.8.19.
// The unified Copy Log / Clear Log buttons handle the campaign log; server lines
// live inside #log-panel so they're included in those operations automatically.

function clearCampaignLog() {
  const el = document.getElementById('log-panel');
  if (!el) return;
  // Persist a cutoff so the log stays cleared across reloads / poll updates.
  try { localStorage.setItem('ortus-log-cleared-at', new Date().toISOString()); } catch (_) {}
  el.innerHTML = '<div class="entry info">Log cleared.</div>';
  const feed = document.getElementById('rp-feed-list');
  if (feed) feed.innerHTML = '<div class="rp-feed-item"><span class="rp-feed-time">—</span><span class="rp-feed-text">Waiting for campaign…</span></div>';
}

function copyCampaignLog() {
  const el = document.getElementById('log-panel');
  if (!el) return;
  const text = Array.from(el.querySelectorAll('.entry')).map(e => e.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = el.previousElementSibling?.querySelector('button');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  });
}
let pollInterval = null;
let wasRunning = false;
let wasErrorCount = 0;

// Dynamic placeholder tags from sheet columns
let sheetColumns = ['firstName', 'lastName', 'company', 'title'];

// SoO (State of Operations) data — email → status mapping
let sooData = {}; // { 'email@ortus.com': { linkedinCredits: 'In Use', linkedinUser: '...', ... } }
let sooLoadState = 'idle'; // 'idle' | 'loading' | 'ok' | 'error'

function setSoOErrorState(isError) {
  const pill = document.getElementById('rp-soo-error');
  if (pill) pill.hidden = !isError;
}

async function loadSoOStatus() {
  sooLoadState = 'loading';
  try {
    const res = await fetch('/api/soo-status');
    // Server returns 503 + { error, errorCode } on any failure now.
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const d = await res.json(); if (d && d.error) detail = `${d.errorCode || 'ERR'}: ${d.error}`; } catch {}
      console.warn('[SoO] Endpoint error:', detail);
      sooLoadState = 'error';
      setSoOErrorState(true);
      return;
    }
    const data = await res.json();
    sooData = {};
    for (const acct of (data.accounts || [])) {
      if (acct.email) sooData[acct.email.toLowerCase()] = acct;
    }
    sooLoadState = 'ok';
    setSoOErrorState(false);
    console.log(`[SoO] Loaded ${Object.keys(sooData).length} account statuses`);
  } catch (err) {
    console.warn('[SoO] Failed to load:', err.message);
    sooLoadState = 'error';
    setSoOErrorState(true);
  }
}

// GoLogin profile name IS the SoO email (team convention). Exact,
// case-insensitive match only — no fuzzy substring matching, which used to
// cause one operator's credit status to appear on a different profile.
function findSoOForProfile(profileName) {
  if (!profileName || Object.keys(sooData).length === 0) return null;
  const key = (profileName || '').toLowerCase().trim();
  return sooData[key] || null;
}

// Manual SoO refresh — wired to the "Refresh SoO" button in the Accounts
// section. Drives a 10-second horizontal progress bar during the fetch.
async function refreshSoO() {
  const btn = document.getElementById('refresh-soo-btn');
  const bar = document.getElementById('refresh-soo-bar');
  if (btn) btn.disabled = true;
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    // force reflow so the next transition actually animates
    void bar.offsetWidth;
    bar.style.transition = 'width 10s linear';
    bar.style.width = '100%';
  }
  try {
    await loadSoOStatus();
    if (allProfilesData.length > 0) renderProfiles(allProfilesData);
    updateChipCounts();
    updateGreeting();
  } finally {
    if (bar) {
      // Snap to 100% (covers early-success case), then reset after a beat
      bar.style.transition = 'width 200ms ease-out';
      bar.style.width = '100%';
      setTimeout(() => {
        if (!bar) return;
        bar.style.transition = 'none';
        bar.style.width = '0%';
      }, 400);
    }
    if (btn) btn.disabled = false;
  }
}

function renderSoOBadges(soo) {
  if (!soo) return '';

  const isPool = (soo.section || '').toLowerCase().includes('pool') ||
                 (soo.section || '').toLowerCase().includes('unassigned');

  // Assignee line
  let assigneeLine = '';
  const assignee = (soo['Assignee'] || '').trim();
  if (isPool) {
    assigneeLine = `<div class="soo-user">Pool — free for all</div>`;
  } else if (assignee && assignee !== '-') {
    assigneeLine = `<div class="soo-user">Assigned: ${escHtml(assignee)}</div>`;
  }

  const segClass = (v) => {
    const s = (v || '').toLowerCase().replace(/\s+/g, '-');
    if (s === 'available') return 'available';
    if (s === 'in-use') return 'in-use';
    if (s === 'used') return 'used';
    if (s === 'n/a' || s === 'na') return 'na';
    return '';
  };
  const title = (label, v) => `${label}: ${v || '—'}`;
  const hasAny = soo.linkedinCredits || soo.inmailCredits || soo.salesNavCredits || soo.ccCredits;
  const bar = hasAny
    ? `<div class="status-bar status-bar-4">
         <div class="status-seg ${segClass(soo.linkedinCredits)}" title="${escHtml(title('OP', soo.linkedinCredits))}"></div>
         <div class="status-seg ${segClass(soo.inmailCredits)}" title="${escHtml(title('InMail', soo.inmailCredits))}"></div>
         <div class="status-seg ${segClass(soo.salesNavCredits)}" title="${escHtml(title('Sales Nav', soo.salesNavCredits))}"></div>
         <div class="status-seg ${segClass(soo.ccCredits)}" title="${escHtml(title('CC', soo.ccCredits))}"></div>
       </div>
       <div class="status-legend"><span>OP</span><span>InM</span><span>SN</span><span>CC</span></div>`
    : '';

  return `${assigneeLine}${bar}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passover countdowns
// ─────────────────────────────────────────────────────────────────────────────

function getPassoverStatus() {
  // PH time = UTC+8
  const now = new Date();
  const phNow = new Date(now.getTime() + (8 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
  const phDay = phNow.getDay();   // 0=Sun … 6=Sat
  const phDate = phNow.getDate(); // 1-31
  const lastDay = new Date(phNow.getFullYear(), phNow.getMonth() + 1, 0).getDate();

  // Monthly (OP / InMail / Sales Nav): ACTIVE 16th → end of month, INACTIVE 1st → 15th
  let monthly;
  if (phDate >= 16) {
    monthly = { active: true, label: `ACTIVE — closes in ${lastDay - phDate + 1}d` };
  } else {
    monthly = { active: false, label: `in ${16 - phDate}d` };
  }

  // Weekly CC: ACTIVE Thu → Sun, INACTIVE Mon → Wed
  const ccIsActive = phDay === 0 || phDay >= 4;
  let cc;
  if (ccIsActive) {
    const daysToMon = (1 - phDay + 7) % 7; // Sun=1, Thu=4, Fri=3, Sat=2
    cc = { active: true, label: `ACTIVE — closes in ${daysToMon}d` };
  } else {
    const daysToThu = (4 - phDay + 7) % 7; // Mon=3, Tue=2, Wed=1
    cc = { active: false, label: `in ${daysToThu}d` };
  }

  return { monthly, cc };
}

function renderPassoverBanner() {
  const container = document.getElementById('passover-banner');
  const { monthly, cc } = getPassoverStatus();

  const fmt = (info) => {
    const cls = info.active ? ' class="passover-active"' : '';
    return `<strong${cls}>Passover ${info.label}</strong>`;
  };

  if (container) {
    container.innerHTML = `
      <span>OP / InMail / Sales Nav — ${fmt(monthly)}</span>
      <span style="margin-left:16px">CC — ${fmt(cc)}</span>
    `;
  }

  // Hero card mirror — two mini pills, one per passover window, so GDs see
  // Monthly and Weekly state at a glance instead of a single misleading label.
  const heroOp = document.getElementById('hero-passover-op');
  const heroCc = document.getElementById('hero-passover-cc');
  if (heroOp) {
    heroOp.className = 'passover-pill ' + (monthly.active ? 'active' : 'closed');
    heroOp.title = `OP · InMail · Sales Nav — ${monthly.label}`;
  }
  if (heroCc) {
    heroCc.className = 'passover-pill ' + (cc.active ? 'active' : 'closed');
    heroCc.title = `CC — ${cc.label}`;
  }

  // Right-pane mirror
  const opState = document.getElementById('rp-op-state');
  const opDetail = document.getElementById('rp-op-detail');
  const ccState = document.getElementById('rp-cc-state');
  const ccDetail = document.getElementById('rp-cc-detail');
  if (opState) {
    opState.textContent = monthly.active ? 'Active' : 'Closed';
    opState.className = 'rp-passover-state ' + (monthly.active ? 'active' : 'closed');
  }
  if (opDetail) opDetail.textContent = monthly.label.replace(/^ACTIVE — /, '').replace(/^in /, 'Opens in ');
  if (ccState) {
    ccState.textContent = cc.active ? 'Active' : 'Closed';
    ccState.className = 'rp-passover-state ' + (cc.active ? 'active' : 'closed');
  }
  if (ccDetail) ccDetail.textContent = cc.label.replace(/^ACTIVE — /, '').replace(/^in /, 'Opens in ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────
async function loadProfiles() {
  const loading = document.getElementById('profiles-loading');
  const grid = document.getElementById('profiles-grid');
  loading.textContent = 'Loading profiles…';
  loading.classList.remove('hidden');
  grid.classList.add('hidden');

  try {
    // Fetch profiles first — render immediately, don't wait for SoO
    const profilesRes = await fetch('/api/profiles');
    const profiles = await profilesRes.json();
    if (profiles.error) { loading.textContent = `Error: ${profiles.error}`; return; }
    allProfilesData = profiles;
    loading.classList.add('hidden');
    grid.classList.remove('hidden');
    renderProfiles(profiles);
    renderPassoverBanner();
    updateChipCounts();

    // SoO loads in background — re-render profiles + refresh counts when it arrives
    loadSoOStatus().then(() => {
      if (Object.keys(sooData).length > 0) renderProfiles(allProfilesData);
      updateChipCounts();
      // Refresh greeting now that we can look up the GD's real first
      // name from the First Name column of the State of Operations sheet.
      updateGreeting();
      // Replace the email-fallback in "My identifier for Assigned" with the
      // operator's actual first name from SoO, so the "Assigned to me" chip
      // count matches (the Assignee column is first names, not emails).
      refreshIdentifierDefault();
    }).catch(() => {});
    // Refresh countdown every minute — guard against duplicate timers so
    // multiple loadProfiles() calls don't stack intervals.
    if (!window.__passoverInterval) {
      window.__passoverInterval = setInterval(renderPassoverBanner, 60000);
    }
  } catch (err) {
    loading.textContent = `Failed: ${err.message}`;
  }
}

function renderProfiles(profiles) {
  const grid = document.getElementById('profiles-grid');
  grid.innerHTML = '';

  // Local Browser — rendered into a dedicated host above the GoLogin grid.
  // It has unique semantics (local Chromium, not Orbita) and the first-name
  // input is gated behind the checkbox: we only ask once the operator opts in.
  const localHost = document.getElementById('local-browser-host');
  if (localHost) {
    const isSelected = selectedProfileIds.includes('local-browser');
    localHost.innerHTML = '';
    const localItem = document.createElement('label');
    localItem.className = 'profile-item local-browser local-browser-tile' + (isSelected ? ' selected' : '');
    localItem.dataset.profileId = 'local-browser';
    localItem.innerHTML = `
      <input type="checkbox" class="local-cb" value="local-browser" ${isSelected ? 'checked' : ''} />
      <div class="local-browser-body">
        <div class="name">Local Browser</div>
        <div class="id">Your system Chrome. If this is your first time, you will have to log in to LinkedIn when the Chrome browser pops up locally.</div>
        <div class="local-browser-name-row" ${isSelected ? '' : 'hidden'}>
          <label for="local-browser-first-name" class="local-browser-name-label">Your first name (used as {senderFirstName})</label>
          <input type="text" id="local-browser-first-name" placeholder="e.g. Antonio"
            value="${escHtml(localBrowserFirstName)}" />
        </div>
      </div>
    `;
    const localNameRow = localItem.querySelector('.local-browser-name-row');
    const localNameInput = localItem.querySelector('#local-browser-first-name');
    localNameInput.addEventListener('click', (e) => e.stopPropagation());
    localNameInput.addEventListener('input', (e) => {
      localBrowserFirstName = e.target.value;
      try { localStorage.setItem('localBrowserFirstName', localBrowserFirstName); } catch { /* */ }
      renderSelectedPanel();
    });
    const localCb = localItem.querySelector('input.local-cb');
    localCb.addEventListener('change', () => {
      if (localCb.checked) {
        if (!selectedProfileIds.includes('local-browser')) {
          selectedProfileIds.push('local-browser');
          selectedProfileNames['local-browser'] = 'Local Browser';
        }
        localItem.classList.add('selected');
        if (localNameRow) {
          localNameRow.hidden = false;
          // Auto-focus the name input the first time someone ticks the box —
          // makes the "now we need your name" interaction feel obvious.
          if (!localNameInput.value) setTimeout(() => localNameInput.focus(), 0);
        }
      } else {
        selectedProfileIds = selectedProfileIds.filter(id => id !== 'local-browser');
        delete selectedProfileNames['local-browser'];
        localItem.classList.remove('selected');
        if (localNameRow) localNameRow.hidden = true;
      }
      renderSelectedPanel();
    });
    localHost.appendChild(localItem);
  }

  profiles.forEach((p) => {
    // v2.11.4: keep selectedProfileNames in sync with whatever is currently
    // selected. The change handler below only fires for user clicks, so any
    // programmatic selection (preset load, schedule restore, etc.) was leaving
    // the name map empty — the right pane then fell back to raw GoLogin IDs.
    if (selectedProfileIds.includes(p.id)) {
      selectedProfileNames[p.id] = p.name;
    }
    const item = document.createElement('label');
    item.className = 'profile-item' + (selectedProfileIds.includes(p.id) ? ' selected' : '');
    item.dataset.profileId = p.id;
    const soo = findSoOForProfile(p.name);
    item.innerHTML = `
      <input type="checkbox" value="${p.id}" ${selectedProfileIds.includes(p.id) ? 'checked' : ''} />
      <div style="flex:1">
        <div class="name">${escHtml(p.name)}</div>
        ${!soo ? `<div class="id">${p.id.substring(0, 12)}…</div>` : ''}
        ${renderSoOBadges(soo)}
      </div>
    `;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!selectedProfileIds.includes(p.id)) {
          selectedProfileIds.push(p.id);
          selectedProfileNames[p.id] = p.name;
        }
        item.classList.add('selected');
      } else {
        selectedProfileIds = selectedProfileIds.filter(id => id !== p.id);
        delete selectedProfileNames[p.id];
        item.classList.remove('selected');
      }
      renderSelectedPanel();
      updateCampaignSummary();
    });
    grid.appendChild(item);
  });
  renderSelectedPanel();
  updateCampaignSummary();
}

function renderSelectedPanel() {
  const panel = document.getElementById('selected-panel');
  const list = document.getElementById('selected-list');
  const count = document.getElementById('profiles-count');

  // Right-pane mirror
  const rpCount = document.getElementById('rp-selected-count');
  const rpSub = document.getElementById('rp-selected-sub');
  if (rpCount) rpCount.textContent = String(selectedProfileIds.length);
  if (rpSub) {
    const targets = typeof window.sheetTotalRows === 'number' && window.sheetTotalRows > 0 ? window.sheetTotalRows : 0;
    const accountWord = selectedProfileIds.length === 1 ? 'account' : 'accounts';
    rpSub.textContent = `${accountWord} · ${targets} targets`;
  }
  // Chip selected-only counter
  const chipSel = document.getElementById('chip-count-selected');
  if (chipSel) chipSel.textContent = String(selectedProfileIds.length);

  if (selectedProfileIds.length === 0) {
    panel.classList.add('hidden');
    if (count) count.textContent = `0 selected / ${allProfilesData.length} total`;
    return;
  }

  panel.classList.remove('hidden');
  if (count) count.textContent = `${selectedProfileIds.length} selected / ${allProfilesData.length} total`;

  list.innerHTML = selectedProfileIds.map((id, i) => {
    const name = selectedProfileNames[id] || id;
    const first = resolveSenderFirstName(id, name);
    const senderTag = first
      ? `<span class="sender-first" style="color:#3fb950;font-size:11px;margin-left:6px">→ "${escHtml(first)}"</span>`
      : `<span class="sender-first" style="color:#f85149;font-size:11px;margin-left:6px">⚠ no first name</span>`;
    return `<div class="selected-item">
      <span class="order">${i + 1}</span>
      <span class="name">${escHtml(name)}</span>
      ${senderTag}
      <button class="btn-remove" onclick="removeProfile('${id}')" title="Remove">&times;</button>
    </div>`;
  }).join('');

  // v3.0: keep Post Amp engagement table in sync with profile selection.
  if (typeof renderPostAmpEngagementTable === 'function') {
    renderPostAmpEngagementTable();
  }
}

function removeProfile(id) {
  selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
  delete selectedProfileNames[id];
  const cb = document.querySelector(`#profiles-grid input[value="${id}"]`);
  if (cb) { cb.checked = false; cb.closest('.profile-item')?.classList.remove('selected'); }
  renderSelectedPanel();
}
window.removeProfile = removeProfile;

let activeAccountFilter = 'all';

function filterProfiles() {
  const query = (document.getElementById('profile-search').value || '').trim().toLowerCase();

  let list = allProfilesData;

  // Preset filter (Assigned to me / Unassigned Pool / All)
  if (activePresetFilter && activePresetFilter !== 'all') {
    list = list.filter((p) => matchesPreset(activePresetFilter, findSoOForProfile(p.name)));
  }

  // Chip filter (Available / In use / Selected)
  if (activeAccountFilter !== 'all') {
    list = list.filter((p) => {
      const soo = findSoOForProfile(p.name);
      if (activeAccountFilter === 'selected') return selectedProfileIds.includes(p.id);
      if (!soo) return false;
      const vals = [soo.linkedinCredits, soo.inmailCredits, soo.salesNavCredits, soo.ccCredits].map((v) => (v || '').toLowerCase());
      if (activeAccountFilter === 'available') return vals.some((v) => v === 'available');
      if (activeAccountFilter === 'in-use') return vals.some((v) => v === 'in use' || v === 'in-use' || v === 'used');
      return true;
    });
  }

  // Search by name/email
  if (query) {
    list = list.filter((p) => p.name.toLowerCase().includes(query) || p.id.includes(query));
  }

  renderProfiles(list);
  updateChipCounts();
}

function applyFilter(type) {
  activeAccountFilter = type;
  document.querySelectorAll('.chip[data-filter]').forEach((c) => {
    c.classList.toggle('active', c.dataset.filter === type);
  });
  filterProfiles();
}

function getMyIdentifier() {
  try {
    const saved = localStorage.getItem('ortus-my-identifier');
    if (saved && saved.trim()) return saved.trim().toLowerCase();
  } catch (_) {}
  const chip = document.getElementById('user-chip-email');
  return ((chip?.textContent) || '').trim().toLowerCase();
}

function saveMyIdentifier() {
  const el = document.getElementById('my-identifier');
  if (!el) return;
  // Phase 2.8.19 (C2): a typed save implies the user wants control — set the
  // override flag so refreshIdentifierDefault stops fighting them on later loads.
  if (!el.hasAttribute('readonly')) {
    try {
      localStorage.setItem('ortus-my-identifier', el.value.trim());
      localStorage.setItem('ortus-my-identifier-override', '1');
    } catch (_) {}
  }
  updateChipCounts();
}

function initMyIdentifier() {
  const el = document.getElementById('my-identifier');
  if (!el) return;
  // Always paint the current saved/auto-derived value
  let saved = '';
  try { saved = localStorage.getItem('ortus-my-identifier') || ''; } catch (_) {}
  if (!saved) {
    const chip = document.getElementById('user-chip-email');
    saved = (chip?.textContent || '').trim();
  }
  el.value = saved;
  // Phase 2.8.19 (C2): apply readonly + toggle-link state based on override flag
  applyIdentifierMode();
}

function applyIdentifierMode() {
  const el = document.getElementById('my-identifier');
  const link = document.getElementById('identifier-toggle');
  if (!el) return;
  let overridden = false;
  try { overridden = !!localStorage.getItem('ortus-my-identifier-override'); } catch (_) {}
  if (overridden) {
    el.removeAttribute('readonly');
    if (link) link.textContent = 'Auto';
  } else {
    el.setAttribute('readonly', '');
    if (link) link.textContent = 'Override';
  }
}

function toggleIdentifierMode() {
  let overridden = false;
  try { overridden = !!localStorage.getItem('ortus-my-identifier-override'); } catch (_) {}
  if (overridden) {
    // Switching back to Auto — clear override flag AND clear the saved value so
    // refreshIdentifierDefault / initMyIdentifier can re-populate from SoO/email.
    try {
      localStorage.removeItem('ortus-my-identifier-override');
      localStorage.removeItem('ortus-my-identifier');
    } catch (_) {}
    // Re-derive: re-init from chip, then let SoO refresh take over
    initMyIdentifier();
    if (typeof refreshIdentifierDefault === 'function') refreshIdentifierDefault();
  } else {
    // Entering Override — set flag, keep current value as starting point
    const el = document.getElementById('my-identifier');
    try {
      localStorage.setItem('ortus-my-identifier-override', '1');
      localStorage.setItem('ortus-my-identifier', el?.value?.trim() || '');
    } catch (_) {}
    applyIdentifierMode();
    el?.focus();
  }
  if (typeof updateChipCounts === 'function') updateChipCounts();
}

window.toggleIdentifierMode = toggleIdentifierMode;

/**
 * Defaults the "My identifier for Assigned" input to the operator's SoO
 * first name (e.g. "Antonio") instead of their email. The SoO Assignee
 * column contains short first names, so matching against an email always
 * fails and the "Assigned to me" chip shows 0.
 *
 * Behavior:
 *   - If localStorage has a non-empty custom value that is NOT an email,
 *     respect it (the operator customized it manually).
 *   - Otherwise, if the operator's email resolves to a firstName in sooData,
 *     use that firstName and persist it to localStorage.
 *   - Otherwise, leave the input as-is (the existing email fallback applies).
 *
 * Auto-heal: if localStorage already contains an email from a pre-fix
 * session AND a firstName is now resolvable, overwrite with firstName.
 */
function refreshIdentifierDefault() {
  const el = document.getElementById('my-identifier');
  if (!el) return;
  // Phase 2.8.19 (C2): if user is in Override mode, never auto-overwrite their value.
  let overridden = false;
  try { overridden = !!localStorage.getItem('ortus-my-identifier-override'); } catch (_) {}
  if (overridden) return;
  const emailEl = document.getElementById('user-chip-email');
  const email = ((emailEl?.textContent) || '').trim().toLowerCase();
  if (!email) return;
  const sooEntry = sooData && sooData[email];
  const firstNameRaw = sooEntry && sooEntry.firstName ? sooEntry.firstName.trim() : '';
  if (!firstNameRaw) return; // no SoO match — leave the email fallback alone
  const firstName = firstNameRaw.charAt(0).toUpperCase() + firstNameRaw.slice(1);

  let stored = '';
  try { stored = (localStorage.getItem('ortus-my-identifier') || '').trim(); } catch (_) {}

  // Overwrite only when stored is empty, already an email (auto-heal), or
  // already equals firstName (re-persist canonical casing). A non-empty,
  // non-email stored value that differs from firstName is treated as a
  // deliberate customization and left alone.
  const storedIsEmail = stored.includes('@');
  const shouldOverwrite = !stored || storedIsEmail || stored.toLowerCase() === firstName.toLowerCase();

  if (shouldOverwrite) {
    el.value = firstName;
    try { localStorage.setItem('ortus-my-identifier', firstName); } catch (_) {}
    if (typeof updateChipCounts === 'function') updateChipCounts();
  }
}

let activePresetFilter = 'all';

function matchesPreset(preset, soo) {
  if (!soo) return preset === 'all';
  const section = (soo.section || '').toLowerCase();
  const isPool = section.includes('pool') || section.includes('unassigned');
  if (preset === 'pool') return isPool;
  if (preset === 'assigned') {
    const me = getMyIdentifier();
    if (!me) return false;
    const assignee = (soo['Assignee'] || '').toLowerCase();
    return !isPool && assignee && assignee !== '-' && assignee.includes(me);
  }
  return true; // 'all'
}

function applyPreset(preset) {
  if (preset === 'assigned') {
    const me = getMyIdentifier();
    if (!me) {
      alert('Set your identifier in the "My identifier" field below the presets first.');
      return;
    }
  }

  activePresetFilter = preset;

  document.querySelectorAll('.preset[data-preset]').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });

  filterProfiles();
}

function updateChipCounts() {
  const counts = { all: allProfilesData.length, available: 0, 'in-use': 0, selected: selectedProfileIds.length };
  const me = getMyIdentifier();
  let assignedToMeCount = 0, poolCount = 0;
  allProfilesData.forEach((p) => {
    const soo = findSoOForProfile(p.name);
    if (!soo) return;
    const vals = [soo.linkedinCredits, soo.inmailCredits, soo.salesNavCredits, soo.ccCredits].map((v) => (v || '').toLowerCase());
    if (vals.some((v) => v === 'available')) counts.available++;
    if (vals.some((v) => v === 'in use' || v === 'in-use' || v === 'used')) counts['in-use']++;
    const isPool = (soo.section || '').toLowerCase().includes('pool') ||
                   (soo.section || '').toLowerCase().includes('unassigned');
    const assignee = (soo['Assignee'] || '').toLowerCase();
    if (isPool) poolCount++;
    else if (assignee && assignee !== '-' && me && assignee.includes(me)) {
      assignedToMeCount++;
    }
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('chip-count-all', counts.all);
  set('chip-count-available', counts.available);
  set('chip-count-in-use', counts['in-use']);
  set('chip-count-selected', counts.selected);
  set('preset-count-assigned', assignedToMeCount);
  set('preset-count-pool', poolCount);
  set('preset-count-all-accounts', counts.all);
}

function selectAllVisible() {
  document.querySelectorAll('#profiles-grid input[type="checkbox"]').forEach(cb => {
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    }
  });
}

function deselectAll() {
  selectedProfileIds = [];
  selectedProfileNames = {};
  document.querySelectorAll('#profiles-grid input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
    cb.closest('.profile-item')?.classList.remove('selected');
  });
  renderSelectedPanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// "Add a note while connecting?" toggle
// ─────────────────────────────────────────────────────────────────────────────
// Resolves visibility for the template management UI (Select / Load / Delete /
// Save / Preview Messages). Hidden when:
//   - mode is check_status (no template at all)
//   - mode is connect_only AND the operator answered "No" to "add a note?"
//     (no template = no reason to show the template bar or preview button)
// Called from both onModeChange (mode change) and syncAddNoteUI (Yes/No toggle)
// so both paths agree.
function applyTemplateUIVisibility(mode, addNoteOn) {
  const tplBar = document.getElementById('template-bar');
  const previewBtn = document.getElementById('btn-preview-messages');
  const hide =
    mode === 'check_status' ||
    (mode === 'connect_only' && !addNoteOn);
  const display = hide ? 'none' : '';
  if (tplBar) tplBar.style.display = display;
  if (previewBtn) previewBtn.style.display = display;
}

function syncAddNoteUI(on) {
  const yesBtn = document.getElementById('add-note-yes');
  const noBtn = document.getElementById('add-note-no');
  const connect = document.getElementById('tpl-connect-section');
  if (yesBtn) yesBtn.classList.toggle('active', on);
  if (noBtn) noBtn.classList.toggle('active', !on);
  if (connect) connect.style.display = on ? '' : 'none';
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';
  applyTemplateUIVisibility(mode, on);
}

function setAddNote(on) {
  try { localStorage.setItem('ortus-add-note', on ? '1' : '0'); } catch (_) {}
  syncAddNoteUI(on);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode-based template visibility
// ─────────────────────────────────────────────────────────────────────────────
// 2.8.29: Check Status preview fetch + render.
async function refreshCheckStatusPreview() {
  const url = (document.getElementById('sheet-url')?.value || '').trim();
  const loading = document.getElementById('cs-loading');
  const content = document.getElementById('cs-content');
  const empty = document.getElementById('cs-empty');
  const errBox = document.getElementById('cs-error');
  if (!loading || !content || !empty || !errBox) return;
  loading.style.display = '';
  content.style.display = 'none';
  empty.style.display = 'none';
  errBox.style.display = 'none';

  if (!url) {
    loading.style.display = 'none';
    errBox.textContent = 'Enter a Google Sheet URL above first.';
    errBox.style.display = '';
    return;
  }

  try {
    const r = await fetch('/api/check-status/preview?url=' + encodeURIComponent(url));
    const data = await r.json();
    loading.style.display = 'none';
    if (data.error) { errBox.textContent = data.error; errBox.style.display = ''; return; }
    if (!data.totalPending) { empty.style.display = ''; return; }

    const max = Math.max(1, ...data.byAccount.map(a => a.count));
    const coverageHtml = data.byAccount.map(a => {
      const pct = Math.round((a.count / max) * 100);
      return `<div style="display:grid;grid-template-columns:220px 1fr 60px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--hairline-soft);font-size:13px">
        <div style="font-weight:500">${escHtml(a.name)}</div>
        <div style="height:4px;background:var(--hairline-soft);position:relative"><div style="position:absolute;inset:0 auto 0 0;background:var(--ink);width:${pct}%"></div></div>
        <div style="text-align:right;font-family:var(--display);font-size:18px;letter-spacing:0.04em">${a.count}</div>
      </div>`;
    }).join('');
    document.getElementById('cs-coverage').innerHTML = coverageHtml;

    if (data.unmatched && data.unmatched.length) {
      const unmatchedTotal = data.unmatched.reduce((s, u) => s + u.count, 0);
      document.getElementById('cs-unmatched').innerHTML =
        `⚠ ${unmatchedTotal} row(s) will be skipped — Account Used doesn't match any GoLogin profile in this workspace: ` +
        data.unmatched.map(u => `${escHtml(u.name)} (${u.count})`).join(', ');
    } else {
      document.getElementById('cs-unmatched').innerHTML = '';
    }

    const mins = Math.round(data.runtimeSeconds / 60);
    const runtime = mins >= 60 ? `~${Math.floor(mins/60)}h ${mins%60}m` : `~${mins} min`;
    document.getElementById('cs-summary').innerHTML = `
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.totalPending}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Invites to check</div></div>
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.accountsCount}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Accounts</div></div>
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${runtime}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Estimated runtime</div></div>
    `;
    content.style.display = '';

    // Update Start CTA labels with the count
    ['btn-start', 'btn-start-rb'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.textContent = `Start Check (${data.totalPending} invites)`;
    });
  } catch (err) {
    loading.style.display = 'none';
    errBox.textContent = 'Could not load preview: ' + err.message;
    errBox.style.display = '';
  }
}

// 2.8.32: Message Only preview — same shape as Check Status, filtered by
// "CC ends with Y" instead of "Account Used filled".
async function refreshMessageOnlyPreview() {
  const url = (document.getElementById('sheet-url')?.value || '').trim();
  const loading = document.getElementById('mo-loading');
  const content = document.getElementById('mo-content');
  const empty = document.getElementById('mo-empty');
  const errBox = document.getElementById('mo-error');
  if (!loading || !content || !empty || !errBox) return;
  loading.style.display = '';
  content.style.display = 'none';
  empty.style.display = 'none';
  errBox.style.display = 'none';

  if (!url) {
    loading.style.display = 'none';
    errBox.textContent = 'Enter a Google Sheet URL above first.';
    errBox.style.display = '';
    return;
  }

  try {
    const r = await fetch('/api/check-status/preview?mode=message_only&url=' + encodeURIComponent(url));
    const data = await r.json();
    loading.style.display = 'none';
    if (data.error) { errBox.textContent = data.error; errBox.style.display = ''; return; }
    if (!data.totalPending) { empty.style.display = ''; return; }

    const max = Math.max(1, ...data.byAccount.map(a => a.count));
    const coverageHtml = data.byAccount.map(a => {
      const pct = Math.round((a.count / max) * 100);
      return `<div style="display:grid;grid-template-columns:220px 1fr 60px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--hairline-soft);font-size:13px">
        <div style="font-weight:500">${escHtml(a.name)}</div>
        <div style="height:4px;background:var(--hairline-soft);position:relative"><div style="position:absolute;inset:0 auto 0 0;background:var(--ink);width:${pct}%"></div></div>
        <div style="text-align:right;font-family:var(--display);font-size:18px;letter-spacing:0.04em">${a.count}</div>
      </div>`;
    }).join('');
    document.getElementById('mo-coverage').innerHTML = coverageHtml;

    if (data.unmatched && data.unmatched.length) {
      const unmatchedTotal = data.unmatched.reduce((s, u) => s + u.count, 0);
      document.getElementById('mo-unmatched').innerHTML =
        `⚠ ${unmatchedTotal} row(s) will be skipped — Account Used doesn't match any GoLogin profile in this workspace: ` +
        data.unmatched.map(u => `${escHtml(u.name)} (${u.count})`).join(', ');
    } else {
      document.getElementById('mo-unmatched').innerHTML = '';
    }

    document.getElementById('mo-summary').innerHTML = `
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.totalPending}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Connections to DM</div></div>
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.accountsCount}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Accounts</div></div>
    `;
    content.style.display = '';

    ['btn-start', 'btn-start-rb'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.textContent = `Start Messages (${data.totalPending})`;
    });
  } catch (err) {
    loading.style.display = 'none';
    errBox.textContent = 'Could not load preview: ' + err.message;
    errBox.style.display = '';
  }
}

// 2.9.7: Check DMs preview — same shape as Check Status, filtered by Stage
// in {DM Sent, IC Sent, OP Sent, InM Sent, Replied}.
async function refreshCheckDmsPreview() {
  const url = (document.getElementById('sheet-url')?.value || '').trim();
  const loading = document.getElementById('cd-loading');
  const content = document.getElementById('cd-content');
  const empty = document.getElementById('cd-empty');
  const errBox = document.getElementById('cd-error');
  if (!loading || !content || !empty || !errBox) return;
  loading.style.display = '';
  content.style.display = 'none';
  empty.style.display = 'none';
  errBox.style.display = 'none';

  if (!url) {
    loading.style.display = 'none';
    errBox.textContent = 'Enter a Google Sheet URL above first.';
    errBox.style.display = '';
    return;
  }

  try {
    const r = await fetch('/api/check-dms/preview?url=' + encodeURIComponent(url));
    const data = await r.json();
    loading.style.display = 'none';
    if (data.error) { errBox.textContent = data.error; errBox.style.display = ''; return; }
    if (!data.totalPending) {
      empty.style.display = '';
      ['btn-start', 'btn-start-rb'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.textContent = 'Start Check DMs';
      });
      return;
    }

    const max = Math.max(1, ...data.byAccount.map(a => a.count));
    const coverageHtml = data.byAccount.map(a => {
      const pct = Math.round((a.count / max) * 100);
      return `<div style="display:grid;grid-template-columns:220px 1fr 60px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--hairline-soft);font-size:13px">
        <div style="font-weight:500">${escHtml(a.name)}</div>
        <div style="height:4px;background:var(--hairline-soft);position:relative"><div style="position:absolute;inset:0 auto 0 0;background:var(--ink);width:${pct}%"></div></div>
        <div style="text-align:right;font-family:var(--display);font-size:18px;letter-spacing:0.04em">${a.count}</div>
      </div>`;
    }).join('');
    document.getElementById('cd-coverage').innerHTML = coverageHtml;

    if (data.unmatched && data.unmatched.length) {
      const unmatchedTotal = data.unmatched.reduce((s, u) => s + u.count, 0);
      document.getElementById('cd-unmatched').innerHTML =
        `⚠ ${unmatchedTotal} row(s) will be skipped — Account Used doesn't match any GoLogin profile in this workspace: ` +
        data.unmatched.map(u => `${escHtml(u.name)} (${u.count})`).join(', ');
    } else {
      document.getElementById('cd-unmatched').innerHTML = '';
    }

    const mins = Math.round(data.runtimeSeconds / 60);
    const runtime = mins >= 60 ? `~${Math.floor(mins/60)}h ${mins%60}m` : `~${mins} min`;
    document.getElementById('cd-summary').innerHTML = `
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.totalPending}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Threads to scrape</div></div>
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${data.accountsCount}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Accounts</div></div>
      <div style="flex:1"><div style="font-family:var(--display);font-size:28px;line-height:1">${runtime}</div><div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gray);margin-top:4px">Estimated runtime</div></div>
    `;
    content.style.display = '';

    ['btn-start', 'btn-start-rb'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.textContent = `Start Check DMs (${data.totalPending} threads)`;
    });
  } catch (err) {
    loading.style.display = 'none';
    errBox.textContent = 'Could not load preview: ' + err.message;
    errBox.style.display = '';
  }
}

function onModeChange() {
  const mode = document.getElementById('campaign-mode').value;
  const connect = document.getElementById('tpl-connect-section');
  const message = document.getElementById('tpl-message-section');
  const inmail = document.getElementById('tpl-inmail-section');
  const op = document.getElementById('tpl-op-section');
  const intro = document.getElementById('tpl-intro-section');
  const tplMgmt = document.getElementById('nav-templates');
  const primaryBlock = document.getElementById('primary-person-block');

  connect.style.display = 'none';
  message.style.display = 'none';
  inmail.style.display = 'none';
  if (op) op.style.display = 'none';
  if (intro) intro.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
  if (primaryBlock) primaryBlock.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
  const cadenceBlock = document.getElementById('check-cadence-block');
  if (cadenceBlock) cadenceBlock.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
  const introTitleBlock = document.getElementById('intro-title-block');
  if (introTitleBlock) introTitleBlock.style.display = (mode === 'connect_and_introduce' || mode === 'introduce_back') ? '' : 'none';
  if (tplMgmt) tplMgmt.style.display = (mode === 'check_status') ? 'none' : '';

  // v2.14.x: variable chips are mode-aware (CC+IC hides {intro X},
  // IB hides {primary X}). Refresh on every mode change.
  try { updatePlaceholderTags(); } catch (_) {}

  // Template bar (Select/Load/Delete/Save As…) — visibility is mode-driven plus
  // the connect_only Yes/No toggle. See applyTemplateUIVisibility.
  applyTemplateUIVisibility(mode, localStorage.getItem('ortus-add-note') === '1');

  // The "Add a note?" question only shows when a connection note is meaningful.
  // In connect_only mode it controls whether the Connection Note UI is revealed.
  // In other modes the template UI is mode-driven (no toggle).
  const question = document.getElementById('templates-question');
  const qText = document.getElementById('templates-q-text');
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';
  if (question && qText) {
    if (mode === 'connect_only') {
      question.style.display = '';
      qText.textContent = 'Do you want to add a note while connecting?';
      syncAddNoteUI(addNoteOn);
    } else {
      question.style.display = 'none';
    }
  }

  if (mode === 'connect_only') {
    if (addNoteOn) connect.style.display = '';
    else connect.style.display = 'none';
  } else if (mode === 'message_only' || mode === 'introduce_back') {
    // v2.11.17: introduce_back uses the same Follow-up Message template
    // as message_only; the template is the body of the 3-way DM.
    message.style.display = '';
  } else if (mode === 'inmail_only') {
    inmail.style.display = '';
    // Show OP template as an optional fallback — if filled, InMail mode will
    // try the free OP panel first and only spend a credit when the target
    // isn't Open Profile.
    if (op) op.style.display = '';
  } else if (mode === 'open_profile_only') {
    if (op) op.style.display = '';
  }

  // Swap rate-per-hour ↔ message-gap inputs. Phase 11.2: within-batch gap
  // steppers (D-07) are visible for every non-message mode, hidden in
  // message_only where the existing #message-gap field governs cadence.
  const rateWrap = document.getElementById('rate-per-hour-wrap');
  const gapWrap = document.getElementById('message-gap-wrap');
  const wbMinWrap = document.getElementById('within-batch-min-wrap');
  const wbMaxWrap = document.getElementById('within-batch-max-wrap');
  if (mode === 'message_only') {
    if (rateWrap) rateWrap.style.display = 'none';
    if (gapWrap) gapWrap.style.display = '';
    if (wbMinWrap) wbMinWrap.style.display = 'none';
    if (wbMaxWrap) wbMaxWrap.style.display = 'none';
  } else {
    if (rateWrap) rateWrap.style.display = '';
    if (gapWrap) gapWrap.style.display = 'none';
    if (wbMinWrap) wbMinWrap.style.display = '';
    if (wbMaxWrap) wbMaxWrap.style.display = '';
  }

  // 2.8.29 / 2.8.32 / 2.9.7: Auto-routed modes (check_status, message_only,
  // check_dms, introduce_back) hide the profile picker and show a coverage
  // panel. message_only / introduce_back KEEP templates (you still need a
  // message to send) but hide only the profile picker. check_dms hides
  // everything except the coverage panel.
  const csPanel = document.getElementById('nav-check-status');
  const moPanel = document.getElementById('nav-message-only');
  const cdPanel = document.getElementById('nav-check-dms');
  const ibPanel = document.getElementById('nav-introduce-back');
  const paPanel = document.getElementById('nav-post-amplification');
  const navPace = document.getElementById('nav-pace');
  const navAccounts = document.getElementById('nav-accounts');
  const isCheckStatus = (mode === 'check_status');
  const isMessageOnly = (mode === 'message_only');
  const isCheckDms = (mode === 'check_dms');
  const isIntroduceBack = (mode === 'introduce_back');
  const isPostAmp = (mode === 'post_amplification');
  const isAutoRouted = isCheckStatus || isMessageOnly || isCheckDms || isIntroduceBack;
  if (csPanel) csPanel.style.display = isCheckStatus ? '' : 'none';
  if (moPanel) moPanel.style.display = isMessageOnly ? '' : 'none';
  if (cdPanel) cdPanel.style.display = isCheckDms ? '' : 'none';
  if (ibPanel) ibPanel.style.display = isIntroduceBack ? '' : 'none';
  if (paPanel) paPanel.style.display = isPostAmp ? '' : 'none';
  // 2.9.7: Check DMs is now auto-routed too — hide the profile picker.
  // v3.0: Post Amp KEEPS the profile picker (operator selects participating accounts).
  if (navAccounts) navAccounts.style.display = isAutoRouted ? 'none' : '';
  // Replies section is Check DMs output only — hide for every other mode so
  // the wizard isn't littered with an empty 'No scan yet' panel.
  const repliesSection = document.getElementById('replies-section');
  if (repliesSection) repliesSection.style.display = isCheckDms ? '' : 'none';
  // 2.8.34: Pace section hidden for auto-routed modes (no per-lead pacing).
  // v3.0: Post Amp has its own fixed pace (60-300s gap, baked in).
  if (navPace) navPace.style.display = (isAutoRouted || isPostAmp) ? 'none' : '';
  // 2.9.7: Check DMs has no templates (read-only mode). Hide the templates
  // section entirely; other modes (incl. message_only / introduce_back) keep it visible.
  // v3.0: Post Amp has no message templates — it has its own per-account comment fields.
  const navTemplates = document.getElementById('nav-templates');
  if (navTemplates) navTemplates.style.display = (isCheckDms || isPostAmp) ? 'none' : '';
  // v3.0: Post Amp doesn't read a sheet — hide the Sheet URL section.
  const navSheet = document.getElementById('nav-sheet');
  if (navSheet) navSheet.style.display = isPostAmp ? 'none' : '';
  // Campaign-limit-per-account knob applies ONLY to Connect campaigns (LinkedIn
  // caps invitations per account per day). DM/IC/OP/InMail are unlimited.
  const isConnectMode = (mode === 'connect_only' || mode === 'connect_and_introduce');
  const dailyKnob = document.getElementById('daily-limit-knob');
  if (dailyKnob) dailyKnob.style.display = isConnectMode ? '' : 'none';
  if (isCheckStatus) {
    refreshCheckStatusPreview();
  } else if (isMessageOnly || isIntroduceBack) {
    // v2.11.17: same coverage source as Message Only (Connected · DM Now leads).
    refreshMessageOnlyPreview();
  } else if (isCheckDms) {
    refreshCheckDmsPreview();
  } else if (isPostAmp) {
    // v3.0: render the per-account engagement table from currently selected
    // GoLogin profiles, and load any saved comment templates.
    renderPostAmpEngagementTable();
    renderPostAmpTemplates();
  } else {
    // Reset Start CTA back to default when leaving auto-routed modes.
    ['btn-start', 'btn-start-rb'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.textContent = 'Start Campaign';
    });
  }

  // Persist last-used mode
  try { localStorage.setItem('ortus-last-mode', mode); } catch (_) {}

  // Refresh labels + summary (swaps "connections" ↔ "messages" ↔ "checks")
  updateCampaignSummary();

  // Show message template when open profile toggle is checked
  updateOpenProfileVisibility();

  // Keep kinetic picker in sync
  renderModeSelector();
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.0: Post Amplification (UI shell — Phase 1)
// Per-account engagement table. Operator picks GoLogin profiles via the
// existing nav-accounts picker; rows here mirror that selection. Each row
// has Like / Comment toggles + a comment textarea (enabled only when
// Comment is checked). Comment text can be filled from a hardcoded list of
// suggestions OR from operator-saved templates (localStorage with in-memory
// fallback per the localStorage-blocked rule).
// Backend wiring (engagePost + sequential loop + dedup state) is Phase 2.
// ═══════════════════════════════════════════════════════════════════════════

// Per-profile engagement config: { [profileId]: { like, comment, commentText } }
let postAmpAccountConfig = {};

// Saved comment templates (operator-curated). Persisted to localStorage with
// in-memory fallback when storage is blocked (e.g., Chrome enterprise policy).
let postAmpSavedTemplates = [];
const POST_AMP_TEMPLATES_KEY = 'ortus-post-amp-templates';

// Hardcoded built-in suggestions. Short, reusable, low-effort. Operators
// can extend with their own via "Save as template" and reference the post
// author with {poster first name} / {poster name} placeholders — these are
// resolved per-account at runtime by scraping the actor block from the post.
const POST_AMP_BUILTIN_SUGGESTIONS = [
  // — short reactions
  'Great insight 👏',
  'Spot on',
  'Really well put',
  'Love this',
  'On point',
  '100%',
  'Sharp take',
  'Exactly this',
  // — gratitude / appreciation
  'Thanks for sharing this, {poster first name}',
  'Genuinely useful — thank you',
  'Worth re-reading. Saving for later',
  'Massive value here',
  // — agreement
  'Couldn\'t agree more',
  'Agreed — well said',
  'This is the way',
  // — addressed to author
  '{poster first name} this is brilliant',
  'Always insightful, {poster first name}',
  'Great perspective, {poster first name}',
  // — engagement bait (light)
  'Bookmarking this',
  'Sending this to the team',
  'Gold 🥇',
  'Pivotal observation',
  'Sharp + useful — rare combo',
  'Excellent post',
];

function loadPostAmpTemplates() {
  try {
    const raw = localStorage.getItem(POST_AMP_TEMPLATES_KEY);
    postAmpSavedTemplates = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(postAmpSavedTemplates)) postAmpSavedTemplates = [];
  } catch (_) {
    // localStorage blocked — keep whatever's in memory.
  }
}

function persistPostAmpTemplates() {
  try {
    localStorage.setItem(POST_AMP_TEMPLATES_KEY, JSON.stringify(postAmpSavedTemplates));
  } catch (_) { /* blocked — silently keep in-memory only */ }
}

function renderPostAmpEngagementTable() {
  const tbl = document.getElementById('pa-engagement-table');
  const empty = document.getElementById('pa-engagement-empty');
  const rows = document.getElementById('pa-engagement-rows');
  if (!tbl || !empty || !rows) return;

  // Post Amp is GoLogin-only — strip out 'local-browser' from the table.
  const ids = selectedProfileIds.filter(id => id !== 'local-browser');

  if (ids.length === 0) {
    tbl.style.display = 'none';
    empty.style.display = '';
    return;
  }
  tbl.style.display = '';
  empty.style.display = 'none';

  // Build the suggestion list (built-in + saved). Reused per row when its
  // panel is the currently-open one.
  const allSuggestions = [
    ...POST_AMP_BUILTIN_SUGGESTIONS.map(t => ({ text: t, tag: 'built-in' })),
    ...postAmpSavedTemplates.map(t => ({ text: t, tag: 'saved' })),
  ];

  rows.innerHTML = ids.map(id => {
    const cfg = postAmpAccountConfig[id] || { like: true, comment: false, commentText: '' };
    postAmpAccountConfig[id] = cfg;
    const name = selectedProfileNames[id] || id;
    const offCls = cfg.comment ? '' : ' is-comment-off';
    const isPanelOpen = postAmpSuggestionsOpenForId === id;
    const panel = isPanelOpen
      ? `<div class="pa-suggest-pop">
           ${allSuggestions.length === 0
             ? '<div class="pa-suggest-pop-item" style="cursor:default;color:var(--gray)">No suggestions yet — type a comment and Save as template.</div>'
             : allSuggestions.map((it, i) =>
                 `<div class="pa-suggest-pop-item" onclick="pickPostAmpSuggestion('${id}', ${i})"><span>${escHtml(it.text)}</span><span class="pa-suggest-pop-tag">${it.tag}</span></div>`
               ).join('')
           }
         </div>`
      : '';
    return `<tr>
      <td>
        <div class="pa-name">${escHtml(name)}</div>
        <div class="pa-id">${escHtml(id)}</div>
      </td>
      <td><label class="pa-toggle"><input type="checkbox" ${cfg.like ? 'checked' : ''} onchange="setPostAmpFlag('${id}','like',this.checked)"></label></td>
      <td><label class="pa-toggle"><input type="checkbox" ${cfg.comment ? 'checked' : ''} onchange="setPostAmpFlag('${id}','comment',this.checked)"></label></td>
      <td>
        <textarea class="pa-comment${offCls}" id="pa-comment-${id}" placeholder="Comment text…" oninput="setPostAmpComment('${id}',this.value)">${escHtml(cfg.commentText || '')}</textarea>
        <div class="pa-suggest-row">
          <button type="button" class="pa-suggest-link" onclick="openPostAmpSuggestions('${id}', event)">Suggestions ${isPanelOpen ? '▴' : '▾'}</button>
          <span>·</span>
          <button type="button" class="pa-suggest-link" onclick="savePostAmpTemplate('${id}')">Save as template</button>
        </div>
        ${panel}
      </td>
    </tr>`;
  }).join('');
}

function setPostAmpFlag(profileId, flag, value) {
  const cfg = postAmpAccountConfig[profileId] || { like: true, comment: false, commentText: '' };
  cfg[flag] = !!value;
  postAmpAccountConfig[profileId] = cfg;
  // Re-render so the comment textarea / suggest links flip enabled state.
  renderPostAmpEngagementTable();
}

function setPostAmpComment(profileId, text) {
  const cfg = postAmpAccountConfig[profileId] || { like: true, comment: false, commentText: '' };
  cfg.commentText = text;
  // Auto-enable Comment when the operator starts typing — typing IS intent.
  // If they later clear the field and uncheck Comment, that's fine; this
  // only flips off→on, never on→off.
  const wasOff = !cfg.comment;
  if (text.trim() && !cfg.comment) cfg.comment = true;
  postAmpAccountConfig[profileId] = cfg;
  if (wasOff && cfg.comment) {
    // Re-render the row so the Comment checkbox visually flips and the
    // dim CSS lifts.
    renderPostAmpEngagementTable();
    // Restore focus + caret position after the re-render.
    setTimeout(() => {
      const ta = document.getElementById(`pa-comment-${profileId}`);
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 0);
  }
}

function onPostAmpUrlChange() {
  // Placeholder for v1 — Phase 2 will validate format and surface a hint.
  // No state to persist for now; the URL is read on Start.
}

// Suggestions popover — rendered inline as a sibling of the suggest-row
// (NOT appended to body, NOT absolutely positioned). v2.13.2 used
// position:fixed + body-append; user reported "nothing opens up". Without
// DevTools access we can't pin the exact reason, but inline rendering
// removes every plausible failure mode (body-append timing, fixed-positioning
// stacking-context bugs, document-level click eating the open click).
//
// Trade-off: when the panel opens it pushes the next row down. That's fine
// — the operator opened it deliberately, and they close it with another
// click on Suggestions or by picking an item.
let postAmpSuggestionsOpenForId = null;

function openPostAmpSuggestions(profileId, evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  // Toggle: clicking Suggestions on the same row again closes the panel.
  if (postAmpSuggestionsOpenForId === profileId) {
    closePostAmpSuggestions();
    return;
  }
  closePostAmpSuggestions(); // close any previously-open panel
  postAmpSuggestionsOpenForId = profileId;
  renderPostAmpEngagementTable();
  // Outside-click closer (deferred so this very click doesn't immediately fire it).
  setTimeout(() => {
    document.addEventListener('click', handlePostAmpOutsideClick, { capture: true });
  }, 0);
}

function handlePostAmpOutsideClick(e) {
  // Don't close if the click landed inside an open suggestions panel or on
  // a Suggestions trigger button. Otherwise close.
  if (e.target.closest && (e.target.closest('.pa-suggest-pop') || e.target.closest('.pa-suggest-link'))) {
    return;
  }
  closePostAmpSuggestions();
}

function closePostAmpSuggestions() {
  document.removeEventListener('click', handlePostAmpOutsideClick, { capture: true });
  if (postAmpSuggestionsOpenForId !== null) {
    postAmpSuggestionsOpenForId = null;
    renderPostAmpEngagementTable();
  }
}

function pickPostAmpSuggestion(profileId, idx) {
  // Rebuild the suggestion list the same way renderPostAmpEngagementTable
  // does, then index into it. Source of truth is the constant + saved list.
  const items = [
    ...POST_AMP_BUILTIN_SUGGESTIONS.map(t => ({ text: t, tag: 'built-in' })),
    ...postAmpSavedTemplates.map(t => ({ text: t, tag: 'saved' })),
  ];
  const pick = items[idx];
  if (!pick) return;
  const cfg = postAmpAccountConfig[profileId] || { like: true, comment: true, commentText: '' };
  cfg.comment = true; // picking a suggestion implies intent to comment
  cfg.commentText = (cfg.commentText || '').trim();
  cfg.commentText = cfg.commentText ? `${cfg.commentText} ${pick.text}` : pick.text;
  postAmpAccountConfig[profileId] = cfg;
  closePostAmpSuggestions(); // also re-renders
  // Restore focus to the textarea after re-render.
  setTimeout(() => {
    const fresh = document.getElementById(`pa-comment-${profileId}`);
    if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
  }, 0);
}

function savePostAmpTemplate(profileId) {
  const cfg = postAmpAccountConfig[profileId];
  const text = (cfg && cfg.commentText || '').trim();
  if (!text) {
    showCampaignToast('Type a comment first, then save it as a template.', 2500);
    return;
  }
  if (postAmpSavedTemplates.includes(text)) {
    showCampaignToast('Already saved.', 1800);
    return;
  }
  postAmpSavedTemplates.push(text);
  persistPostAmpTemplates();
  renderPostAmpTemplates();
  showCampaignToast('Template saved.', 1500);
}

function deletePostAmpTemplate(idx) {
  if (idx < 0 || idx >= postAmpSavedTemplates.length) return;
  postAmpSavedTemplates.splice(idx, 1);
  persistPostAmpTemplates();
  renderPostAmpTemplates();
}

function renderPostAmpTemplates() {
  const list = document.getElementById('pa-templates-list');
  const empty = document.getElementById('pa-templates-empty');
  const count = document.getElementById('pa-templates-count');
  if (!list || !empty || !count) return;
  count.textContent = `(${postAmpSavedTemplates.length})`;
  if (postAmpSavedTemplates.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = postAmpSavedTemplates.map((t, i) =>
    `<li><span class="pa-tpl-text" title="${escHtml(t)}">${escHtml(t)}</span><button type="button" class="pa-tpl-del" onclick="deletePostAmpTemplate(${i})" title="Remove">×</button></li>`
  ).join('');
}

// Validation helper used by startCampaign() short-circuit.
function validatePostAmpStart() {
  const url = (document.getElementById('pa-post-url')?.value || '').trim();
  if (!url) return { ok: false, reason: 'Paste a LinkedIn post URL.' };
  if (!/linkedin\.com\/posts\/[^/]+/.test(url)) {
    return { ok: false, reason: 'URL must be a linkedin.com/posts/<slug>-<id> link.' };
  }
  const ids = selectedProfileIds.filter(id => id !== 'local-browser');
  if (ids.length === 0) return { ok: false, reason: 'Select at least one GoLogin account.' };
  const active = ids.filter(id => {
    const cfg = postAmpAccountConfig[id] || {};
    return cfg.like || (cfg.comment && (cfg.commentText || '').trim());
  });
  if (active.length === 0) {
    return { ok: false, reason: 'At least one selected account must have Like or a non-empty Comment turned on.' };
  }
  return { ok: true, url, accounts: ids, active };
}

// startCampaign hook — POST to /api/post-amplification/start, then poll
// /status until it finishes. Live progress is mirrored into campaign.logs
// on the server side, so the existing Live Status panel renders the run
// without a parallel UI.
let postAmpPollTimer = null;

async function startPostAmplification() {
  const v = validatePostAmpStart();
  if (!v.ok) { alert(v.reason); return; }

  const accountConfigs = v.accounts.map(id => {
    const cfg = postAmpAccountConfig[id] || {};
    return {
      profileId: id,
      profileName: selectedProfileNames[id] || id,
      like: !!cfg.like,
      comment: !!cfg.comment,
      commentText: (cfg.commentText || '').trim(),
    };
  });

  const summary = `Post Amplification\n\nPost: ${v.url}\nAccounts: ${accountConfigs.length}\n` +
    `  • Like: ${accountConfigs.filter(c => c.like).length}\n` +
    `  • Comment: ${accountConfigs.filter(c => c.comment && c.commentText).length}\n\n` +
    `Pace: 60-300s between accounts (sequential).\nDedup: accounts that already reacted are skipped.\n\nStart?`;
  if (!confirm(summary)) return;

  let resp;
  try {
    resp = await fetch('/api/post-amplification/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postUrl: v.url, accountConfigs, name: '' }),
    });
  } catch (err) {
    alert(`Could not reach server: ${err.message}`);
    return;
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    alert(`Could not start: ${body.error || resp.statusText}`);
    return;
  }
  showCampaignToast(`Post Amplification started · ${body.total} account(s)`, 3500);
  // Kick off the cockpit poll loop. pollStatus() reads /api/campaign/status
  // which now overlays Post Amp state when postAmp.running is true, AND it
  // does its own client-side overlay from /api/post-amplification/status as
  // defence in depth. Without this call, __cockpit never gets fed and the
  // Live Status panel stays stuck in its initial IDLE state.
  startPolling();
  pollPostAmpStatus();
}

function pollPostAmpStatus() {
  if (postAmpPollTimer) clearInterval(postAmpPollTimer);
  postAmpPollTimer = setInterval(async () => {
    let r;
    try { r = await fetch('/api/post-amplification/status').then(x => x.json()); }
    catch { return; }
    if (!r) return;
    if (!r.running) {
      clearInterval(postAmpPollTimer);
      postAmpPollTimer = null;
      const msg = `Post Amplification finished · engaged ${r.engaged}/${r.total} · skipped-dedup ${r.skippedDedup} · errors ${r.errors?.length || 0}`;
      showCampaignToast(msg, 5000);
      // Refresh the past-campaigns list so the new entry shows up.
      if (typeof refreshPastCampaigns === 'function') refreshPastCampaigns();
    }
  }, 2500);
}

async function stopPostAmplification() {
  try {
    const r = await fetch('/api/post-amplification/stop', { method: 'POST' });
    if (r.ok) showCampaignToast('Stop requested', 1500);
  } catch (_) { /* */ }
}

// Initialize templates on script load (idempotent, safe before DOM is ready).
loadPostAmpTemplates();

function restoreLastMode() {
  const select = document.getElementById('campaign-mode');
  if (!select) return;
  try {
    const saved = localStorage.getItem('ortus-last-mode');
    if (saved && Array.from(select.options).some((o) => o.value === saved)) {
      select.value = saved;
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Mode picker — card grid
// ─────────────────────────────────────────────────────────────────────────────
const MODE_LIST = [
  {
    value: 'connect_only',
    name: 'Connect Only',
    bullets: [
      'Send connection requests to new profiles',
      'Optional personalised note',
      'Safest, highest-volume top-of-funnel mode',
    ],
  },
  {
    value: 'check_status',
    name: 'Check Status',
    bullets: [
      'Verify which pending requests were accepted',
      'Updates the lead sheet automatically',
      'Read-only — no messages sent',
    ],
  },
  // Connect + Introduce Back: full cold-lead-to-intro flow. Sends a connect
  // request, waits for acceptance (verified by bulk-check), then auto-DMs
  // the lead introducing them to a configured "primary person". Distinct
  // from `introduce_back` which assumes the lead is already 1st-degree.
  {
    value: 'connect_and_introduce',
    name: 'Connect + Introduce Back',
    bullets: [
      'Send connection requests to new profiles',
      'Once accepted, auto-DM with an intro to a primary person',
      'End-to-end cold-lead → intro pipeline',
    ],
  },
  {
    value: 'message_only',
    name: 'Message Only',
    bullets: [
      'Follow-up messages to 1st-degree connections',
      'Skips pending or not-yet-connected leads',
      'Fast, low-risk after the connection step',
    ],
  },
  {
    value: 'inmail_only',
    name: 'InMail Only',
    bullets: [
      'Premium InMail to non-connected targets',
      'Consumes InMail credits per send',
      'Use during passover windows',
    ],
  },
  {
    value: 'open_profile_only',
    name: 'Open Profile Message',
    bullets: [
      'Free direct message to Open Profile members',
      'No connection required, no credits used',
      'Optional fallback to a connect request',
    ],
  },
  // 2.9.5: Check DMs as a first-class campaign mode. Routes to /api/check-dms/start
  // when started, not /api/campaign/start. Read-only.
  {
    value: 'check_dms',
    name: 'Check DMs',
    bullets: [
      'Scan LinkedIn inboxes for new replies',
      'Append new messages to the Replies tab',
      'Bump lead Stage to "Replied" on inbound',
    ],
  },
  // v2.11.17: Introduce Back is now a first-class mode (was a coming-soon
  // stub + a sub-toggle inside Message Only). Same lead source as
  // Message Only (Stage === 'Connected · DM Now') but always sends as a
  // 3-way intro group thread with the configured intro person.
  {
    value: 'introduce_back',
    name: 'Introduce Back',
    bullets: [
      '3-way group DM',
      'Adds your intro person automatically',
      'Resumes from sheet\'s Connected · DM Now leads',
    ],
  },
  // v3.0: Post Amplification — paste a LinkedIn post URL, picked GoLogin
  // accounts open it sequentially and react / comment per the operator's
  // per-account config. 80% Like / 20% rotation across the 5 other reactions.
  // 60-300s gap between accounts. Dedup state file prevents double-engaging.
  {
    value: 'post_amplification',
    name: 'Post Amplification',
    bullets: [
      'Paste a LinkedIn post URL',
      'Per-account: Like + optional Comment',
      '80% Like · 20% mixed reactions',
    ],
  },
];

function renderModeSelector() {
  const select = document.getElementById('campaign-mode');
  const grid = document.getElementById('mode-grid');
  if (!select || !grid) return;

  const current = select.value;
  let activeIdx = MODE_LIST.findIndex((m) => m.value === current);
  if (activeIdx < 0) activeIdx = 0;

  // Per-mode label overrides via the generic "Edit labels" flow.
  const saved = loadEditsFromStorage();
  const nameFor = (m) => saved[`mode-name-${m.value}`] || m.name;

  grid.innerHTML = MODE_LIST.map((m, i) => {
    const bullets = m.bullets
      .map((b) => `<li>${escHtml(b)}</li>`)
      .join('');
    const isActive = i === activeIdx && !m.comingSoon;
    const stateClass = m.comingSoon ? 'is-coming-soon' : (isActive ? 'active' : '');
    const badge = m.comingSoon ? '<span class="mode-card-badge">Coming soon</span>' : '';
    return `
      <button type="button"
        class="mode-card ${stateClass}"
        onclick="setModeByIndex(${i})"
        aria-pressed="${isActive}">
        ${badge}
        <div class="mode-card-title" data-edit="mode-name-${m.value}">${escHtml(nameFor(m))}</div>
        <ul class="mode-card-bullets">${bullets}</ul>
      </button>
    `;
  }).join('');
}

function setModeByIndex(i) {
  const mode = MODE_LIST[(i + MODE_LIST.length) % MODE_LIST.length];
  if (mode.comingSoon) {
    showCampaignToast(`${mode.name} — coming soon.`, 3000);
    return;
  }
  const select = document.getElementById('campaign-mode');
  if (!select) return;
  select.value = mode.value;
  onModeChange();
  renderModeSelector();
}

function updateOpenProfileVisibility() {
  const cb = document.getElementById('open-profile-msg');
  const op = document.getElementById('tpl-op-section');
  const mode = document.getElementById('campaign-mode').value;
  if (cb && cb.checked && mode === 'connect_only' && op) {
    // Connection campaign with "Message Open Profiles Directly" — OP template
    // is required (it's the message we'll send on OP-enabled leads).
    op.style.display = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder tags
// ─────────────────────────────────────────────────────────────────────────────
function updatePlaceholderTags() {
  // v2.14.x: chip list is now mode-aware.
  //   - Empty/whitespace sheet columns dropped (a trailing-comma column
  //     header in the CSV used to produce a stray `{}` chip).
  //   - In CC+IC mode, {intro X} chips are hidden because they're aliases
  //     of {primary X} (auto-intro.js sets introName = primaryName). Showing
  //     both confused operators.
  //   - In IB mode, {primary X} chips are hidden — that mode has no primary
  //     concept; the introduction target is configured via the intro
  //     section's name field.
  //   - {primary name} renamed to {primary full name} for clarity vs
  //     {primary first name} / {primary last name}. auto-intro.js maps both
  //     keys to the same value so old templates with {primary name} still
  //     resolve.
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';
  const isCcIc = mode === 'connect_and_introduce';
  const isIb   = mode === 'introduce_back';

  const senderChips  = ['senderFirstName', 'senderName'];
  const introChips   = ['intro first name', 'intro last name'];
  const primaryChips = ['primary full name', 'primary first name', 'primary last name', 'primary url'];

  const extras = [
    ...senderChips,
    ...(isCcIc ? [] : introChips),
    ...(isIb   ? [] : primaryChips),
  ];

  const sheetCols = (Array.isArray(sheetColumns) ? sheetColumns : [])
    .filter((c) => typeof c === 'string' && c.trim().length > 0);

  document.querySelectorAll('.placeholder-tags').forEach(container => {
    const tags = [...sheetCols, ...extras].map(col =>
      `<span class="tag" data-val="{${col}}">{${col}}</span>`
    ).join('');
    container.innerHTML = tags;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet preview
// ─────────────────────────────────────────────────────────────────────────────
async function previewSheet() {
  const url = document.getElementById('sheet-url').value.trim();
  const preview = document.getElementById('sheet-preview');
  if (!url) { alert('Enter a Google Sheet URL first.'); return; }
  preview.classList.remove('hidden');
  preview.innerHTML = 'Loading…';
  try {
    const res = await fetch(`/api/sheet/preview?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (data.error) { preview.innerHTML = `<p style="color:#f85149">Error: ${escHtml(data.error)}</p>`; return; }
    let html = `<p style="color:#8b949e; font-size:0.8rem; margin-bottom:8px">${data.totalRows} row(s)</p>`;
    if (data.preview.length > 0) {
      html += '<table class="preview-table"><thead><tr>';
      data.columns.forEach(col => { html += `<th>${escHtml(col)}</th>`; });
      html += '</tr></thead><tbody>';
      data.preview.forEach(row => {
        html += '<tr>';
        data.columns.forEach(col => { html += `<td>${escHtml(row[col] || '')}</td>`; });
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    // Column selector — show as letter + header name, auto-detect by scanning values
    html += `<div style="margin-top:10px">
      <label for="linkedin-col-select" style="font-size:0.8rem">Which column contains the LinkedIn URLs?</label>
      <select id="linkedin-col-select" style="margin-top:4px">`;
    // Auto-detect: scan sample rows for any value containing linkedin.com
    let autoDetectCol = null;
    if (data.preview && data.preview.length > 0) {
      for (const col of data.columns) {
        for (const row of data.preview) {
          const val = (row[col] || '').toLowerCase();
          if (val.includes('linkedin.com')) { autoDetectCol = col; break; }
        }
        if (autoDetectCol) break;
      }
    }
    data.columns.forEach((col) => {
      const selected = (autoDetectCol && col === autoDetectCol) ? 'selected' : '';
      html += `<option value="${escHtml(col)}" ${selected}>${escHtml(col)}</option>`;
    });
    html += `</select></div>`;

    preview.innerHTML = html;
    sheetColumns = data.columns;
    window.sheetTotalRows = typeof data.totalRows === 'number' ? data.totalRows : null;
    try { window.__sheetPreviewCache = { count: (typeof data.totalRows === 'number' ? data.totalRows : 0), at: Date.now() }; } catch (_) {}
    try { if (typeof updateSectionSummaries === 'function') updateSectionSummaries(); } catch (_) {}
    updatePlaceholderTags();
    updateCampaignSummary();
  } catch (err) {
    preview.innerHTML = `<p style="color:#f85149">${escHtml(err.message)}</p>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign summary calculator
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// v2.11.0 — Throughput panel. The leads/hour knob (alpha-leads-per-hour) has
// been removed entirely. The campaign now runs as fast as the queue can rotate
// with a 6-min per-account turn floor enforced server-side. Only the per-account
// campaign limit remains user-tunable.
// alphaSyncRate / alphaStepLeads kept as no-op stubs because some inline
// onclick="" handlers and old presets still reference them; deletion would
// surface ReferenceErrors in console without behavioral benefit.
function alphaSyncRate() { updateCampaignSummary(); }
function alphaStepLeads(_delta) { updateCampaignSummary(); }

// Campaign-limit-per-account (was "Daily limit"). Mirrors the visible input to
// the hidden #daily-limit input that app.js submits to the backend.
function alphaSyncDailyLimit() {
  const visEl = document.getElementById('daily-limit-input');
  const hidEl = document.getElementById('daily-limit');
  if (!visEl || !hidEl) return;
  let v = parseInt(visEl.value, 10);
  if (!Number.isFinite(v) || v < 1) v = 50;
  v = Math.max(1, Math.min(500, v));
  if (parseInt(visEl.value, 10) !== v) visEl.value = String(v);
  hidEl.value = String(v);
  updateCampaignSummary();
}

function alphaStepDaily(delta) {
  const visEl = document.getElementById('daily-limit-input');
  if (!visEl) return;
  const cur = parseInt(visEl.value, 10) || 50;
  visEl.value = String(Math.max(1, Math.min(500, cur + delta)));
  alphaSyncDailyLimit();
}

// 2.9.8: Concurrency toggle. Enables/disables the count input and updates
// the campaign summary. Visibility (≥5 accounts) is handled in alphaRecalc.
function alphaSyncConcurrency() {
  const tog = document.getElementById('concurrency-toggle');
  const cnt = document.getElementById('concurrency-count');
  if (!tog || !cnt) return;
  cnt.disabled = !tog.checked;
  updateCampaignSummary();
}

function alphaRecalc() {
  // v2.11.0: simpler model. Total max invites this run = N accounts × campaign limit.
  const totalEl = document.getElementById('alpha-total-leads');
  const acctCountEl = document.getElementById('alpha-acct-count');
  const perAcctEl = document.getElementById('alpha-per-acct');
  const eqTotalEl = document.getElementById('alpha-eq-total');
  if (!totalEl) return; // panel not on page — nothing to do

  const numAccounts = Array.isArray(selectedProfileIds) ? selectedProfileIds.length : 0;
  const dailyLimit = parseInt(document.getElementById('daily-limit')?.value, 10) || 50;
  const total = dailyLimit * numAccounts;

  totalEl.textContent = total > 0 ? String(total) : '—';
  if (acctCountEl) acctCountEl.textContent = String(numAccounts);
  if (perAcctEl)   perAcctEl.textContent   = String(dailyLimit);
  if (eqTotalEl)   eqTotalEl.textContent   = String(total);

  // Concurrency toggle unlocked at ≥2 accounts (the mathematical minimum).
  // Previous gate was ≥5 — too restrictive; concurrency is useful at 2-4
  // accounts too. Hide entirely when only one account is selected.
  const concurrencyRow = document.getElementById('alpha-concurrency-row');
  if (concurrencyRow) {
    concurrencyRow.style.display = numAccounts >= 2 ? '' : 'none';
  }
}

function updateCampaignSummary() {
  // Phase 2.8.14: alpha throughput panel recalculates whenever this fires
  // (account toggle, rate/pause edit). Safe to call before alpha is ready —
  // it null-guards every element lookup.
  alphaRecalc();
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';

  // v2.11.0: vocabulary kept for hero copy. Rate/limit labels are gone from UI;
  // these strings only feed the summary block.
  const MODE_WORDS = {
    connect_only:        { action: 'connections',            actionVerb: 'sending'  },
    message_only:        { action: 'messages',               actionVerb: 'sending'  },
    inmail_only:         { action: 'InMails',                actionVerb: 'sending'  },
    open_profile_only:   { action: 'Open Profile messages',  actionVerb: 'sending'  },
    check_status:        { action: 'checks',                 actionVerb: 'checking' },
  };
  const words = MODE_WORDS[mode] || MODE_WORDS.connect_only;

  // Cap the daily-limit input at the sheet row count once known.
  const limitInput = document.getElementById('daily-limit');
  const rows = typeof window.sheetTotalRows === 'number' && window.sheetTotalRows > 0 ? window.sheetTotalRows : null;
  if (limitInput && rows) {
    limitInput.max = String(rows);
    const current = parseInt(limitInput.value, 10) || 0;
    if (current > rows) limitInput.value = String(rows);
  }

  const limit = parseInt(document.getElementById('daily-limit').value, 10) || 50;
  const numAccounts = selectedProfileIds.length;

  // v2.11.0: throughput math — each account does up to 5 leads per turn with a
  // 6-min minimum between turns → ceiling of ~50 leads/hr per active worker.
  // With C concurrent workers, real throughput ≈ 50 × C leads/hr (capped by
  // total invites = limit × numAccounts).
  const concurrencyToggle = document.getElementById('concurrency-toggle');
  const concurrencyCount = document.getElementById('concurrency-count');
  const concurrency = (concurrencyToggle?.checked && numAccounts >= 5)
    ? Math.max(1, Math.min(5, parseInt(concurrencyCount?.value, 10) || 2))
    : 1;
  const TURN_FLOOR_MIN = 6;
  const LEADS_PER_BATCH = 5;
  const perAccountLeadsPerHour = (60 / TURN_FLOOR_MIN) * LEADS_PER_BATCH; // 50
  const effectiveLeadsPerHour = perAccountLeadsPerHour * concurrency;

  const dailyTotal = limit * numAccounts;
  // Total leads to process — only known once the operator has previewed the
  // sheet. Falls back to today's batch (dailyTotal) when unknown so the
  // "select accounts to see forecast" path keeps working.
  const leadsInSheet = (typeof window.sheetTotalRows === 'number' && window.sheetTotalRows > 0)
    ? window.sheetTotalRows
    : null;
  const isMultiDay = leadsInSheet !== null && leadsInSheet > dailyTotal && dailyTotal > 0;

  // "Actions" cell shows total leads to process when the campaign spans more
  // than today; otherwise today's batch.
  const totalActions = isMultiDay ? leadsInSheet : dailyTotal;

  // Duration:
  // - single-day:  totalActions / leadsPerHour, expressed in minutes
  // - multi-day:   ceil(leadsInSheet / dailyTotal) days, expressed in days/weeks
  let durationStr, finishStr, minutesNeededSingleDay = 0;
  if (isMultiDay) {
    const daysNeeded = Math.ceil(leadsInSheet / dailyTotal);
    durationStr = daysNeeded < 7
      ? `${daysNeeded} day${daysNeeded === 1 ? '' : 's'}`
      : daysNeeded < 14
        ? `${daysNeeded} days · ~${Math.round(daysNeeded / 7)} week`
        : `${daysNeeded} days · ~${Math.round(daysNeeded / 7)} weeks`;
    const finishDate = new Date(Date.now() + daysNeeded * 86400000);
    finishStr = finishDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    minutesNeededSingleDay = totalActions > 0
      ? Math.max(1, Math.ceil((totalActions / effectiveLeadsPerHour) * 60))
      : 0;
    durationStr = minutesNeededSingleDay === 0
      ? '—'
      : minutesNeededSingleDay < 60
        ? `${minutesNeededSingleDay} min`
        : `${Math.floor(minutesNeededSingleDay / 60)}h ${minutesNeededSingleDay % 60}m`;
    const finishTime = new Date(Date.now() + minutesNeededSingleDay * 60 * 1000);
    finishStr = minutesNeededSingleDay === 0
      ? '—'
      : finishTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const el = document.getElementById('summary-stats');
  if (el) {
    const accountWord = numAccounts === 1 ? 'account' : 'accounts';
    const summaryFinish = isMultiDay ? `around ${finishStr}` : finishStr;
    el.innerHTML = `
      <div><strong>${numAccounts} ${accountWord}</strong>, up to <strong>${limit}</strong> ${words.action} per account per day</div>
      <div>= up to <strong>${dailyTotal}</strong> ${words.action}/day · <strong>${leadsInSheet ?? '?'}</strong> in sheet</div>
      <div style="margin-top:6px">&#9200; Starts now &#8594; ${isMultiDay ? `finishes ~<strong>${finishStr}</strong>` : `finishes ~<strong>${summaryFinish}</strong>`}</div>
    `;
  }

  // Launch hero mirror
  const ln = document.getElementById('launch-number');
  if (ln) ln.textContent = String(dailyTotal); // big number = daily rate
  const lc = document.getElementById('launch-connections');
  if (lc) {
    lc.textContent = leadsInSheet
      ? `${dailyTotal}/day · ${leadsInSheet} in sheet`
      : `${dailyTotal} ${words.action}/day`;
  }
  const la = document.getElementById('launch-accounts');
  if (la) la.textContent = String(numAccounts);
  const le = document.getElementById('launch-eta');
  if (le) le.textContent = durationStr;

  // Settings-section campaign hero
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const accountWord = numAccounts === 1 ? 'account' : 'accounts';
  // Phase 2.8.16: when no accounts selected, show "—" everywhere instead of
  // misleading numbers derived from a default-of-1.
  if (numAccounts === 0) {
    setText('hero-actions', '—');
    setText('hero-actions-sub', `select accounts to see forecast`);
    setText('hero-duration', '—');
    setText('hero-duration-sub', '—');
    setText('hero-finish', '—');
    setText('hero-finish-sub', '—');
  } else {
    setText('hero-actions', String(totalActions));
    setText(
      'hero-actions-sub',
      isMultiDay
        ? `leads to process · ${dailyTotal}/day cap`
        : `${numAccounts} ${accountWord} × ${limit} per day`,
    );
    setText('hero-duration', durationStr);
    setText(
      'hero-duration-sub',
      isMultiDay
        ? `~${effectiveLeadsPerHour} ${words.action}/hr active`
        : `~${effectiveLeadsPerHour} ${words.action}/hr (${concurrency} parallel)`,
    );
    setText('hero-finish', finishStr);
    setText('hero-finish-sub', isMultiDay ? `estimated · LinkedIn caps may slow this` : `from now · local time`);
  }
}

// Stepper helper — increments/decrements a number input and fires its oninput
function stepInput(inputId, delta) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const cur = parseInt(el.value, 10) || 0;
  const min = parseInt(el.min, 10);
  const max = parseInt(el.max, 10);
  let next = cur + delta;
  if (!isNaN(min)) next = Math.max(min, next);
  if (!isNaN(max)) next = Math.min(max, next);
  el.value = String(next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign control
// ─────────────────────────────────────────────────────────────────────────────
async function startCampaign() {
  // 2.9.5: when mode is check_dms, this is a separate flow with its own
  // endpoint and no campaign templates. Delegate to startCheckDms() and
  // return — the rest of this function only applies to outreach campaigns.
  const _modeEarly = document.getElementById('campaign-mode').value;
  if (_modeEarly === 'check_dms') {
    return startCheckDms();
  }
  // v3.0 (Phase 2): Post Amp has its own flow — no sheet, no templates, no
  // SoO sender resolution, own backend endpoint.
  if (_modeEarly === 'post_amplification') {
    return startPostAmplification();
  }

  // 2.8.29 / 2.8.31: check_status and message_only auto-derive profiles from
  // the sheet's Account Used column. UI selection ignored — skip validation.
  const _modeForValidation = _modeEarly;
  if (_modeForValidation !== 'check_status' && _modeForValidation !== 'message_only' && selectedProfileIds.length === 0) {
    alert('Select at least one GoLogin profile.'); return;
  }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }
  const dailyLimit = parseInt(document.getElementById('daily-limit').value, 10);
  if (!dailyLimit || dailyLimit < 1) { alert('Limit must be at least 1.'); return; }

  // "Message Open Profiles Directly" in Connection Campaign mode sends either
  // an OP message (if the lead is OP) or a connection request (if not), so
  // both templates must be filled before the campaign can start.
  const _mode = document.getElementById('campaign-mode').value;
  const _opMsgOn = !!document.getElementById('open-profile-msg')?.checked;
  if (_mode === 'connect_only' && _opMsgOn) {
    const opBody = (document.getElementById('tpl-op-body')?.value || '').trim();
    if (!opBody) { alert('Open Profile body template is required when "Message Open Profiles Directly" is on.'); return; }
  }

  // v2.14.x: Hard-block Start for Connect + Introduce Back when the primary
  // person fields are empty. Without them, the campaign would send connection
  // requests but every accepted lead would silently SKIP the intro DM (the
  // server logs a warning but the operator never sees it). Block at click-time
  // and scroll/focus the first empty field so the operator can fix it.
  if (_mode === 'connect_and_introduce') {
    const _pName = (document.getElementById('primary-person-name')?.value || '').trim();
    const _pUrl  = (document.getElementById('primary-person-url')?.value  || '').trim();
    const _pBody = (document.getElementById('primary-intro-body')?.value || '').trim();
    if (!_pName || !_pBody) {
      const missing = [];
      if (!_pName) missing.push('• Primary Person · Full name');
      if (!_pBody) missing.push('• Intro DM Body');
      alert(
        'Connect + Introduce Back can\'t start without the primary person.\n\n' +
        'Missing:\n' + missing.join('\n') + '\n\n' +
        'Without these, accepted invites can\'t be auto-introduced to anyone. ' +
        'Fill in the missing field(s) and try again.'
      );
      const firstEmpty = !_pName ? 'primary-person-name' : 'primary-intro-body';
      const el = document.getElementById(firstEmpty);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => el.focus(), 400);
      }
      return;
    }
  }

  // Resolve sender first names per profile (SoO column D, or local-browser input)
  const senderFirstNames = {};
  const missing = [];
  const preview = [];
  for (const id of selectedProfileIds) {
    const pName = selectedProfileNames[id] || id;
    const first = resolveSenderFirstName(id, pName);
    senderFirstNames[id] = first;
    preview.push(`  • ${pName}  →  ${first || '(none)'}`);
    if (!first) missing.push(pName);
  }
  const previewMsg = `Sender first names that will be used (from SoO column D):\n\n${preview.join('\n')}\n\n` +
    (missing.length ? `⚠ ${missing.length} profile(s) have no first name and will fall back to the profile name prefix.\n\n` : '') +
    `Start campaign?`;
  if (!confirm(previewMsg)) return;

  const mode = document.getElementById('campaign-mode').value;

  // Phase 11.2 (D-02, D-07): within-batch gap comes from explicit steppers for
  // non-message modes. Message mode keeps the #message-gap stepper because
  // messaging existing connections has different cadence semantics.
  let delayMin, delayMax;
  if (mode === 'message_only') {
    const gap = parseInt(document.getElementById('message-gap')?.value, 10) || 60;
    delayMin = Math.max(5, Math.round(gap * 0.8));
    delayMax = Math.max(delayMin + 5, Math.round(gap * 1.3));
  } else {
    delayMin = parseInt(document.getElementById('within-batch-min')?.value, 10) || 15;
    delayMax = parseInt(document.getElementById('within-batch-max')?.value, 10) || 45;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMin, delayMin + 5];
  }

  // v2.11.0: batchesPerHour removed. Backend hardcodes a 6-min per-account
  // turn floor and lets the queue rotation pace the rest.

  // If the user answered "No" to the "add a note while connecting?" question,
  // drop the connection note regardless of what's in the textarea.
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';
  const templates = {
    connectionNote: ((mode === 'connect_only' || mode === 'connect_and_introduce') && !addNoteOn) ? '' : document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    // 2.8.50: Introduction Messages sub-mode (active only when mode is message_only)
    // v2.11.13: in-memory state instead of localStorage (storage may be blocked).
    introMode: mode === 'introduce_back',
    introName: document.getElementById('intro-name')?.value?.trim() || '',
    introTitle: document.getElementById('intro-title')?.value || 'Introduction: {first name} <> {intro name}',
    // Connect + Introduce Back: primary person + intro DM body. Backend
    // stores these on the campaign config; auto-send-after-acceptance is
    // the next chunk of work.
    primaryName: document.getElementById('primary-person-name')?.value?.trim() || '',
    primaryUrl:  document.getElementById('primary-person-url')?.value?.trim() || '',
    primaryIntroBody: document.getElementById('primary-intro-body')?.value || '',
  };

  // Show account queue
  renderAccountQueue(selectedProfileIds.map(id => selectedProfileNames[id] || id), null);

  const body = {
    profileIds: selectedProfileIds,
    sheetUrl,
    templates,
    dailyLimit,
    mode,
    primaryName: templates.primaryName,
    messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked,
    delayMin,
    delayMax,
    linkedinColumn: document.getElementById('linkedin-col-select')?.value || '',
    senderFirstNames,
    // 2.9.8: parallel-accounts knob. Server only honors it when ≥5
    // accounts are selected and the toggle is on.
    concurrency: (() => {
      const tog = document.getElementById('concurrency-toggle');
      const cnt = document.getElementById('concurrency-count');
      if (!tog?.checked) return 1;
      const n = parseInt(cnt?.value, 10);
      return Number.isFinite(n) && n >= 2 ? Math.min(5, n) : 2;
    })(),
    // Campaign Name from the wizard's top-of-page input. Empty string is
    // valid — the dashboard row falls back to "Add name" inline-editable.
    name: (document.getElementById('campaign-name-input')?.value || '').trim(),
    // Pre-flight Check Status sweep. Toggle lives inside each mode's
    // coverage section (Section 2b for message_only, 2c for
    // introduce_back). Only one is visible at a time — read whichever
    // is checked. Server-side gated to the two modes anyway.
    preflightCheckStatus: !!(
      document.getElementById('preflight-check-toggle-mo')?.checked ||
      document.getElementById('preflight-check-toggle-ib')?.checked
    ),
    // v2.14.x: operator-chosen cadence for the monitoring auto-trigger.
    // Only relevant for CC+IC mode; server clamps to [15, 360] and ignores
    // the field for non-CC+IC modes.
    checkIntervalMinutes: (() => {
      if (mode !== 'connect_and_introduce') return undefined;
      const v = parseInt(document.getElementById('check-cadence-select')?.value, 10);
      return Number.isFinite(v) ? v : 60;
    })(),
  };

  await submitStartCampaign(body);
}

async function submitStartCampaign(body) {
  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      alert(`Could not start campaign:\n\n${txt}`);
      return;
    }

    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }

    // Whether the campaign starts now or gets queued, the draft has been
    // consumed. Drop it from the Drafts list and clear the active id.
    try {
      const draftId = localStorage.getItem('currentDraftId') || '';
      if (draftId) {
        await fetch('/api/drafts/' + encodeURIComponent(draftId), { method: 'DELETE' }).catch(() => {});
        localStorage.removeItem('currentDraftId');
      }
    } catch {}

    // Server queued the campaign because another one is already running.
    if (data.queued) {
      alert(data.message || 'Added to queue.');
      if (typeof saveLastUsedPreset === 'function') saveLastUsedPreset();
      goDashboard();
      return;
    }
    setCampaignButtons(true);
    if (typeof saveLastUsedPreset === 'function') saveLastUsedPreset();
    // Post-launch tips modal — fires once per mode after a successful start.
    // Operator can tick "Don't show again" to silence per-mode.
    try { maybeShowPostLaunchTipsModal(body); } catch (err) { console.warn('[tips] modal failed:', err.message); }
    startPolling();
  } catch (e) {
    alert(`Network error starting campaign:\n\n${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Post-launch tips — modal (Variant A) + sidebar card (Variant B).
// Data + token substitution live in /js/post-launch-tips.mjs. This block
// handles UI lifecycle (show, dismiss, silence, sidebar render, collapse).
// ─────────────────────────────────────────────────────────────────────────

// Build the substitution context from the wizard body / cockpit / wizard
// inputs. Called at modal-show AND on every sidebar render so dynamic tokens
// stay in sync if the operator changes cadence mid-run (not currently
// possible, but the helper is cheap and future-proof).
function _ptmContextFromBody(body) {
  const tpl = body?.templates || {};
  return {
    dailyLimit: body?.dailyLimit ?? 50,
    delayMin: body?.delayMin ?? 15,
    delayMax: body?.delayMax ?? 45,
    checkIntervalMinutes: body?.checkIntervalMinutes ?? 60,
    primaryName: tpl.primaryName || tpl.introName || '',
  };
}
function _ptmContextFromCockpit() {
  // Sidebar reads from __cockpit (populated by pollStatus). Falls back to
  // wizard inputs when the field isn't on the server status payload.
  const tpl = (__cockpit && __cockpit.templates) || {};
  const cadenceFromWizard = parseInt(document.getElementById('check-cadence-select')?.value, 10);
  return {
    dailyLimit: 50, // server status doesn't surface dailyLimit; default fits CC tip
    delayMin: 15,
    delayMax: 45,
    checkIntervalMinutes: (__cockpit && __cockpit.checkIntervalMinutes)
      || (Number.isFinite(cadenceFromWizard) ? cadenceFromWizard : 60),
    primaryName: tpl.primaryName || document.getElementById('primary-person-name')?.value || '',
  };
}

function maybeShowPostLaunchTipsModal(body) {
  const mode = body?.mode || '';
  if (!mode) return;
  if (isTipsSilenced(mode)) return;
  const set = getTipsForMode(mode, _ptmContextFromBody(body));
  if (!set) return; // unknown mode — no tip data, no modal
  const modal = document.getElementById('post-launch-tips-modal');
  if (!modal) return;
  const titleEl = document.getElementById('ptm-title');
  const bodyEl  = document.getElementById('ptm-body');
  const silenceCheck = document.getElementById('ptm-silence-check');
  if (titleEl) titleEl.textContent = set.modalTitle;
  if (bodyEl)  bodyEl.innerHTML    = renderModalTipsHtml(mode, _ptmContextFromBody(body));
  if (silenceCheck) silenceCheck.checked = false;
  modal.dataset.mode = mode;
  modal.classList.remove('hidden');
  // Esc dismisses — bound for this lifetime only, removed on close.
  const escHandler = (ev) => { if (ev.key === 'Escape') dismissPostLaunchTipsModal(); };
  modal._escHandler = escHandler;
  document.addEventListener('keydown', escHandler);
}

function closePostLaunchTipsModal() {
  const modal = document.getElementById('post-launch-tips-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  if (modal._escHandler) {
    document.removeEventListener('keydown', modal._escHandler);
    modal._escHandler = null;
  }
}

function dismissPostLaunchTipsModal() {
  const modal = document.getElementById('post-launch-tips-modal');
  const mode = modal?.dataset?.mode || '';
  const silence = !!document.getElementById('ptm-silence-check')?.checked;
  if (silence && mode) silenceTipsForMode(mode);
  closePostLaunchTipsModal();
}

// Sidebar tips card — rendered alongside the cockpit during running OR
// monitoring. Reads mode from __cockpit (server status). Hidden when idle.
function renderPostLaunchSidebar() {
  const card = document.getElementById('post-launch-tips-card');
  if (!card) return;
  const mode = (__cockpit && __cockpit.mode) || '';
  const isRunning = !!(__cockpit && __cockpit.running);
  const isMonitoring = !!(__cockpit && __cockpit.state === 'monitoring');
  // Hide when idle. The modal handled the first-time read; the sidebar is a
  // mid-run reference so operators don't need to remember tips later.
  if (!isRunning && !isMonitoring) { card.classList.add('hidden'); return; }
  const set = getTipsForMode(mode, _ptmContextFromCockpit());
  if (!set) { card.classList.add('hidden'); return; }
  const titleEl = document.getElementById('pts-title');
  const bodyEl  = document.getElementById('pts-body');
  if (titleEl) titleEl.textContent = set.sidebarTitle;
  if (bodyEl)  bodyEl.innerHTML    = renderSidebarTipsHtml(mode, _ptmContextFromCockpit());
  card.classList.remove('hidden');
}

function togglePostLaunchTipsCard() {
  const card = document.getElementById('post-launch-tips-card');
  if (!card) return;
  card.classList.toggle('collapsed');
}

// ─────────────────────────────────────────────────────────────────────────
// Onboarding tour — sidebar Help popover + inline-onclick handlers.
// Tour engine lives in /js/tour.mjs. This block wires the UI.
// ─────────────────────────────────────────────────────────────────────────

function toggleHelpPopover(ev) {
  if (ev) ev.stopPropagation();
  const pop = document.getElementById('help-popover');
  if (!pop) return;
  const isHidden = pop.classList.contains('hidden');
  // Refresh "Replay tour" visibility every open — flag may have just changed.
  const replay = document.getElementById('help-pop-replay');
  if (replay) replay.style.display = isTourCompleted() ? '' : 'none';
  pop.classList.toggle('hidden', !isHidden);
  // First open after toggling: bind a one-shot outside-click listener to dismiss.
  if (isHidden) {
    const outsideHandler = (e) => {
      const wrapper = pop.closest('.nav-help-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        pop.classList.add('hidden');
        document.removeEventListener('click', outsideHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler), 0);
  }
}

function _closeHelpPopover() {
  const pop = document.getElementById('help-popover');
  if (pop) pop.classList.add('hidden');
}

function onHelpTakeTour() { _closeHelpPopover(); startTour(); }
function onHelpReplayTour() { _closeHelpPopover(); replayTour(); }
function onTourNext() { tourNext(); }
function onTourBack() { tourBack(); }
function onTourSkip() { tourSkip(); }

async function stopCampaign() {
  // 2.9.7: Check DMs is a separate flow with its own stop endpoint. Stop
  // both — only the running one will react, and double-stop is harmless.
  try { await fetch('/api/campaign/stop', { method: 'POST' }); } catch { /* */ }
  try { await fetch('/api/check-dms/stop', { method: 'POST' }); } catch { /* */ }
}

// Phase 2.8.9: Stop confirmation modal — guards against accidental clicks.
// v2.14.x: for connect_and_introduce campaigns, route to the choice modal
// (stop-sending-keep-monitoring vs. stop-everything) instead of the simple
// yes/no modal. Other modes keep the original single-question modal.
function confirmStopCampaign() {
  // v2.14.x: when the campaign is in monitoring state (sending finished,
  // watcher active), route to the dedicated stop-monitoring modal instead
  // of the running-campaign flow. Without this, the button was either
  // dead (the older disable rule) or would hit the wrong modal.
  if (__cockpit && !__cockpit.running && __cockpit.state === 'monitoring') {
    // v2.52.0: when a stop is already in flight, surface the same persistent
    // banner instead of letting the operator re-open the modal and fire a
    // racing second POST. The first call will finalize the sheet stamps in
    // a few seconds — the toast confirms work is happening.
    if (typeof _stoppingMonitoring !== 'undefined' && _stoppingMonitoring) {
      showCampaignToast('Still ending monitoring — hang tight, sheet stamping in progress…', 8000);
      return;
    }
    const modal = document.getElementById('confirm-stop-monitoring-modal');
    if (modal) modal.classList.remove('hidden');
    return;
  }
  if (__cockpit && __cockpit.mode === 'connect_and_introduce') {
    const modal = document.getElementById('stop-choice-modal');
    if (modal) modal.classList.remove('hidden');
    return;
  }
  const modal = document.getElementById('confirm-stop-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeStopModal() {
  const modal = document.getElementById('confirm-stop-modal');
  if (modal) modal.classList.add('hidden');
}

function closeStopChoiceModal() {
  const modal = document.getElementById('stop-choice-modal');
  if (modal) modal.classList.add('hidden');
}
window.closeStopChoiceModal = closeStopChoiceModal;

// v2.14.x: Stop-monitoring modal helpers. Mirrors the stop-choice modal
// pattern so the in-app monochrome aesthetic stays consistent. The
// existing monitoringStop() in app.js:~6160 used a native browser
// confirm() — replaced by this modal when the operator hits the bottom-
// bar Stop button during monitoring.
function closeStopMonitoringModal() {
  const modal = document.getElementById('confirm-stop-monitoring-modal');
  if (modal) modal.classList.add('hidden');
}
window.closeStopMonitoringModal = closeStopMonitoringModal;

// v2.52.0 — client-side flag set true while /api/monitoring/stop is in
// flight. Suppresses re-opening the stop-monitoring modal during the
// 5–10s sheet-stamp window (so impatient operators can't fire a second
// POST and see the misleading 'not in monitoring state' alert). Cleared
// when the response lands OR after a 30s safety timeout.
let _stoppingMonitoring = false;
let _stoppingMonitoringStartedAt = 0;

async function confirmStopMonitoringNow() {
  closeStopMonitoringModal();
  if (_stoppingMonitoring) return; // already in flight — no-op
  _stoppingMonitoring = true;
  _stoppingMonitoringStartedAt = Date.now();
  // Persistent banner via the existing campaign toast — 30s duration covers
  // the worst-case sheet-stamp time. Cleared early when the fetch resolves.
  showCampaignToast('Ending monitoring — finalizing the sheet (this can take 5–10 s)…', 30000);
  try {
    const res = await fetch('/api/monitoring/stop', { method: 'POST' }).then((r) => r.json());
    if (res.ok) {
      // alreadyStopped → operator double-clicked; first call already did the work.
      const stamped = res.stampedCount || 0;
      const msg = res.alreadyStopped
        ? 'Monitoring already ended — sheet stamps were applied.'
        : `Monitoring ended. ${stamped} lead(s) stamped Closed - Not Connected.`;
      showCampaignToast(msg, 6000);
      if (typeof refreshDashboardSchedules === 'function') refreshDashboardSchedules();
    } else {
      alert('Stop failed: ' + (res.error || 'unknown'));
    }
  } catch (err) {
    alert('Stop failed: ' + err.message);
  } finally {
    _stoppingMonitoring = false;
  }
}
window.confirmStopMonitoringNow = confirmStopMonitoringNow;

async function confirmStopCampaignNow() {
  closeStopModal();
  // Visual feedback while the server force-closes browsers (~1-2s).
  showCampaignToast('Stopping campaign — closing browsers…', 4000);
  await stopCampaign();
}

// v2.14.x: "Stop sending, keep monitoring" — CC+IC only. Fires the
// existing /api/campaign/stop with no body, which preserves the post-
// campaign bulk-check + auto-intro monitoring path (campaign.js falls
// through to end-of-list bulk-check + transitionToMonitoring as it would
// at natural end-of-list).
async function stopAndKeepMonitoring() {
  closeStopChoiceModal();
  showCampaignToast('Stopping new sends — monitoring stays active for 7 days.', 5000);
  try { await fetch('/api/campaign/stop', { method: 'POST' }); } catch { /* */ }
  try { await fetch('/api/check-dms/stop', { method: 'POST' }); } catch { /* */ }
}
window.stopAndKeepMonitoring = stopAndKeepMonitoring;
window.closePostLaunchTipsModal   = closePostLaunchTipsModal;
window.dismissPostLaunchTipsModal = dismissPostLaunchTipsModal;
window.togglePostLaunchTipsCard   = togglePostLaunchTipsCard;
window.toggleHelpPopover          = toggleHelpPopover;
window.onHelpTakeTour             = onHelpTakeTour;
window.onHelpReplayTour           = onHelpReplayTour;
window.onTourNext                 = onTourNext;
window.onTourBack                 = onTourBack;
window.onTourSkip                 = onTourSkip;

// v2.14.x: "Stop everything" — CC+IC only. Posts { full: true } so the
// campaign loop skips the end-of-list bulk-check + monitoring transition
// + post-campaign sweep registration. Pending invitations stay pending;
// no auto-intros will fire.
async function stopEverything() {
  closeStopChoiceModal();
  showCampaignToast('Stopping campaign completely — no further checks or DMs.', 5000);
  try {
    await fetch('/api/campaign/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
  } catch { /* */ }
  try { await fetch('/api/check-dms/stop', { method: 'POST' }); } catch { /* */ }
}
window.stopEverything = stopEverything;

// v2.14.x: Restore — always-visible runbar panic button. Opens a confirm
// modal, then POSTs /api/campaign/restore. The backend force-kills
// browsers, force-resets in-memory state, and re-launches with the same
// settings. See restoreCampaign() in campaign.js for the full behaviour.
function confirmRestoreCampaign() {
  const modal = document.getElementById('restore-modal');
  if (modal) modal.classList.remove('hidden');
}
window.confirmRestoreCampaign = confirmRestoreCampaign;

function closeRestoreModal() {
  const modal = document.getElementById('restore-modal');
  if (modal) modal.classList.add('hidden');
}
window.closeRestoreModal = closeRestoreModal;

async function doRestoreCampaign() {
  closeRestoreModal();
  showCampaignToast('Restoring · force-closing browsers · resetting state…', 7000);
  try {
    const r = await fetch('/api/campaign/restore', { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      showCampaignToast(`Restore failed: ${data.error || r.statusText}`, 6000);
      return;
    }
    if (data.restartedFrom === null) {
      showCampaignToast('Engine restored — nothing to resume.', 4000);
    } else {
      const src = data.restartedFrom === 'running' ? 'live settings' : 'last campaign';
      showCampaignToast(`Engine restored — relaunching from ${src}.`, 4000);
    }
    // Refresh polling so the cockpit / runbar pick up the new state.
    if (typeof startPolling === 'function') startPolling();
  } catch (err) {
    showCampaignToast(`Restore failed: ${err.message}`, 6000);
  }
}
window.doRestoreCampaign = doRestoreCampaign;

// Phase 2.8.9: Pause/Resume toggle. Button label is driven by polled status,
// not local state, so the source of truth is the server.
async function pauseOrResumeCampaign() {
  const btn = document.getElementById('btn-pause');
  if (!btn) return;
  const label = (btn.textContent || '').trim();
  try {
    if (label === 'Resume') {
      btn.disabled = true;
      btn.textContent = 'Resuming…';
      await fetch('/api/campaign/resume', { method: 'POST' });
    } else {
      btn.disabled = true;
      btn.textContent = 'Pausing…';
      showCampaignToast('Pausing — current lead will finish first (~60–120s). Browsers stay open.', 8000);
      await fetch('/api/campaign/pause', { method: 'POST' });
    }
  } catch (err) {
    showCampaignToast(`Pause/Resume error: ${err.message}`, 5000);
  }
}

function showCampaignToast(msg, duration = 6000) {
  const toast = document.getElementById('campaign-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2.8.12 — Live Cockpit panel (Concept B from sketches).
// pollStatus saves the latest snapshot into __cockpit; a 250ms tick reads
// it and computes the smooth countdown without re-hitting the network.
// ─────────────────────────────────────────────────────────────────────────
const __cockpit = {
  running: false,
  paused: false,
  pauseRequested: false,
  action: null,
  mode: null,
  pName: null,
  // v2.13.14 — monitoring overlay. Populated from /api/campaign/status.
  state: 'idle',
  monitoringUntil: null,
  nextCheckAt: null,
  participatingProfileIds: [],
  monitoringCheckInProgress: false,
  profileIds: [],
  profileNames: [],
};
const COCKPIT_RING_CIRCUMFERENCE = 282.7; // 2πr where r=45

// Format a duration in ms as a human string ("6d 23h", "12h 4m", "8m").
// Matches the convention used by renderMonitoringCard so the cockpit,
// run-bar, and Schedule card all display the same string.
function _cockpitFmtRemaining(ms) {
  if (ms <= 0) return '0m';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
// v2.14.x: finer-grained countdown for the ring centre. Shows seconds
// when < 1 min remains so the operator sees the last 60s tick down,
// then mins/hours/days for longer ranges.
function _cockpitFmtCountdown(ms) {
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return _cockpitFmtRemaining(ms);
}
function _cockpitHHMM(d) {
  return d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—';
}

// v2.52.0 — full-screen overlay shown when monitoring transitions to 'done'.
// Idempotent: a second call while the overlay is visible is a no-op.
// Auto-dismisses after 3s and navigates to dashboard so the operator gets
// closure on the campaign without manually closing.
let _monEndedOverlayShown = false;
function showMonitoringEndedOverlay() {
  if (_monEndedOverlayShown) return;
  _monEndedOverlayShown = true;
  let el = document.getElementById('monitoring-ended-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'monitoring-ended-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,20,0.86);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:opacity 200ms ease-out;opacity:0;';
    el.innerHTML = '<div style="background:#fafafa;color:#111;padding:40px 56px;border:1px solid #222;border-radius:0;text-align:center;font-family:inherit;max-width:520px;">'
      + '<div style="font-size:0.78rem;letter-spacing:0.18em;color:#c9a233;margin-bottom:12px;">● MONITORING ENDED</div>'
      + '<h2 style="margin:0 0 14px;font-size:1.6rem;letter-spacing:0.04em;">Campaign complete.</h2>'
      + '<p style="margin:0 0 22px;color:#444;font-size:0.95rem;line-height:1.45;">All still-pending invitations have been stamped <i>Closed - Not Connected</i> in your sheet. Returning to the dashboard…</p>'
      + '<button type="button" id="mon-ended-go-now" style="background:#111;color:#fff;border:0;padding:10px 22px;letter-spacing:0.12em;font-size:0.78rem;cursor:pointer;border-radius:9999px;">DASHBOARD NOW</button>'
      + '</div>';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    const goNow = el.querySelector('#mon-ended-go-now');
    if (goNow) goNow.addEventListener('click', _dismissMonEndedOverlay);
  }
  setTimeout(_dismissMonEndedOverlay, 3000);
}
function _dismissMonEndedOverlay() {
  const el = document.getElementById('monitoring-ended-overlay');
  if (el) {
    el.style.opacity = '0';
    setTimeout(() => { el.remove(); }, 220);
  }
  _monEndedOverlayShown = false;
  // Navigate to dashboard so the cockpit is no longer in view. Past tab
  // will pick up the completed campaign on its next fetch.
  try { window.location.hash = '#/'; } catch { /* */ }
  try { if (typeof refreshDashboard === 'function') refreshDashboard(); } catch { /* */ }
}

function updateCockpit(s) {
  // v2.52.0: detect 'monitoring' → 'done' transition so the cockpit shows
  // a clear MONITORING ENDED confirmation + auto-redirect to dashboard.
  // Without this, the badge silently disappears and the operator can't
  // tell whether the stop landed. _prevState is module-local; reset on
  // navigate (page reload starts fresh).
  const prevState = __cockpit.state;
  const nextState = s.state || 'idle';
  const justEnded = prevState === 'monitoring' && nextState === 'done';

  __cockpit.running = !!s.running;
  __cockpit.paused = !!s.paused;
  __cockpit.pauseRequested = !!s.pauseRequested;
  __cockpit.action = s.currentAction || null;
  __cockpit.mode = s.mode || null;
  __cockpit.pName = s.currentProfile || null;
  __cockpit.state = nextState;

  if (justEnded) {
    try { showMonitoringEndedOverlay(); } catch (e) { console.warn('[monitoring-ended] overlay failed:', e.message); }
  }
  __cockpit.monitoringUntil = s.monitoringUntil || null;
  __cockpit.nextCheckAt = s.nextCheckAt || null;
  __cockpit.monitoringCheckInProgress = !!s.monitoringCheckInProgress;
  __cockpit.participatingProfileIds = s.participatingProfileIds || [];
  __cockpit.profileIds = s.profileIds || [];
  __cockpit.profileNames = s.profileNames || [];
  renderCockpit();
  // Sidebar tips card lives in the Live Status right column. Re-render on
  // every poll so mode/state transitions (idle → running → monitoring → idle)
  // flip visibility + title without extra plumbing.
  try { renderPostLaunchSidebar(); } catch (err) { console.warn('[tips] sidebar failed:', err.message); }
}

// v2.14.x: defensive stale-state detector. When in monitoring mode and the
// cached nextCheckAt is more than 30s in the past AND no check is mid-fire,
// the backend should have rescheduled by now. Force a fresh pollStatus()
// to pull the new nextCheckAt. This catches the case where:
//   - Mac slept and woke (powerMonitor.resume is unreliable on macOS)
//   - Renderer was suspended longer than backend (setInterval lag after wake)
//   - Any other reason the cached state diverged from the truth
// Throttled: at most once every 5s, so the 250ms render tick can't hammer
// the server. Idempotent — pollStatus has its own guard against overlap.
let _lastStaleForcePoll = 0;
function _maybeForcePollOnStale() {
  if (__cockpit.state !== 'monitoring') return;
  if (__cockpit.monitoringCheckInProgress) return;
  if (!__cockpit.nextCheckAt) return;
  const next = new Date(__cockpit.nextCheckAt).getTime();
  const now = Date.now();
  if (next > now - 30_000) return; // not stale yet
  if (now - _lastStaleForcePoll < 5_000) return; // throttle
  _lastStaleForcePoll = now;
  if (typeof pollStatus === 'function') {
    pollStatus().catch(() => { /* best-effort */ });
  }
}

function renderCockpit() {
  _maybeForcePollOnStale();
  const ring = document.querySelector('.cockpit-ring');
  const ringFg = document.getElementById('cockpit-ring-fg');
  const num = document.getElementById('cockpit-ring-num');
  const unit = document.getElementById('cockpit-ring-unit');
  const footer = document.getElementById('cockpit-ring-footer');
  // v2.14.x: footer is only populated in the monitoring branch.
  // Clear it on every render so it doesn't leak into idle/paused/running.
  if (footer) footer.textContent = '';
  const tag = document.getElementById('cockpit-status-tag');
  const dot = document.getElementById('cockpit-pulse-dot');
  const action = document.getElementById('cockpit-action');
  const lead = document.getElementById('cockpit-lead');
  const account = document.getElementById('cockpit-account');
  const modeEl = document.getElementById('cockpit-mode-meta');
  if (!ring || !ringFg || !num || !unit || !tag || !dot || !action) return;

  // v2.13.14 — Monitoring overlay. running=false but state='monitoring'
  // means the campaign has finished sending and is now watching for
  // acceptances. Surface the timing info so the operator doesn't have
  // to scroll to the Schedule card to know when the next check is.
  if (!__cockpit.running && __cockpit.state === 'monitoring') {
    ring.classList.remove('indeterminate', 'paused');
    ring.classList.add('monitoring');
    const until = __cockpit.monitoringUntil ? new Date(__cockpit.monitoringUntil) : null;
    const next = __cockpit.nextCheckAt ? new Date(__cockpit.nextCheckAt) : null;
    const now = Date.now();
    const remainingMs = until ? until.getTime() - now : 0;
    // Window-elapsed fraction → static-looking dashed ring for the visual cue.
    // (No animated countdown — the dashed pattern signals "watching", and
    // the centre text shows the live remainder.)
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE * 0.15;
    // v2.14.x ring redesign (Variant A): big number = live countdown to
    // next check, small label = "NEXT CHECK", tiny footer = window left.
    // Operator feedback: the slowly-changing window figure shouldn't
    // dominate; the live countdown is what matters minute-to-minute.
    const nextCountdownMs = next ? Math.max(0, next.getTime() - now) : 0;
    num.textContent = next ? _cockpitFmtCountdown(nextCountdownMs) : '—';
    unit.textContent = 'next check';
    if (footer) footer.textContent = until ? _cockpitFmtRemaining(remainingMs) : '';
    tag.textContent = 'MONITORING';
    dot.classList.remove('live', 'paused-dot');
    dot.classList.add('monitoring');
    action.textContent = __cockpit.monitoringCheckInProgress ? 'Checking now…' : 'Watching for acceptances';
    if (lead) {
      lead.textContent = next
        ? `${_cockpitHHMM(next)} · in ${_cockpitFmtRemaining(Math.max(0, next.getTime() - now))}`
        : '—';
    }
    const _leadLabel = document.querySelector('.cockpit-meta-label[data-cockpit-row="lead"]')
      || lead?.previousElementSibling;
    if (_leadLabel) _leadLabel.textContent = 'Next check';
    if (account) {
      account.textContent = until
        ? `${until.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${_cockpitHHMM(until)} · in ${_cockpitFmtRemaining(remainingMs)}`
        : '—';
    }
    const _accountLabel = document.querySelector('.cockpit-meta-label[data-cockpit-row="account"]')
      || account?.previousElementSibling;
    if (_accountLabel) _accountLabel.textContent = 'Ends';
    if (modeEl) {
      const ids = __cockpit.participatingProfileIds || [];
      const names = ids.map((pid) => {
        const idx = (__cockpit.profileIds || []).indexOf(pid);
        return idx >= 0 ? (__cockpit.profileNames[idx] || pid) : pid;
      });
      modeEl.textContent = names.length === 0 ? '—'
        : names.length === 1 ? names[0]
        : `${names[0]} (+${names.length - 1})`;
    }
    const _modeLabel = document.querySelector('.cockpit-meta-label[data-cockpit-row="mode"]')
      || modeEl?.previousElementSibling;
    if (_modeLabel) _modeLabel.textContent = 'Profiles';
    return;
  }

  // Idle — no campaign running.
  if (!__cockpit.running) {
    ring.classList.remove('indeterminate', 'paused', 'monitoring');
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE;
    num.textContent = '—';
    unit.textContent = 'idle';
    tag.textContent = 'IDLE';
    dot.classList.remove('live', 'paused-dot', 'monitoring');
    action.textContent = 'No campaign running';
    if (lead)    lead.textContent    = '—';
    if (account) account.textContent = '—';
    if (modeEl)  modeEl.textContent  = '—';
    // Restore default meta labels (in case we came back from monitoring state).
    const _leadLabel = lead?.previousElementSibling;
    const _accountLabel = account?.previousElementSibling;
    const _modeLabel = modeEl?.previousElementSibling;
    if (_leadLabel) _leadLabel.textContent = 'Lead';
    if (_accountLabel) _accountLabel.textContent = 'Account';
    if (_modeLabel) _modeLabel.textContent = 'Mode';
    return;
  }

  // Paused — distinct visual.
  if (__cockpit.paused) {
    ring.classList.remove('indeterminate', 'monitoring');
    ring.classList.add('paused');
    dot.classList.remove('monitoring');
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE * 0.3;
    num.textContent = '||';
    unit.textContent = 'paused';
    tag.textContent = 'PAUSED';
    dot.classList.remove('live'); dot.classList.add('paused-dot');
    action.textContent = 'Paused — press Resume to continue';
    if (lead)    lead.textContent    = (__cockpit.action && __cockpit.action.lead)    || '—';
    if (account) account.textContent = (__cockpit.action && __cockpit.action.account) || __cockpit.pName || '—';
    if (modeEl)  modeEl.textContent  = formatMode(__cockpit.mode);
    return;
  }

  // Running — countdown if action has endsAt, else indeterminate arc.
  ring.classList.remove('paused', 'monitoring');
  tag.textContent = __cockpit.pauseRequested ? 'PAUSING…' : 'LIVE';
  dot.classList.remove('paused-dot', 'monitoring'); dot.classList.add('live');

  const a = __cockpit.action;
  if (!a) {
    ring.classList.add('indeterminate');
    num.textContent = '◐';
    unit.textContent = 'working';
    action.textContent = 'Running…';
    if (lead)    lead.textContent    = '—';
    if (account) account.textContent = __cockpit.pName || '—';
    if (modeEl)  modeEl.textContent  = formatMode(__cockpit.mode);
    return;
  }

  action.textContent = a.label || 'Running…';
  if (lead)    lead.textContent    = a.lead    || '—';
  if (account) account.textContent = a.account || __cockpit.pName || '—';
  if (modeEl)  modeEl.textContent  = formatMode(a.mode || __cockpit.mode);

  if (a.endsAt && a.startedAt) {
    ring.classList.remove('indeterminate');
    const total = a.endsAt - a.startedAt;
    const remainingMs = Math.max(0, a.endsAt - Date.now());
    const pct = total > 0 ? Math.min(1, (total - remainingMs) / total) : 0;
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE * (1 - pct);
    const remainingSec = Math.ceil(remainingMs / 1000);
    if (remainingSec >= 60) {
      num.textContent = Math.ceil(remainingSec / 60);
      unit.textContent = 'minutes';
    } else {
      num.textContent = remainingSec;
      unit.textContent = 'seconds';
    }
  } else {
    ring.classList.add('indeterminate');
    num.textContent = '◐';
    unit.textContent = 'working';
  }
}

function formatMode(m) {
  if (!m) return '—';
  const map = {
    connect_only: 'Connect',
    message_only: 'Message',
    inmail_only: 'InMail',
    open_profile_only: 'Open Profile',
    check_status: 'Check Status',
    check_dms: 'Check DMs',
    auto: 'Auto',
  };
  return map[m] || m;
}

// 250ms client-side tick keeps the countdown smooth without re-polling.
setInterval(renderCockpit, 250);

// Phase 11.2 (D-18): un-hide all active browser processes (debug aid).
// Calls the session-gated POST /api/browsers/show shipped in Plan 01.
async function showBrowsers() {
  try {
    const res = await fetch('/api/browsers/show', { method: 'POST' });
    const data = await res.json();
    if (data.platform === 'other') {
      alert('Window hiding only runs on macOS. Nothing to show.');
      return;
    }
    alert(`Shown ${data.shown} browser${data.shown === 1 ? '' : 's'}${data.skipped ? ` (${data.skipped} skipped)` : ''}.`);
  } catch (err) {
    alert(`Could not show browsers: ${err.message}`);
  }
}

function setCampaignButtons(running, paused = false, pauseRequested = false) {
  // Queue mode: wizard's btn-start is repurposed as "Add to Queue" — keep
  // it enabled even when a campaign runs, so the operator can stage the
  // queued one. Detected by the visible queue banner (set by
  // updateWizardQueueState).
  const queueBanner = document.getElementById('wizard-queue-banner');
  const inQueueMode = queueBanner && queueBanner.style.display !== 'none';
  ['btn-start', 'btn-start-rb'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    // btn-start in the wizard becomes Add to Queue in queue mode → don't
    // disable. btn-start-rb is in the persistent run-bar and represents
    // starting the *active* campaign, so keep the original disable rule.
    if (id === 'btn-start' && inQueueMode) {
      b.disabled = false;
    } else {
      b.disabled = running;
    }
  });
  // v2.14.x: Stop button is now enabled during monitoring too, not just
  // while sending. The bottom-bar Stop was previously dead during monitoring,
  // and the only way to halt was a hidden "✕ Stop monitoring" button buried
  // inside the collapsed monitoring-card details. confirmStopCampaign routes
  // the click based on state (running → existing flow, monitoring → new
  // stop-monitoring modal).
  const _monitoring = !running && __cockpit && __cockpit.state === 'monitoring';
  ['btn-stop',  'btn-stop-rb' ].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !running && !_monitoring; });
  // Disable Check DMs while a campaign runs (mutex — both need the same browsers)
  const btnCheck = document.getElementById('btn-check-dms');
  if (btnCheck) btnCheck.disabled = running;
  // Phase 2.8.9: pause/resume button state mirrors server-reported status.
  ['btn-pause', 'btn-pause-rb'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    if (!running) {
      b.disabled = true;
      b.textContent = 'Pause';
    } else if (paused) {
      b.disabled = false;
      b.textContent = 'Resume';
    } else if (pauseRequested) {
      b.disabled = true;
      b.textContent = 'Pausing…';
    } else {
      b.disabled = false;
      b.textContent = 'Pause';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11.3 — Check DMs
// ─────────────────────────────────────────────────────────────────────────────
let checkDmsPollTimer = null;

async function startCheckDms() {
  try {
    // 2.9.7: Auto-routed — no profile picker. Server reads the sheet,
    // groups Sent-stage rows by Account Used, opens each sender's browser
    // and per-lead navigates to /messaging/thread/?recipient=<publicId>.
    const sheetUrl = document.getElementById('sheet-url')?.value?.trim();
    if (!sheetUrl) {
      alert('Enter a Google Sheet URL first.');
      return;
    }
    const linkedinColumn = document.getElementById('linkedin-column')?.value?.trim() || 'Linkedin URL';

    const btn = document.getElementById('btn-check-dms');
    if (btn) btn.disabled = true;

    // Expand the Replies section so the operator sees progress
    const section = document.getElementById('replies-section');
    if (section) section.classList.remove('collapsed');

    const res = await fetch('/api/check-dms/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl, linkedinColumn }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Check DMs could not start: ${data.error || res.statusText}`);
      if (btn) btn.disabled = false;
      return;
    }
    startCheckDmsPolling();
  } catch (err) {
    alert(`Check DMs error: ${err.message}`);
    const btn = document.getElementById('btn-check-dms');
    if (btn) btn.disabled = false;
  }
}

function startCheckDmsPolling() {
  if (checkDmsPollTimer) clearInterval(checkDmsPollTimer);
  checkDmsPollTimer = setInterval(pollCheckDmsStatus, 2000);
  pollCheckDmsStatus();
  // 2.9.7: Check DMs orchestrator pushes diagnostic lines into
  // campaign.logs so the Live Status log feed picks them up. That feed
  // is updated by pollStatus() (separate from pollCheckDmsStatus), so
  // we kick the campaign poller too. Both stop on their own when idle.
  startPolling();
}

function stopCheckDmsPolling() {
  if (checkDmsPollTimer) {
    clearInterval(checkDmsPollTimer);
    checkDmsPollTimer = null;
  }
}

async function pollCheckDmsStatus() {
  try {
    const res = await fetch('/api/check-dms/status');
    if (!res.ok) return;
    const status = await res.json();

    const statusEl = document.getElementById('replies-status');
    if (statusEl) {
      if (status.running) {
        const active = status.currentProfile ? ` — scanning ${status.currentProfile}` : '';
        statusEl.textContent = `Scanning${active}…  (${status.repliesFound || 0} new replies so far)`;
      } else if (status.startedAt) {
        statusEl.textContent = '';
      } else {
        statusEl.textContent = '';
      }
    }

    if (!status.running) {
      stopCheckDmsPolling();
      await fetchCheckDmsReplies();
      const btn = document.getElementById('btn-check-dms');
      if (btn) btn.disabled = !!document.getElementById('btn-stop')?.disabled === false;
    }
  } catch {
    // ignore transient fetch errors; next tick retries
  }
}

async function fetchCheckDmsReplies() {
  try {
    const res = await fetch('/api/check-dms/replies');
    if (!res.ok) return;
    const result = await res.json();
    const container = document.getElementById('replies-body');
    if (container) renderRepliesPanel(container, result);
  } catch { /* */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account queue display
// ─────────────────────────────────────────────────────────────────────────────
function renderAccountQueue(names, currentName, status, profileIds) {
  const el = document.getElementById('account-queue');
  if (!names || names.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  // Per-row Open Browser / Try Again buttons need profile IDs. Fall back to
  // the IDs in status when not passed (poll path), and to selectedProfileIds
  // in scope when no status (wizard preview path).
  const ids = profileIds
    || (status && Array.isArray(status.profileIds) ? status.profileIds : null)
    || (Array.isArray(selectedProfileIds) ? selectedProfileIds : null)
    || [];

  // Pull per-profile state out of the status payload when available. Both
  // arrays are emitted by getCampaignStatus (parkedProfiles + softWarnings)
  // and may carry profileName/name + a reason/kind we can surface.
  const parked = (status && (status.parkedProfiles || status.parked)) || [];
  const warnings = (status && status.softWarnings) || [];
  const endReasons = (status && status.profileEndReasons) || [];
  // pName is the key parkedProfiles uses; profileName / name / account cover
  // softWarnings + profileEndReasons + future shapes.
  const findIn = (arr, name) => {
    if (!Array.isArray(arr)) return null;
    return arr.find(x => (
      x?.profileName === name ||
      x?.pName === name ||
      x?.name === name ||
      x?.account === name
    )) || null;
  };

  // Resolve a row's state to one of 10 distinct chips. Each chip is its own
  // label + stateClass; visual differentiation lives in style.css. Per-lead
  // issues (email_required etc.) no longer surface here — they're just sheet
  // stamps + log lines.
  function resolveChip({ isActive, isPastCurrent, parkedHit, warningHit, endHit }) {
    if (isActive) {
      return { label: 'Sending', stateClass: 'chip-sending', detail: '' };
    }
    if (parkedHit) {
      const r = parkedHit.reason;
      if (r === 'session_expired') {
        return { label: 'Needs login', stateClass: 'chip-needs-login', detail: 'Session expired' };
      }
      if (r === 'weekly_limit_429') {
        return { label: 'LinkedIn cap · invites', stateClass: 'chip-li-invites', detail: 'Weekly invite cap reached' };
      }
      if (r === 'consecutive_skips') {
        const n = parkedHit.skipCount ? `${parkedHit.skipCount} consecutive skips` : 'too many consecutive skips';
        return { label: 'Parked · too many skips', stateClass: 'chip-parked', detail: n };
      }
      return { label: 'Parked', stateClass: 'chip-parked', detail: r || '' };
    }
    if (warningHit) {
      const k = warningHit.kind;
      if (k === 'weekly_limit') {
        return { label: 'LinkedIn cap · invites', stateClass: 'chip-li-invites', detail: 'Weekly invite cap reached' };
      }
      if (k === 'rate_limited') {
        return { label: 'Rate limited', stateClass: 'chip-rate-limited', detail: 'LinkedIn rate-limit page shown' };
      }
      // Unknown future kind — fall through to a generic action chip rather than hiding it.
      return { label: 'Action required', stateClass: 'chip-needs-login', detail: warningHit.message || k || '' };
    }
    if (endHit) {
      const r = String(endHit.reason || '');
      if (/InMail/i.test(r)) {
        return { label: 'LinkedIn cap · InMail', stateClass: 'chip-li-inmail', detail: r };
      }
      if (/weekly|429/i.test(r)) {
        return { label: 'LinkedIn cap · invites', stateClass: 'chip-li-invites', detail: r };
      }
      if (/session expired/i.test(r)) {
        return { label: 'Needs login', stateClass: 'chip-needs-login', detail: r };
      }
      if (/bulk|sweep|Check Status/i.test(r)) {
        return { label: 'Status sweep done', stateClass: 'chip-bulk-done', detail: r };
      }
      if (/campaign limit|Reached campaign/i.test(r)) {
        return { label: 'Batch done', stateClass: 'chip-batch', detail: r };
      }
      // Default terminal — treat as clean batch end.
      return { label: 'Batch done', stateClass: 'chip-batch', detail: r };
    }
    if (isPastCurrent) {
      return { label: 'Batch done', stateClass: 'chip-batch', detail: '' };
    }
    return { label: 'Queued', stateClass: 'chip-queued', detail: '' };
  }

  // Header + legend get rendered ONCE above the rows so the operator can
  // always reach the chip glossary without scrolling.
  const headerHtml = `
    <div class="account-queue-header">
      <span class="account-queue-title">Account queue</span>
      <button type="button" class="queue-help-ico" onclick="toggleAccountQueueLegend()" title="What do these chips mean?">?</button>
    </div>
    <div class="account-queue-legend" id="account-queue-legend" hidden>
      ${_renderAccountQueueLegend()}
    </div>
  `;

  const rowsHtml = names.map((name, i) => {
    const isActive = currentName && name === currentName;
    const isPastCurrent = currentName && names.indexOf(currentName) > i;
    const parkedHit = findIn(parked, name);
    const warningHit = findIn(warnings, name);
    const endHit = findIn(endReasons, name);

    const { label, stateClass, detail } = resolveChip({
      isActive, isPastCurrent, parkedHit, warningHit, endHit,
    });

    const profileId = ids[i] || '';
    // Try Again only for parked rows; Open Browser is always available so
    // the operator can manually inspect a profile mid-run.
    const tryAgainBtn = (parkedHit && profileId)
      ? `<button type="button" class="queue-row-btn" onclick="tryAgainProfile('${escHtml(profileId)}')" title="Clear the parked state and reopen this profile's browser so you can log in / fix the issue">Try again</button>`
      : '';
    const openBtn = profileId
      ? `<button type="button" class="queue-row-btn queue-row-btn--ghost" onclick="openProfileBrowser('${escHtml(profileId)}')" title="Open or focus the GoLogin browser for this profile">Open browser</button>`
      : '';
    return `
      <div class="queue-row ${stateClass}">
        <span class="queue-row-num">${i + 1}</span>
        <span class="queue-row-name">${escHtml(name)}</span>
        <span class="queue-row-status">${escHtml(label)}</span>
        <span class="queue-row-detail">${detail ? escHtml(detail) : ''}</span>
        <span class="queue-row-actions">${tryAgainBtn}${openBtn}</span>
      </div>
    `;
  }).join('');

  el.innerHTML = headerHtml + rowsHtml;
}

function toggleAccountQueueLegend() {
  const panel = document.getElementById('account-queue-legend');
  if (!panel) return;
  panel.hidden = !panel.hidden;
}
window.toggleAccountQueueLegend = toggleAccountQueueLegend;

function _renderAccountQueueLegend() {
  const groups = [
    { title: 'Active', rows: [
      ['Queued', 'chip-queued', 'Waiting its turn. Will run when an earlier account finishes.'],
      ['Sending', 'chip-sending', 'Sending right now. Progress shown in the detail column.'],
    ]},
    { title: 'Finished — nothing to do', rows: [
      ['Batch done', 'chip-batch', "Hit today's target. Picks up again on the next scheduled run."],
      ['Status sweep done', 'chip-bulk-done', 'Bulk Connection-Status check finished. Informational only.'],
    ]},
    { title: 'LinkedIn put a ceiling on you', rows: [
      ['LinkedIn cap · invites', 'chip-li-invites', 'Weekly invite cap reached (~200/wk; lower on some accounts). LinkedIn rule, not ours.'],
      ['LinkedIn cap · InMail', 'chip-li-inmail', 'Out of InMail credits. Waits for LinkedIn to top them up.'],
    ]},
    { title: 'Needs you · 1-click in the browser', rows: [
      ['Needs login', 'chip-needs-login', 'Session expired. Open the GoLogin browser and sign back in.'],
      ['Rate limited', 'chip-rate-limited', 'LinkedIn showed a rate-limit page. Open browser to verify.'],
    ]},
    { title: 'Out of rotation', rows: [
      ['Parked · too many skips', 'chip-parked', 'Auto-pulled after consecutive skips. "Try again" puts it back.'],
    ]},
  ];
  return groups.map(g => `
    <div class="legend-group">
      <div class="legend-group-title">${escHtml(g.title)}</div>
      ${g.rows.map(([label, cls, desc]) => `
        <div class="legend-row">
          <span class="legend-chip ${cls}">${escHtml(label)}</span>
          <span class="legend-desc">${escHtml(desc)}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

async function openProfileBrowser(profileId) {
  if (!profileId) return;
  try {
    const r = await fetch(`/api/profile/${encodeURIComponent(profileId)}/open-browser`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const verb = data.action === 'launched' ? 'Opening' : 'Focused';
    showCampaignToast(`${verb} browser for this profile.`, 4000);
  } catch (err) {
    showCampaignToast(`Could not open browser: ${err.message}`, 6000);
  }
}
window.openProfileBrowser = openProfileBrowser;

async function tryAgainProfile(profileId) {
  if (!profileId) return;
  try {
    const r = await fetch(`/api/campaign/profile/${encodeURIComponent(profileId)}/retry`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const browserNote = data.browser?.action === 'launched'
      ? ' Browser opening — log in there.'
      : (data.browser?.action === 'focused-existing' ? ' Browser focused.' : '');
    showCampaignToast(`Retrying ${data.profileName || 'profile'} on next rotation.${browserNote}`, 6000);
  } catch (err) {
    showCampaignToast(`Could not retry: ${err.message}`, 6000);
  }
}
window.tryAgainProfile = tryAgainProfile;

// ─────────────────────────────────────────────────────────────────────────────
// Status polling
// ─────────────────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}

async function pollStatus() {
  try {
    const res = await fetch('/api/campaign/status');
    const s = await res.json();

    // 2.9.7: Check DMs runs as a separate flow with its own state. When a
    // Check DMs scan is active, overlay its status onto the cockpit so the
    // operator sees Live progress instead of "No campaign running". Resolve
    // the profile id → display name via the cached profileNameCache (filled
    // by /api/profiles).
    try {
      const cdRes = await fetch('/api/check-dms/status');
      if (cdRes.ok) {
        const cd = await cdRes.json();
        if (cd.running) {
          const matched = (allProfilesData || []).find(p => p.id === cd.currentProfile);
          const accountName = cd.currentProfile === 'local-browser'
            ? 'You'
            : (matched?.name || cd.currentProfile || '—');
          s.running = true;
          s.mode = 'check_dms';
          s.currentProfile = accountName;
          s.currentAction = {
            label: `Scanning DMs — ${cd.repliesFound || 0} new repl${cd.repliesFound === 1 ? 'y' : 'ies'} found`,
            account: accountName,
            lead: '—',
            mode: 'check_dms',
            startedAt: cd.startedAt || Date.now(),
          };
        }
      }
    } catch { /* check-dms overlay is best-effort */ }

    // v2.12.x: same overlay pattern for Post Amplification — paint live
    // progress (current account · index/total) into the cockpit using the
    // shape renderCockpit expects.
    try {
      const paRes = await fetch('/api/post-amplification/status');
      if (paRes.ok) {
        const pa = await paRes.json();
        if (pa.running) {
          s.running = true;
          s.mode = 'post_amplification';
          s.currentProfile = pa.currentProfile || '';
          s.processedToday = pa.engaged || 0;
          s.totalProcessed = pa.completed || 0;
          s.totalTargets = pa.total || 0;
          s.currentAction = {
            label: pa.currentProfile
              ? `Engaging ${pa.currentIndex}/${pa.total} · ${pa.currentProfile}`
              : 'Starting…',
            account: pa.currentProfile || '—',
            lead: pa.postUrl ? '(amplifying post)' : '—',
            mode: 'post_amplification',
            startedAt: pa.startedAt || Date.now(),
          };
          s.errors = (pa.errors || []).map(e => ({ message: e }));
        }
      }
    } catch { /* post-amp overlay is best-effort */ }

    // Phase 2.8.12: feed the cockpit panel with the latest status snapshot
    // (renderCockpit + tick handle the smooth countdown without re-polling).
    updateCockpit(s);

    // Detect campaign completion and refresh history
    if (wasRunning && !s.running) {
      fetchHistory();
      notify('Campaign finished', `${s.processedToday} connections sent. ${(s.errors || []).length} errors.`);
    }
    // Detect new errors
    if (s.running && (s.errors || []).length > (wasErrorCount || 0)) {
      const latest = s.errors[s.errors.length - 1];
      notify('Campaign error', latest?.message || 'Unknown error');
    }
    wasErrorCount = (s.errors || []).length;
    wasRunning = s.running;
    renderParkedProfiles(s.parked);
    renderSoftWarnings(s.softWarnings);
    renderDiskBanner(s.disk);

    // Phase 2.8.13: status / mode / profile pills moved INTO the cockpit panel
    // (handled by renderCockpit). The legacy st-running/st-mode/st-profile
    // tiles are gone — guard their setters in case any are still in the DOM
    // (e.g. older cached HTML).
    const runEl = document.getElementById('st-running');
    const warningEl = document.getElementById('campaign-warnings');
    if (s.running) {
      if (runEl) {
        if (s.paused) { runEl.textContent = 'Paused'; runEl.className = 'value paused'; }
        else if (s.pauseRequested) { runEl.textContent = 'Pausing…'; runEl.className = 'value pausing'; }
        else { runEl.textContent = 'Running'; runEl.className = 'value running'; }
      }
      if (warningEl) warningEl.style.display = '';
      setCampaignButtons(true, !!s.paused, !!s.pauseRequested);
    } else {
      if (runEl) { runEl.textContent = 'Idle'; runEl.className = 'value stopped'; }
      if (warningEl) warningEl.style.display = 'none';
      setCampaignButtons(false);
      // v2.14.x: keep polling during monitoring so the cockpit's nextCheckAt
      // countdown stays in sync when the backend reschedules after each
      // hourly bulk-check. Without this, the Live Status panel and run-bar
      // freeze on the previous check's timestamp (operator saw "16:30 · 0s"
      // while Schedules card correctly showed 17:30 — same `campaign.nextCheckAt`
      // value, but the cockpit-fed endpoint stopped being polled).
      if (s.logs?.length > 0 && !s.running && s.state !== 'monitoring') stopPolling();
    }

    const profEl = document.getElementById('st-profile');
    if (profEl) profEl.textContent = s.currentProfile || '—';
    const modeEl = document.getElementById('st-mode');
    if (modeEl) {
      const modeLabels = {
        connect_only: 'Connect Only',
        message_only: 'Message Only', inmail_only: 'InMail Only', check_status: 'Check Status',
        open_profile_only: 'Open Profile',
      };
      modeEl.textContent = modeLabels[s.mode] || s.mode || '—';
    }

    const todayEl = document.getElementById('st-today');     if (todayEl)  todayEl.textContent  = s.processedToday;
    const totalEl = document.getElementById('st-total');     if (totalEl)  totalEl.textContent  = s.totalTargets;
    const errEl   = document.getElementById('st-errors');    if (errEl)    errEl.textContent    = (s.errors || []).length;

    const pct = s.totalTargets > 0 ? Math.min(100, Math.round((s.processedToday / s.totalTargets) * 100)) : 0;
    const barEl = document.getElementById('st-bar');         if (barEl)    barEl.style.width = pct + '%';

    // Phase 11.1: resource tiles + slow-mode banner
    renderHeaderResources(s.resources || null);
    renderThrottleBanner(s.throttle || null);

    // Update account queue if we have profile names
    if (s.profileNames && s.profileNames.length > 0) {
      renderAccountQueue(s.profileNames, s.currentProfile, s, s.profileIds);
    }

    if (s.logs?.length > 0) {
      const panel = document.getElementById('log-panel');
      // Honor a user-chosen "clear log" cutoff so reloads/polls don't resurrect old entries.
      let cutoff = 0;
      try {
        const raw = localStorage.getItem('ortus-log-cleared-at');
        if (raw) cutoff = new Date(raw).getTime();
      } catch (_) {}
      const visible = s.logs.filter((line) => {
        if (!cutoff) return true;
        const m = line.match(/^\[(.*?)\]/);
        if (!m) return true;
        const t = new Date(m[1]).getTime();
        return !isNaN(t) && t > cutoff;
      });
      if (visible.length === 0) {
        panel.innerHTML = '<div class="entry info">Log cleared.</div>';
      } else {
        panel.innerHTML = visible.map(line => {
          let cls = '';
          if (line.includes('✓') || line.includes('connection_sent') || line.includes('message_sent') || line.includes('status_accepted')) cls = 'success';
          else if (line.includes('✗') || line.includes('Error') || line.includes('FAILED')) cls = 'error';
          else if (line.includes('⚠') || line.includes('SKIPPED')) cls = 'warn';
          else if (line.includes('===') || line.includes('▶') || line.includes('■')) cls = 'info';
          return `<div class="entry ${cls}">${escHtml(line)}</div>`;
        }).join('');
        panel.scrollTop = panel.scrollHeight;
      }
    }

    // v2.14.x: feed the in-flight bulk-check panel from the campaign
    // logs we just polled. Catches the campaign's own in-batch bulk-
    // checks (📡 'In-batch ... (5-min cooldown elapsed)…' lines) so the
    // operator gets the same graphical treatment whether they pressed
    // the button or the campaign auto-triggered the sweep.
    // renderBulkCheckLive auto-hides when activity is >30s old, so this
    // is a no-op during the dormant phases of a long campaign. The
    // manual bulkCheckNow flow uses __keepAlive to override the timeout
    // while the operator-initiated sweep is in flight.
    try {
      if (Array.isArray(s.logs) && s.logs.length > 0) {
        const bcLive = parseBulkCheckFromLogs(s.logs);
        renderBulkCheckLive(bcLive);
      }
    } catch { /* */ }
  } catch { /* */ }
}

// ─── Phase 11.1: resource tiles + slow-mode banner ─────────────────────────
// Populated every 2s by pollStatus(). Thresholds match src/resource-monitor.js
// defaults (RAM_THROTTLE_PCT=80 / RAM_RELEASE_PCT=70 etc). If operator overrides
// env vars, tile colors stay tied to the 70/80 visual bands — see RESEARCH
// Open Question in 11.1-RESEARCH.md.

function classifyRam(pct) {
  if (pct >= 90) return 'err';
  if (pct >= 80) return 'warn';
  return '';
}

function classifyCpu(load1, cpuPct, cpuCount) {
  const effectiveLoad = load1 > 0 ? load1 : (cpuPct / 100) * cpuCount;
  if (effectiveLoad >= cpuCount * 0.9) return 'err';
  if (effectiveLoad >= cpuCount * 0.7) return 'warn';
  return '';
}

function renderHeaderResources(resources) {
  const ramTile = document.getElementById('hero-ram');
  const cpuTile = document.getElementById('hero-cpu');
  const brTile  = document.getElementById('hero-browsers');
  if (!ramTile || !cpuTile || !brTile) return;

  if (!resources) {
    ramTile.textContent = '—';  ramTile.className = 'v';
    cpuTile.textContent = '—';  cpuTile.className = 'v';
    brTile.textContent  = '—';  brTile.className  = 'v';
    return;
  }

  // RAM
  ramTile.textContent = `${Math.round(resources.ramPct)}%`;
  const ramCls = classifyRam(resources.ramPct);
  ramTile.className = ramCls ? `v ${ramCls}` : 'v';

  // CPU — display as % of total cores so non-Unix users aren't confused by
  // raw load averages. load1 on Unix is scaled by cpuCount; cpuPct on Windows
  // is already a percentage.
  if (resources.load1 > 0 && resources.cpuCount > 0) {
    cpuTile.textContent = `${Math.round((resources.load1 / resources.cpuCount) * 100)}%`;
  } else if (resources.cpuPct > 0) {
    cpuTile.textContent = `${Math.round(resources.cpuPct)}%`;
  } else {
    cpuTile.textContent = '—';
  }
  const cpuCls = classifyCpu(resources.load1, resources.cpuPct, resources.cpuCount);
  cpuTile.className = cpuCls ? `v ${cpuCls}` : 'v';

  // Browsers — count · total RSS
  const count = (resources.browsers || []).length;
  const rssGB = ((resources.totalBrowserRssMb || 0) / 1024).toFixed(1);
  brTile.textContent = `${count}·${rssGB}GB`;
  brTile.className = 'v';
}

function renderThrottleBanner(throttle) {
  const banner = document.getElementById('throttle-banner');
  if (!banner) return;
  if (throttle?.active) {
    banner.textContent = `⚠ SLOW MODE — ${throttle.reason}, delays ${throttle.multiplier}x`;
    banner.setAttribute('aria-live', 'polite');
    banner.style.display = '';
  } else {
    banner.textContent = '';
    banner.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTemplateList() {
  try {
    const res = await fetch('/api/templates');
    const data = await res.json();
    const sel = document.getElementById('tpl-select');
    // Preserve the default option, clear the rest
    sel.innerHTML = '<option value="">-- Select a template --</option>';
    Object.keys(data).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name; // textContent is XSS-safe
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to fetch templates:', err);
  }
}

// Enable/disable the Save (in-place) button based on whether a template is
// selected — there's nothing to save TO when the dropdown is on the placeholder.
function syncTemplateSaveButton() {
  const sel = document.getElementById('tpl-select');
  const btn = document.getElementById('btn-save-tpl');
  if (!sel || !btn) return;
  btn.disabled = !sel.value;
}

async function loadSelectedTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  syncTemplateSaveButton();
  // Selecting the placeholder ("-- Select a template --") is a no-op now that
  // the dropdown auto-loads on change. No alert — that would fire every time
  // the operator deselects.
  if (!name) return;
  try {
    const res = await fetch('/api/templates');
    const data = await res.json();
    const tpl = data[name];
    if (!tpl) { alert('Template not found.'); return; }
    document.getElementById('tpl-note').value = tpl.connectionNote || '';
    document.getElementById('tpl-followup').value = tpl.followUp1 || '';
    document.getElementById('tpl-inmail-subject').value = tpl.inmailSubject || '';
    document.getElementById('tpl-inmail-body').value = tpl.inmailBody || '';
    const opSubj = document.getElementById('tpl-op-subject');
    const opBody = document.getElementById('tpl-op-body');
    if (opSubj) opSubj.value = tpl.openProfileSubject || '';
    if (opBody) opBody.value = tpl.openProfileBody || '';
    const introBody = document.getElementById('primary-intro-body');
    if (introBody) {
      introBody.value = tpl.primaryIntroBody || '';
      if (typeof savePrimaryPersonFields === 'function') savePrimaryPersonFields();
    }
  } catch (err) {
    alert('Failed to load template: ' + err.message);
  }
}

// Save in-place — overwrites the currently selected template with the form's
// current values. POSTs to the same /api/templates endpoint that creates new
// ones; server keys by name so a same-name POST overwrites.
async function saveExistingTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  if (!name) { alert('Select a template first to save changes.'); return; }
  const templates = {
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    primaryIntroBody: document.getElementById('primary-intro-body')?.value || '',
  };
  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, templates }),
    });
    const data = await res.json();
    if (data.saved) {
      showCampaignToast(`Saved changes to "${name}".`, 2500);
    } else {
      alert('Failed to save template.');
    }
  } catch (err) {
    alert('Failed to save template: ' + err.message);
  }
}

async function saveCurrentTemplate() {
  // Electron disables window.prompt() — use our modal helper so Save As… works
  // in both the web dashboard and the packaged DMG.
  const name = await promptModal({ label: 'Template name:' });
  if (!name) return; // null = cancel / ESC / empty
  const templates = {
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    primaryIntroBody: document.getElementById('primary-intro-body')?.value || '',
  };
  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, templates }),
    });
    const data = await res.json();
    if (data.saved) {
      await fetchTemplateList();
      document.getElementById('tpl-select').value = name;
    } else {
      alert('Failed to save template.');
    }
  } catch (err) {
    alert('Failed to save template: ' + err.message);
  }
}

async function deleteSelectedTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  if (!name) { alert('Select a template first.'); return; }
  if (!confirm('Delete template "' + name + '"?')) return;
  try {
    const res = await fetch('/api/templates/' + encodeURIComponent(name), { method: 'DELETE' });
    const data = await res.json();
    if (data.deleted) {
      await fetchTemplateList();
    } else {
      alert('Failed to delete template.');
    }
  } catch (err) {
    alert('Failed to delete template: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign History
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHistory() {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      panel.innerHTML = '<p class="empty-state">No campaigns yet.</p>';
      return;
    }

    const modeLabels = {
      connect_only: 'Connect Only',
      message_only: 'Message Only', inmail_only: 'InMail Only', check_status: 'Check Status',
      open_profile_only: 'Open Profile',
    };

    // Sort newest first
    data.sort((a, b) => new Date(b.startedAt || b.date) - new Date(a.startedAt || a.date));

    // Hero metrics: Today / This week / Errors 24h
    populateHeroMetrics(data);

    let html = '<table class="history-table"><thead><tr>';
    html += '<th>Date</th><th>Mode</th><th>Profiles</th><th>Success</th><th>Errors</th><th>Duration</th>';
    html += '</tr></thead><tbody>';

    data.forEach((c, idx) => {
      const dt = c.startedAt || c.date || '';
      const dateStr = dt ? new Date(dt).toISOString().replace('T', ' ').substring(0, 16) : '--';
      const modeLabel = modeLabels[c.mode] || escHtml(c.mode || '--');
      const profiles = (c.profileNames || c.profiles || []).join(', ');
      const profileDisplay = profiles.length > 30 ? escHtml(profiles.substring(0, 27)) + '...' : escHtml(profiles);
      const success = c.successCount != null ? c.successCount : (c.totalProcessed || 0);
      const errors = c.errorCount != null ? c.errorCount : 0;

      // Duration calculation
      let durationStr = '--';
      if (c.duration != null) {
        durationStr = c.duration >= 60 ? Math.round(c.duration / 60) + 'm' : c.duration + 's';
      } else if (c.startedAt && c.endedAt) {
        const mins = Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 60000);
        durationStr = mins + 'm';
      }

      // Summary row
      html += '<tr data-idx="' + idx + '">';
      html += '<td>' + escHtml(dateStr) + '</td>';
      html += '<td>' + modeLabel + '</td>';
      html += '<td>' + profileDisplay + '</td>';
      html += '<td class="success-count">' + success + '</td>';
      html += '<td class="error-count">' + errors + '</td>';
      html += '<td>' + escHtml(durationStr) + '</td>';
      html += '</tr>';

      // Detail row (hidden by default)
      const tplNote = (c.templates && c.templates.connectionNote) || '';
      const tplDisplay = tplNote.length > 50 ? escHtml(tplNote.substring(0, 47)) + '...' : escHtml(tplNote);
      html += '<tr class="history-detail" data-detail-idx="' + idx + '">';
      html += '<td colspan="6"><dl>';
      html += '<dt>Templates</dt><dd>' + (tplDisplay || 'None') + '</dd>';
      html += '<dt>Campaign limit per account</dt><dd>' + escHtml(String(c.dailyLimit || '--')) + '</dd>';
      html += '<dt>Total Processed</dt><dd>' + escHtml(String(c.totalProcessed || 0)) + '</dd>';
      html += '</dl></td></tr>';
    });

    html += '</tbody></table>';
    panel.innerHTML = html;

    // Add click handlers for expanding detail rows
    panel.querySelectorAll('tr[data-idx]').forEach(tr => {
      tr.onclick = function() {
        const idx = this.getAttribute('data-idx');
        const detail = panel.querySelector('tr[data-detail-idx="' + idx + '"]');
        if (detail) detail.classList.toggle('expanded');
      };
    });
  } catch (err) {
    panel.innerHTML = '<p class="empty-state">Failed to load history.</p>';
  }
}

function downloadCsv() {
  const a = document.createElement('a');
  a.href = '/api/export/csv';
  a.download = 'campaign-export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function clearHistory() {
  if (!confirm('Clear all campaign history? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/history', { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchHistory();
  } catch (err) {
    alert('Failed to clear history: ' + (err.message || 'Unknown error'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Schedules
// ─────────────────────────────────────────────────────────────────────────────
function setLaunchMode(mode) {
  const isSchedule = mode === 'schedule';
  document.getElementById('launch-mode-now').classList.toggle('active', !isSchedule);
  document.getElementById('launch-mode-schedule').classList.toggle('active', isSchedule);
  const now = document.getElementById('launch-now-panel');
  const sched = document.getElementById('launch-schedule-panel');
  now.classList.toggle('panel-active', !isSchedule);
  now.classList.toggle('panel-inactive', isSchedule);
  sched.classList.toggle('panel-active', isSchedule);
  sched.classList.toggle('panel-inactive', !isSchedule);
}

function buildQuickCron() {
  const time = document.getElementById('quick-sched-time').value || '09:00';
  const [hoursStr, minutesStr] = time.split(':');
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  if (isNaN(hours) || isNaN(minutes)) return null;
  const checked = Array.from(document.querySelectorAll('.quick-sched-day:checked')).map((cb) => cb.value);
  if (checked.length === 0) return null;
  const days = checked.length === 7 ? '*' : checked.join(',');
  return `${minutes} ${hours} * * ${days}`;
}

async function saveQuickSchedule() {
  const name = document.getElementById('quick-sched-name').value.trim();
  if (!name) { alert('Give the schedule a name.'); return; }

  const cronExpr = buildQuickCron();
  if (!cronExpr) { alert('Pick at least one day and a valid time.'); return; }

  // Same validation as startCampaign
  if (selectedProfileIds.length === 0) { alert('Select at least one GoLogin account on the page first.'); return; }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter the Google Sheet URL on the page first.'); return; }
  const dailyLimit = parseInt(document.getElementById('daily-limit').value, 10);
  if (!dailyLimit || dailyLimit < 1) { alert('Campaign limit per account must be at least 1.'); return; }

  const mode = document.getElementById('campaign-mode').value || 'connect_only';

  // Phase 11.2 (D-02, D-07): schedule form mirrors the main campaign form for
  // within-batch gap — explicit steppers for non-message modes.
  let delayMin, delayMax;
  if (mode === 'message_only') {
    const gap = parseInt(document.getElementById('message-gap')?.value, 10) || 60;
    delayMin = Math.max(5, Math.round(gap * 0.8));
    delayMax = Math.max(delayMin + 5, Math.round(gap * 1.3));
  } else {
    delayMin = parseInt(document.getElementById('within-batch-min')?.value, 10) || 15;
    delayMax = parseInt(document.getElementById('within-batch-max')?.value, 10) || 45;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMin, delayMin + 5];
  }

  // v2.11.0: batchesPerHour removed from schedules too — pacing is now the
  // 6-min turn floor + queue rotation, no per-schedule throughput knob.

  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';
  const templates = {
    connectionNote: (mode === 'connect_only' && !addNoteOn) ? '' : document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
  };

  try {
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        cron: cronExpr,
        profileIds: selectedProfileIds,
        sheetUrl,
        mode,
        templates,
        dailyLimit,
        delayMin,
        delayMax,
        enabled: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.saved) { alert('Failed to save schedule: ' + (data.error || res.status)); return; }
    alert(`Schedule "${name}" saved. Notifications will go to your email.`);
    document.getElementById('quick-sched-name').value = '';
    fetchSchedules();
  } catch (err) {
    alert('Failed to save schedule: ' + err.message);
  }
}

async function fetchSchedules() {
  const panel = document.getElementById('schedule-list');
  if (!panel) return;
  try {
    const res = await fetch('/api/schedules');
    const data = await res.json();
    updateNextScheduleWidget(Array.isArray(data) ? data : []);
    if (!Array.isArray(data) || data.length === 0) {
      panel.innerHTML = '<p class="empty-state">No schedules yet. Create one from the <strong>Launch</strong> section → toggle to <em>Schedule</em>.</p>';
      return;
    }
    panel.innerHTML = data.map(s => {
      const lastRun = s.lastRun ? new Date(s.lastRun).toISOString().replace('T', ' ').substring(0, 16) : 'Never';
      const modeLabels = { connect_only: 'Connect', message_only: 'Message', inmail_only: 'InMail', check_status: 'Check', open_profile_only: 'Open Profile' };
      const modeLabel = modeLabels[s.mode] || s.mode;
      // Parse cron into friendly format
      const cronParts = (s.cron || '').split(' ');
      let cronFriendly = s.cron;
      if (cronParts.length === 5) {
        const min = cronParts[0].padStart(2, '0');
        const hr = cronParts[1].padStart(2, '0');
        const dayMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
        const daysPart = cronParts[4];
        const days = daysPart === '*' ? 'Every day' : daysPart.split(',').map(d => dayMap[d] || d).join(', ');
        cronFriendly = hr + ':' + min + ' — ' + days;
      }
      return '<div class="schedule-item">' +
        '<div class="sched-info">' +
          '<div class="sched-name">' + escHtml(s.name) + '</div>' +
          '<div class="sched-meta">' + escHtml(cronFriendly) + ' &middot; ' + modeLabel + ' &middot; limit ' + (s.dailyLimit || 5) + ' &middot; last: ' + escHtml(lastRun) + '</div>' +
        '</div>' +
        '<div class="sched-actions">' +
          // P-06 fix (2.8.18): defense-in-depth — escape single-quotes/backslashes in s.id
          // before embedding in the single-quoted onclick string. Server-side validation
          // (sched_<digits>) is the primary guard; this closes the injection sink even
          // if a malformed id ever survives the server check.
          ((safeId) => (
            '<button class="schedule-toggle ' + (s.enabled ? 'on' : 'off') + '" onclick="toggleScheduleEnabled(\'' + safeId + '\', ' + !s.enabled + ')" title="' + (s.enabled ? 'Disable' : 'Enable') + '"></button>' +
            '<button class="btn-remove" onclick="deleteSchedule(\'' + safeId + '\')" title="Delete">&times;</button>'
          ))(String(s.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")) +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    panel.innerHTML = '<p class="empty-state">Failed to load schedules.</p>';
  }
}

// createSchedule / buildCronFromUI removed — schedules are now created from the
// Launch section (saveQuickSchedule) using the live page state. See index.html.

async function toggleScheduleEnabled(id, enabled) {
  try {
    // Fetch current schedule data first, then update
    const listRes = await fetch('/api/schedules');
    const schedules = await listRes.json();
    const sched = schedules.find(s => s.id === id);
    if (!sched) { alert('Schedule not found.'); return; }
    sched.enabled = enabled;
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sched, id }),
    });
    const data = await res.json();
    if (data.saved) await fetchSchedules();
  } catch (err) {
    alert('Failed to update schedule: ' + err.message);
  }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule?')) return;
  try {
    const res = await fetch('/api/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json();
    if (data.deleted) {
      if (typeof fetchSchedules === 'function') await fetchSchedules();
      if (typeof refreshDashboardSchedules === 'function') await refreshDashboardSchedules();
    }
  } catch (err) {
    alert('Failed to delete schedule: ' + err.message);
  }
}
window.deleteSchedule = deleteSchedule;

// ─────────────────────────────────────────────────────────────────────────────
// Collapsible sections
// ─────────────────────────────────────────────────────────────────────────────
function toggleSection(sectionId) {
  if (document.body.classList.contains('edit-mode')) return;
  const section = document.getElementById(sectionId);
  if (!section) return;
  section.classList.toggle('collapsed');
  try {
    localStorage.setItem(`section-collapsed:${sectionId}`, section.classList.contains('collapsed') ? '1' : '0');
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline label editor — persists custom text to localStorage under 'ortus-edits'
// ─────────────────────────────────────────────────────────────────────────────
const EDITS_KEY = 'ortus-edits';
let editSnapshot = null;

function loadEditsFromStorage() {
  try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); }
  catch (_) { return {}; }
}

function applySavedEdits() {
  const saved = loadEditsFromStorage();
  document.querySelectorAll('[data-edit]').forEach(el => {
    const key = el.dataset.edit;
    if (key && Object.prototype.hasOwnProperty.call(saved, key)) {
      el.textContent = saved[key];
    }
  });
}

function enterEditMode() {
  editSnapshot = {};
  document.querySelectorAll('[data-edit]').forEach(el => {
    editSnapshot[el.dataset.edit] = el.textContent;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.addEventListener('keydown', preventEditEnter);
  });
  document.body.classList.add('edit-mode');
  document.getElementById('edit-btn-enter').style.display = 'none';
  document.getElementById('edit-btn-save').style.display = '';
  document.getElementById('edit-btn-cancel').style.display = '';
  document.getElementById('edit-btn-reset').style.display = '';
}

function preventEditEnter(e) {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
}

function exitEditMode() {
  document.querySelectorAll('[data-edit]').forEach(el => {
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    el.removeEventListener('keydown', preventEditEnter);
  });
  document.body.classList.remove('edit-mode');
  document.getElementById('edit-btn-enter').style.display = '';
  document.getElementById('edit-btn-save').style.display = 'none';
  document.getElementById('edit-btn-cancel').style.display = 'none';
  document.getElementById('edit-btn-reset').style.display = 'none';
  editSnapshot = null;
}

function saveEdits() {
  // Merge with any previously saved edits — preserves per-mode edits made
  // while a different mode was active (data-edit keys are mode-scoped).
  const edits = loadEditsFromStorage();
  document.querySelectorAll('[data-edit]').forEach(el => {
    edits[el.dataset.edit] = el.textContent.trim();
  });
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(edits)); } catch (_) {}
  exitEditMode();
  // Re-render any surfaces that depend on saved edits (mode picker chips, etc.)
  renderModeSelector();
}

function cancelEdits() {
  if (editSnapshot) {
    document.querySelectorAll('[data-edit]').forEach(el => {
      const key = el.dataset.edit;
      if (key && Object.prototype.hasOwnProperty.call(editSnapshot, key)) {
        el.textContent = editSnapshot[key];
      }
    });
  }
  exitEditMode();
}

function resetEdits() {
  if (!confirm('Reset all label edits to defaults? This cannot be undone.')) return;
  try { localStorage.removeItem(EDITS_KEY); } catch (_) {}
  location.reload();
}

function restoreCollapsedSections() {
  document.querySelectorAll('.collapsible').forEach((el) => {
    if (!el.id) return;
    try {
      if (localStorage.getItem(`section-collapsed:${el.id}`) === '1') {
        el.classList.add('collapsed');
      }
    } catch (_) {}
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme toggle
// ─────────────────────────────────────────────────────────────────────────────
function setTheme(mode) {
  const isLight = mode === 'light';
  document.body.classList.toggle('theme-light', isLight);
  try { localStorage.setItem('ortus-theme', mode); } catch (_) {}
  const d = document.getElementById('theme-btn-dark');
  const l = document.getElementById('theme-btn-light');
  if (d) d.classList.toggle('active', !isLight);
  if (l) l.classList.toggle('active', isLight);
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('ortus-theme'); } catch (_) {}
  if (!saved) {
    // First visit — follow OS preference
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    saved = prefersLight ? 'light' : 'dark';
  }
  setTheme(saved);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar nav scrolling + scroll-spy
// ─────────────────────────────────────────────────────────────────────────────
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;

  // If we're on the dashboard route, the wizard view is display:none — switching
  // first (and waiting two RAF ticks for the route swap) makes scrollIntoView
  // actually land somewhere visible. Without this, View Status / Open log were
  // no-ops from the dashboard.
  const wasDashboard = document.body.classList.contains('route-dashboard');
  if (wasDashboard) window.location.hash = '#/new';

  const doScroll = () => {
    if (el.classList.contains('collapsible') && el.classList.contains('collapsed')) {
      el.classList.remove('collapsed');
      try { localStorage.setItem(`section-collapsed:${id}`, '0'); } catch (_) {}
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveNav(id);
  };

  if (wasDashboard) {
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
  } else {
    doScroll();
  }
}

function setActiveNav(id) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const trigger = document.querySelector(`.nav-item[data-nav="${id}"]`);
  if (trigger) trigger.classList.add('active');
  // A3 — re-run sidebar glyphs when scroll-spy changes the active section
  if (typeof updateSidebarGlyphs === 'function') updateSidebarGlyphs();
}

function initScrollSpy() {
  const ids = ['nav-accounts', 'nav-sheet', 'nav-settings', 'nav-templates', 'nav-launch', 'nav-status', 'history-section', 'schedules-section'];
  const sections = ids.map((id) => document.getElementById(id)).filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    // Pick the entry closest to the top of the viewport that is intersecting
    const visible = entries.filter((e) => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) setActiveNav(visible[0].target.id);
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
  sections.forEach((s) => io.observe(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Run bar mirror — Phase 2.8.13: now reads from __cockpit (the cockpit panel
// owns the canonical running/paused state since the legacy st-running tile
// was removed). Polled on the same 2s cadence as pollStatus.
// ─────────────────────────────────────────────────────────────────────────────
function initRunBarMirror() {
  const bar = document.getElementById('run-bar-status');
  const txt = document.getElementById('run-bar-text');
  const statusSection = document.getElementById('nav-status');
  if (!bar || !txt) return;
  let wasRunning = false;
  const sync = () => {
    const running = !!__cockpit.running;
    const monitoring = !running && __cockpit.state === 'monitoring';
    bar.classList.toggle('running', running);
    bar.classList.toggle('monitoring', monitoring);
    const profile = (__cockpit.action && __cockpit.action.account) || __cockpit.pName || '';
    const mode = formatMode(__cockpit.mode);
    const today = document.getElementById('st-today')?.textContent || '0';
    const total = document.getElementById('st-total')?.textContent || '0';
    if (running) {
      const label = __cockpit.paused ? 'Paused' : (__cockpit.pauseRequested ? 'Pausing…' : 'Running');
      txt.innerHTML = `<strong>${label}</strong> · ${mode} · ${profile} · ${today}/${total}`;
    } else if (monitoring) {
      // v2.13.14 — surface monitoring countdown in the sticky toolbar.
      // Matches the format in the Schedule card so the operator sees
      // the same "next 04:35 · ends in 6d 23h" no matter where they look.
      // v2.14.x — when a bulk-check is mid-fire, swap to "checking now…".
      if (__cockpit.monitoringCheckInProgress) {
        txt.innerHTML = `<strong>Monitoring</strong> <span class="run-bar-meta-mono">checking now…</span>`;
      } else {
        const now = Date.now();
        const next = __cockpit.nextCheckAt ? new Date(__cockpit.nextCheckAt) : null;
        const until = __cockpit.monitoringUntil ? new Date(__cockpit.monitoringUntil) : null;
        const nextStr = _cockpitHHMM(next);
        const endsStr = until ? _cockpitFmtRemaining(until.getTime() - now) : '—';
        txt.innerHTML = `<strong>Monitoring</strong> <span class="run-bar-meta-mono">next ${nextStr} · ends in ${endsStr}</span>`;
      }
    } else {
      txt.textContent = 'Idle';
    }

    // Right-pane status mirror
    const rpDot = document.getElementById('rp-dot');
    const rpStatusText = document.getElementById('rp-status-text');
    const rpStatusSub = document.getElementById('rp-status-sub');
    if (rpDot) {
      rpDot.classList.toggle('running', running);
      rpDot.classList.toggle('monitoring', monitoring);
    }
    if (rpStatusText) rpStatusText.textContent = running ? 'Running' : (monitoring ? 'Monitoring' : 'Idle');
    if (rpStatusSub) {
      if (running) {
        rpStatusSub.textContent = `${mode} · ${profile} · ${today}/${total}`;
      } else if (monitoring) {
        if (__cockpit.monitoringCheckInProgress) {
          rpStatusSub.textContent = 'checking now…';
        } else {
          const now = Date.now();
          const next = __cockpit.nextCheckAt ? new Date(__cockpit.nextCheckAt) : null;
          const until = __cockpit.monitoringUntil ? new Date(__cockpit.monitoringUntil) : null;
          rpStatusSub.textContent = `next ${_cockpitHHMM(next)} · ends in ${until ? _cockpitFmtRemaining(until.getTime() - now) : '—'}`;
        }
      } else {
        rpStatusSub.textContent = 'No campaign running';
      }
    }

    // Right-pane activity feed — mirror the last ~10 log entries
    syncActivityFeed();

    // Auto-expand Live Status when running OR monitoring, auto-collapse when truly idle.
    if (statusSection && statusSection.classList.contains('collapsible')) {
      const active = running || monitoring;
      if (active && statusSection.classList.contains('collapsed')) {
        statusSection.classList.remove('collapsed');
      } else if (!active && wasRunning) {
        statusSection.classList.add('collapsed');
      }
    }
    wasRunning = running || monitoring;
  };
  setInterval(sync, 2000);
  sync();
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero metrics
// ─────────────────────────────────────────────────────────────────────────────
function populateHeroMetrics(history) {
  if (!Array.isArray(history)) return;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = 7 * DAY;

  const startOfTodayPH = (() => {
    // PH midnight = UTC 16:00 prior day
    const n = new Date();
    const phNow = new Date(n.getTime() + (8 * 60 * 60 * 1000) + (n.getTimezoneOffset() * 60 * 1000));
    phNow.setHours(0, 0, 0, 0);
    return phNow.getTime() - (8 * 60 * 60 * 1000) - (n.getTimezoneOffset() * 60 * 1000);
  })();

  let todaySuccess = 0, weekSuccess = 0, errors24h = 0;
  history.forEach((c) => {
    const t = new Date(c.startedAt || c.date || 0).getTime();
    if (isNaN(t)) return;
    const success = c.successCount != null ? c.successCount : (c.totalProcessed || 0);
    const errs = c.errorCount != null ? c.errorCount : 0;
    if (t >= startOfTodayPH) todaySuccess += success;
    if (now - t <= WEEK) weekSuccess += success;
    if (now - t <= DAY) errors24h += errs;
  });

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  setVal('hero-today', todaySuccess);
  setVal('hero-week', weekSuccess);
  setVal('hero-errors', errors24h);

  const errSub = document.getElementById('hero-errors-sub');
  if (errSub) errSub.textContent = errors24h === 0 ? 'No errors' : `${errors24h} across ${history.filter((c) => now - new Date(c.startedAt || c.date || 0).getTime() <= DAY).length} runs`;

  // Next schedule — pull from /api/schedules if available
  fetch('/api/schedules').then((r) => r.ok ? r.json() : []).then((schedules) => {
    // no hero slot for next schedule; keep for future or skip
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-pane — live activity feed (mirrors #log-panel)
// ─────────────────────────────────────────────────────────────────────────────
function syncActivityFeed() {
  const feed = document.getElementById('rp-feed-list');
  const src = document.getElementById('log-panel');
  if (!feed || !src) return;
  const entries = Array.from(src.querySelectorAll('.entry')).slice(-10).reverse();
  if (entries.length === 0 || (entries.length === 1 && /waiting to start/i.test(entries[0].textContent))) {
    feed.innerHTML = '<div class="rp-feed-item"><span class="rp-feed-time">—</span><span class="rp-feed-text">Waiting for campaign…</span></div>';
    return;
  }
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  feed.innerHTML = entries.map((e) => {
    const txt = e.textContent.trim().replace(/^\[\d{1,2}:\d{2}(:\d{2})?\]\s*/, '');
    const m = e.textContent.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    const t = m ? m[1].substring(0, 5) : timeStr;
    const cls = e.className.includes('success') ? 'success'
              : e.className.includes('error') ? 'error'
              : '';
    return `<div class="rp-feed-item"><span class="rp-feed-time">${escHtml(t)}</span><span class="rp-feed-text ${cls}">${escHtml(txt.substring(0, 80))}</span></div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-pane — next schedule widget
// ─────────────────────────────────────────────────────────────────────────────
function updateNextScheduleWidget(schedules) {
  const nameEl = document.getElementById('rp-next-schedule-name');
  const timeEl = document.getElementById('rp-next-schedule-time');
  if (!nameEl || !timeEl) return;

  const enabled = (schedules || []).filter((s) => s.enabled && s.cron);
  if (!enabled.length) {
    nameEl.textContent = 'None';
    timeEl.textContent = 'No upcoming runs';
    return;
  }

  // Compute next fire time for a 5-part cron (m h dom mon dow) in local time
  const nextForCron = (cron) => {
    const p = cron.split(' ');
    if (p.length !== 5) return null;
    const [mn, hr, , , dow] = p;
    const min = parseInt(mn, 10);
    const hour = parseInt(hr, 10);
    if (isNaN(min) || isNaN(hour)) return null;
    const days = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : dow.split(',').map((d) => parseInt(d, 10)).filter((x) => !isNaN(x));
    const now = new Date();
    for (let offset = 0; offset < 14; offset++) {
      const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, min, 0, 0);
      if (!days.includes(cand.getDay())) continue;
      if (cand.getTime() > now.getTime()) return cand;
    }
    return null;
  };

  let best = null;
  enabled.forEach((s) => {
    const t = nextForCron(s.cron);
    if (t && (!best || t < best.time)) best = { time: t, schedule: s };
  });

  if (!best) {
    nameEl.textContent = 'None';
    timeEl.textContent = 'No upcoming runs';
    return;
  }

  nameEl.textContent = best.schedule.name || 'Scheduled run';
  const now = new Date();
  const isToday = best.time.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = best.time.toDateString() === tomorrow.toDateString();
  const timeOfDay = best.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const prefix = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : best.time.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  timeEl.textContent = `${prefix} · ${timeOfDay}`;
}

async function initUserChip() {
  const dateEl = document.getElementById('user-chip-date');
  if (dateEl) {
    const now = new Date();
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    dateEl.textContent = now.toLocaleDateString('en-GB', opts);
  }

  const emailEl = document.getElementById('user-chip-email');
  if (emailEl) {
    try {
      const res = await fetch('/api/me');
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      const data = await res.json();
      if (data.email) {
        emailEl.textContent = data.email;
        // Also default the identifier input to the logged-in email (unless
        // the operator explicitly saved a different value).
        const idInput = document.getElementById('my-identifier');
        if (idInput && !idInput.value) idInput.value = data.email;
      }
    } catch { /* */ }
  }
  updateGreeting();
}

// Greeting line in page header — "Good evening, Antonio" + date/time/city.
// Time-of-day bucket chooses morning/afternoon/evening/night; city pulled
// from the browser's IANA timezone.
function updateGreeting() {
  const greetEl = document.getElementById('greeting-wordmark');
  const subEl = document.getElementById('greeting-subtitle');
  if (!greetEl && !subEl) return;

  if (greetEl) {
    const emailEl = document.getElementById('user-chip-email');
    const email = (emailEl ? emailEl.textContent.trim() : '').toLowerCase();

    // Prefer the operator's real first name from column D of the State of
    // Operations sheet; fall back to the local part of the email only if SoO
    // isn't loaded yet or the email isn't listed there.
    let first = '';
    const sooEntry = sooData && sooData[email];
    if (sooEntry && sooEntry.firstName) {
      const raw = sooEntry.firstName.trim();
      first = raw.charAt(0).toUpperCase() + raw.slice(1);
    } else {
      const local = (email.split('@')[0] || '').trim();
      const firstRaw = local.split(/[._+-]/)[0] || 'there';
      first = firstRaw.charAt(0).toUpperCase() + firstRaw.slice(1).toLowerCase();
    }

    const h = new Date().getHours();
    const greet = h >= 5 && h < 12 ? 'Good morning'
      : h >= 12 && h < 17 ? 'Good afternoon'
      : h >= 17 && h < 22 ? 'Good evening'
      : 'Good night';
    greetEl.textContent = `${greet}, ${first}`;
  }

  if (subEl) {
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { weekday: 'long' });
    const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    let city = 'local';
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz.includes('/')) city = tz.split('/').pop().replace(/_/g, ' ');
    } catch (_) {}
    subEl.textContent = `${day} · ${date} · ${time} ${city}`;
  }
}

// Refresh greeting every 30s so the time ticks without a reload.
setInterval(() => { try { updateGreeting(); } catch (_) {} }, 30_000);

async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.href = '/login.html';
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled campaign notifier — 5-min heads-up + start ping
// ─────────────────────────────────────────────────────────────────────────────
const scheduleNotifiedKey = 'ortus-notified-fires';

function loadNotifiedFires() {
  try { return new Set(JSON.parse(localStorage.getItem(scheduleNotifiedKey) || '[]')); }
  catch { return new Set(); }
}

function saveNotifiedFires(set) {
  try {
    const arr = Array.from(set);
    // Prune entries older than 24h so the set stays small
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept = arr.filter((key) => {
      const parts = key.split(':');
      const ts = Number(parts[parts.length - 1]);
      return !isNaN(ts) && ts > cutoff;
    });
    localStorage.setItem(scheduleNotifiedKey, JSON.stringify(kept));
  } catch { /* */ }
}

function nextFireFromCron(cronExpr) {
  const p = (cronExpr || '').split(' ');
  if (p.length !== 5) return null;
  const [mn, hr, , , dow] = p;
  const min = parseInt(mn, 10);
  const hour = parseInt(hr, 10);
  if (isNaN(min) || isNaN(hour)) return null;
  const days = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : dow.split(',').map((d) => parseInt(d, 10)).filter((x) => !isNaN(x));
  const now = new Date();
  for (let offset = 0; offset < 14; offset++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, min, 0, 0);
    if (!days.includes(cand.getDay())) continue;
    if (cand.getTime() > now.getTime()) return cand;
  }
  return null;
}

async function pollScheduleNotifications() {
  try {
    const res = await fetch('/api/schedules');
    const schedules = await res.json();
    if (!Array.isArray(schedules)) return;

    const notified = loadNotifiedFires();
    const now = Date.now();

    schedules.filter((s) => s.enabled && s.cron).forEach((s) => {
      const next = nextFireFromCron(s.cron);
      if (!next) return;
      const fireMs = next.getTime();
      const msUntil = fireMs - now;
      const timeStr = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // 5-min heads-up (fire once when within the 4:30–5:30 window)
      if (msUntil > 4.5 * 60 * 1000 && msUntil <= 5.5 * 60 * 1000) {
        const key = `pre:${s.id}:${fireMs}`;
        if (!notified.has(key)) {
          notified.add(key);
          notify('Scheduled campaign starting soon', `${s.name} will start at ${timeStr} (in ~5 min).`);
        }
      }

      // Start ping (fire when within the -30s to +30s window)
      if (msUntil > -30 * 1000 && msUntil <= 30 * 1000) {
        const key = `start:${s.id}:${fireMs}`;
        if (!notified.has(key)) {
          notified.add(key);
          notify('Scheduled campaign started', `${s.name} is running now.`);
        }
      }
    });

    saveNotifiedFires(notified);
  } catch { /* */ }
}

function initScheduleNotifier() {
  // Check once at load, then every 30 seconds
  pollScheduleNotifications();
  setInterval(pollScheduleNotifications, 30 * 1000);
}

// Pull server-side desktop notifications (e.g. "about to launch connection
// check") and surface them as browser-push popups. Audience filtering is
// done server-side via req.user, so we just receive items meant for us.
let _lastDesktopNotifTs = (() => {
  try { return Number.parseInt(localStorage.getItem('ortus-last-notif-ts') || '0', 10) || 0; }
  catch { return 0; }
})();
async function pollServerDesktopNotifications() {
  try {
    const res = await fetch(`/api/notifications/recent?since=${_lastDesktopNotifTs}`);
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      notify(item.title, item.body);
    }
    if (items.length > 0) {
      _lastDesktopNotifTs = items[items.length - 1].ts;
      try { localStorage.setItem('ortus-last-notif-ts', String(_lastDesktopNotifTs)); } catch { /* */ }
    } else if (typeof data?.now === 'number' && data.now > _lastDesktopNotifTs) {
      _lastDesktopNotifTs = data.now;
      try { localStorage.setItem('ortus-last-notif-ts', String(_lastDesktopNotifTs)); } catch { /* */ }
    }
  } catch { /* */ }
}
async function loadNotificationPrefs() {
  try {
    const res = await fetch('/api/notification-prefs');
    if (!res.ok) return;
    const data = await res.json();
    const prefs = data?.prefs || {};
    const cb = document.getElementById('notif-pref-conn-check');
    if (cb) cb.checked = !!prefs.connectionCheckReminders;
  } catch { /* */ }
}
async function onNotifPrefChange(key, value) {
  try {
    await fetch('/api/notification-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: !!value }),
    });
  } catch { /* */ }
}
window.onNotifPrefChange = onNotifPrefChange;

function initServerDesktopNotifier() {
  // Poll every 60s — the post-campaign scheduler ticks every 30 min, so a
  // minute of latency on a popup is well within the user's tolerance and
  // doesn't add meaningful network load.
  pollServerDesktopNotifications();
  setInterval(pollServerDesktopNotifications, 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
initTheme();
initUserChip();
applySavedEdits();
initMyIdentifier();
restoreCollapsedSections();
restoreLastMode();
loadProfiles();
onModeChange();
pollStatus();
fetchTemplateList();
fetchHistory();
loadPersistedErrors();
loadPersistedWarnings();
initRunBarMirror();
initScrollSpy();
fetchSchedules();
updatePlaceholderTags();
updateCampaignSummary();
// Silent on-load check — only sets the flag, never pops an alert. The sidebar
// "Enable" button (which calls requestNotificationPermission) is where we ask
// for permission explicitly.
if ('Notification' in window && Notification.permission === 'granted') {
  notificationsEnabled = true;
}
initScheduleNotifier();
initServerDesktopNotifier();
loadNotificationPrefs();

// Open Profile toggle listener
document.getElementById('open-profile-msg')?.addEventListener('change', () => {
  onModeChange();
});

const _lastFocusedField = new WeakMap();
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
  const section = el.closest('.section');
  if (section) _lastFocusedField.set(section, el);
});

document.addEventListener('click', (e) => {
  const tag = e.target.closest('.placeholder-tags .tag');
  if (!tag) return;
  const container = tag.closest('.placeholder-tags');
  const section = container?.closest('.section');
  const targetId = container?.dataset.target;
  const fallback = targetId ? document.getElementById(targetId) : null;
  const field = (section && _lastFocusedField.get(section)) || fallback;
  if (!field) return;
  const val = tag.dataset.val;
  if (typeof field.selectionStart === 'number') {
    const start = field.selectionStart;
    field.value = field.value.substring(0, start) + val + field.value.substring(field.selectionEnd);
    field.selectionStart = field.selectionEnd = start + val.length;
  } else {
    field.value += val;
  }
  field.focus();
});

// ─────────────────────────────────────────────────────────────────────────────
// Campaign presets — save/load the entire form state (mode, accounts, sheet,
// templates, rate, limits) under a user-chosen name. Backed by /api/presets.
// ─────────────────────────────────────────────────────────────────────────────
function collectCurrentConfig() {
  const getV = (id) => document.getElementById(id)?.value ?? '';
  const getN = (id, fallback) => {
    const n = parseInt(getV(id), 10);
    return isNaN(n) ? fallback : n;
  };
  return {
    mode: getV('campaign-mode') || 'connect_only',
    sheetUrl: getV('sheet-url').trim(),
    profileIds: [...selectedProfileIds],
    // v2.11.0: ratePerHour / batchesPerHour removed from saved presets. Old
    // presets that still carry these fields are silently ignored on load.
    dailyLimit: getN('daily-limit', 50),
    messageGap: getN('message-gap', 60),
    delayMin: getN('within-batch-min', 15),
    delayMax: getN('within-batch-max', 45),
    messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked,
    addNote: localStorage.getItem('ortus-add-note') === '1',
    linkedinColumn: getV('linkedin-col-select'),
    templates: {
      connectionNote: getV('tpl-note'),
      followUp1: getV('tpl-followup'),
      inmailSubject: getV('tpl-inmail-subject'),
      inmailBody: getV('tpl-inmail-body'),
      openProfileSubject: getV('tpl-op-subject'),
      openProfileBody: getV('tpl-op-body'),
    },
  };
}

function applyPresetConfig(config) {
  if (!config || typeof config !== 'object') return;
  const setV = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };

  // v2.11.17: legacy presets had `mode: 'message_only'` + a separate
  // `templates.introMode: true` flag. The Introduce Back mode replaces
  // that combo. Auto-migrate so old presets keep working: if the saved
  // config carries the old shape, swap to the new mode here. Templates
  // (incl. introName, introTitle) carry over unchanged.
  if (config.mode === 'message_only' && config.templates && config.templates.introMode) {
    config = { ...config, mode: 'introduce_back' };
  }

  // Mode — triggers the rest of the mode-dependent UI
  if (config.mode) {
    setV('campaign-mode', config.mode);
    if (typeof onModeChange === 'function') onModeChange();
  }
  setV('sheet-url', config.sheetUrl || '');

  // v2.11.0: pacing knobs (ratePerHour, batchesPerHour) removed. Old presets
  // carrying these fields silently lose them on load — backend pacing is now
  // a fixed 6-min per-account turn floor + queue rotation.
  setV('daily-limit', config.dailyLimit ?? 50);
  setV('message-gap', config.messageGap ?? 60);
  setV('within-batch-min', config.delayMin ?? 15);
  setV('within-batch-max', config.delayMax ?? 45);
  if (config.linkedinColumn) setV('linkedin-col-select', config.linkedinColumn);

  const opCheck = document.getElementById('open-profile-msg');
  if (opCheck) opCheck.checked = !!config.messageOpenProfiles;

  if (typeof setAddNote === 'function') setAddNote(!!config.addNote);

  const t = config.templates || {};
  setV('tpl-note', t.connectionNote || '');
  setV('tpl-followup', t.followUp1 || '');
  setV('tpl-inmail-subject', t.inmailSubject || '');
  setV('tpl-inmail-body', t.inmailBody || '');
  setV('tpl-op-subject', t.openProfileSubject || '');
  setV('tpl-op-body', t.openProfileBody || '');

  // v2.14.x: CC+IC fields. These live inside config.templates as
  // primaryName / primaryUrl / primaryIntroBody / introTitle. Without
  // these restores, Re-run loses the primary person and the operator
  // has to retype everything (screenshot 2026-05-16).
  setV('primary-person-name', t.primaryName || '');
  setV('primary-person-url', t.primaryUrl || '');
  setV('primary-intro-body', t.primaryIntroBody || '');
  if (t.introTitle) setV('intro-title', t.introTitle);

  // v2.14.x: concurrency restore. concurrency=1 means single-worker
  // (toggle off); >1 means parallel mode (toggle on + count set).
  const _conc = Number(config.concurrency || 1);
  const _concTog = document.getElementById('concurrency-toggle');
  const _concCnt = document.getElementById('concurrency-count');
  if (_concTog && _concCnt) {
    _concTog.checked = _conc > 1;
    _concCnt.value = String(_conc > 1 ? _conc : 2);
    _concCnt.disabled = !(_conc > 1);
    if (typeof alphaSyncConcurrency === 'function') alphaSyncConcurrency();
  }

  // Restore selected profiles. If profiles haven't loaded yet the selection
  // will be re-applied by renderProfiles once they arrive.
  if (Array.isArray(config.profileIds)) {
    selectedProfileIds = [...config.profileIds];
    if (typeof renderProfiles === 'function' && Array.isArray(allProfilesData)) {
      renderProfiles(allProfilesData);
    }
    if (typeof renderSelectedPanel === 'function') renderSelectedPanel();
    if (typeof updateChipCounts === 'function') updateChipCounts();
  }

  if (typeof updateCampaignSummary === 'function') updateCampaignSummary();
}

// Mode label shown as a tag in the popover (short form).
const MODE_TAG = {
  connect_only: 'CC',
  message_only: 'DM',
  inmail_only: 'InMail',
  open_profile_only: 'OP',
  check_status: 'Status',
};

function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function refreshPresetList() {
  const listEl = document.getElementById('preset-pop-list');
  const countEl = document.getElementById('preset-pill-count');
  const lastTagEl = document.getElementById('preset-pop-last-tag');
  if (!listEl) return;

  // Fetch saved presets + last-used in parallel
  const [presetsData, lastUsedData] = await Promise.all([
    fetch('/api/presets').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch('/api/presets/_last_used').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  // Count pill
  const names = Object.keys(presetsData).sort((a, b) => a.localeCompare(b));
  if (countEl) countEl.textContent = String(names.length);

  // Last used row
  if (lastTagEl) {
    if (lastUsedData && lastUsedData.config) {
      const mode = MODE_TAG[lastUsedData.config.mode] || (lastUsedData.config.mode || '—');
      lastTagEl.textContent = `${relativeTime(lastUsedData.savedAt)} · ${mode}`;
    } else {
      lastTagEl.textContent = 'None yet';
    }
  }

  // Saved list
  listEl.innerHTML = '';
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-pop-empty';
    empty.textContent = 'No saved presets yet';
    listEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const meta = presetsData[name] || {};
    const row = document.createElement('div');
    row.className = 'preset-pop-item';

    const nameEl = document.createElement('span');
    nameEl.className = 'preset-pop-name';
    nameEl.textContent = name;

    const tag = document.createElement('span');
    tag.className = 'preset-pop-tag';
    tag.textContent = MODE_TAG[meta.mode] || (meta.mode || '');

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-pop-delete';
    del.textContent = '✕';
    del.title = 'Delete preset';
    del.addEventListener('click', (e) => { e.stopPropagation(); deletePreset(name); });

    const right = document.createElement('span');
    right.style.display = 'inline-flex';
    right.style.alignItems = 'center';
    right.style.gap = '10px';
    right.appendChild(tag);
    right.appendChild(del);

    row.appendChild(nameEl);
    row.appendChild(right);
    row.addEventListener('click', () => { loadPresetByName(name); closePresetPopover(); });
    listEl.appendChild(row);
  }
}

async function loadPresetByName(name) {
  if (!name) return;
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || `Could not load "${name}"`);
      return;
    }
    const entry = await res.json();
    applyPresetConfig(entry.config || {});
  } catch (err) {
    alert(`Load failed: ${err.message}`);
  }
}

async function loadLastUsedPreset() {
  try {
    const res = await fetch('/api/presets/_last_used');
    if (res.status === 404) { alert('No previous campaign to restore yet.'); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Could not load last-used settings');
      return;
    }
    const entry = await res.json();
    applyPresetConfig(entry.config || {});
  } catch (err) {
    alert(`Load failed: ${err.message}`);
  }
}

async function saveCurrentAsPreset() {
  // window.prompt() is a no-op in Electron — use the modal helper instead.
  const name = await promptModal({ label: 'Name this preset (e.g. vonnyii_op, vonnyii_cc):' });
  if (!name) return; // null = cancel / ESC / empty
  const trimmed = name; // promptModal already trims + nulls empty
  const config = collectCurrentConfig();
  try {
    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed, config }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Save failed');
      return;
    }
    await refreshPresetList();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

async function deletePreset(name) {
  if (!name) return;
  if (!confirm(`Delete preset "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Delete failed');
      return;
    }
    await refreshPresetList();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// Snapshot the current config as "last used" (called automatically when a
// campaign is kicked off). Silent — errors are logged, not surfaced.
async function saveLastUsedPreset() {
  try {
    await fetch('/api/presets/_last_used', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: collectCurrentConfig() }),
    });
  } catch (err) {
    console.warn('[presets] last-used save failed:', err.message);
  }
}

// Popover open/close + outside-click to dismiss.
function togglePresetPopover() {
  const pop = document.getElementById('preset-popover');
  if (!pop) return;
  if (pop.hidden) openPresetPopover();
  else closePresetPopover();
}
function openPresetPopover() {
  const pop = document.getElementById('preset-popover');
  if (!pop) return;
  pop.hidden = false;
  // Refresh on every open so times + list stay current
  refreshPresetList();
}
function closePresetPopover() {
  const pop = document.getElementById('preset-popover');
  if (pop) pop.hidden = true;
}
document.addEventListener('click', (e) => {
  const pill = document.getElementById('preset-pill');
  if (!pill) return;
  if (!pill.contains(e.target)) closePresetPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePresetPopover();
});

document.addEventListener('DOMContentLoaded', refreshPresetList);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11.3 — inline-onclick re-exposure for the ESM conversion.
// Every function referenced from an on*="…" attribute in public/index.html
// MUST live on `window` for the inline handler to resolve at click-time.
// Derived from:
//   grep -oE 'on(click|input|change|submit|blur|focus|keyup|keydown)="[^"]*"' public/index.html \
//     | grep -oE '[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(' \
//     | grep -oE '^[a-zA-Z_$][a-zA-Z0-9_$]*' \
//     | sort -u  (excluding the DOM api `stopPropagation`)
// If you add a new inline onclick in index.html, you MUST add it here too
// or the click throws ReferenceError at runtime.
// ─────────────────────────────────────────────────────────────────────────────
window.applyFilter = applyFilter;
window.applyPreset = applyPreset;
window.clearCampaignLog = clearCampaignLog;
window.clearHistory = clearHistory;
window.clearServerLog = clearServerLog;
window.closePresetPopover = closePresetPopover;
window.copyCampaignLog = copyCampaignLog;
window.deleteSelectedTemplate = deleteSelectedTemplate;
window.deselectAll = deselectAll;
window.downloadCsv = downloadCsv;
window.filterProfiles = filterProfiles;
window.handlePreviewClick = handlePreviewClick;
window.loadLastUsedPreset = loadLastUsedPreset;
window.loadProfiles = loadProfiles;
window.loadSelectedTemplate = loadSelectedTemplate;
window.onModeChange = onModeChange;
window.setModeByIndex = setModeByIndex;
window.previewSheet = previewSheet;
window.refreshSoO = refreshSoO;
window.requestNotificationPermission = requestNotificationPermission;
window.saveCurrentAsPreset = saveCurrentAsPreset;
window.saveCurrentTemplate = saveCurrentTemplate;
window.saveExistingTemplate = saveExistingTemplate;
window.saveMyIdentifier = saveMyIdentifier;
window.saveQuickSchedule = saveQuickSchedule;
window.scrollToSection = scrollToSection;
window.selectAllVisible = selectAllVisible;
window.setAddNote = setAddNote;
window.setLaunchMode = setLaunchMode;
window.setTheme = setTheme;
window.showBrowsers = showBrowsers;
window.signOut = signOut;
window.startCampaign = startCampaign;
window.startCheckDms = startCheckDms;
window.stepInput = stepInput;
window.stopCampaign = stopCampaign;
window.confirmStopCampaign = confirmStopCampaign;
window.confirmStopCampaignNow = confirmStopCampaignNow;
window.closeStopModal = closeStopModal;
window.pauseOrResumeCampaign = pauseOrResumeCampaign;
window.alphaSyncRate = alphaSyncRate;
window.alphaStepLeads = alphaStepLeads;
window.alphaSyncDailyLimit = alphaSyncDailyLimit;
window.alphaStepDaily = alphaStepDaily;
window.alphaSyncConcurrency = alphaSyncConcurrency;
window.toggleSection = toggleSection;
window.openUnifiedLog = openUnifiedLog;
window.openPastCampaignModal = openPastCampaignModal;
window.closePastCampaignModal = closePastCampaignModal;
window.rerunPastCampaign = rerunPastCampaign;
window.onPastRowCheckboxChange = onPastRowCheckboxChange;
window.singleDeletePast = singleDeletePast;
window.undoPendingDeletes = undoPendingDeletes;
window.togglePresetPopover = togglePresetPopover;
window.updateCampaignSummary = updateCampaignSummary;
// v2.12.x — Post Amplification inline handlers in index.html.
window.onPostAmpUrlChange = onPostAmpUrlChange;
window.setPostAmpFlag = setPostAmpFlag;
window.setPostAmpComment = setPostAmpComment;
window.openPostAmpSuggestions = openPostAmpSuggestions;
window.pickPostAmpSuggestion = pickPostAmpSuggestion;
window.savePostAmpTemplate = savePostAmpTemplate;
window.deletePostAmpTemplate = deletePostAmpTemplate;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.8.19 (A2/A3) — section readiness, summaries, and sidebar glyphs
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_ORDER = [
  { id: 'nav-settings',  key: 'settings',  required: true  },
  { id: 'nav-sheet',     key: 'sheet',     required: true  },
  { id: 'nav-accounts',  key: 'accounts',  required: true  },
  { id: 'nav-pace',      key: 'pace',      required: false },
  { id: 'nav-templates', key: 'templates', required: true  },
  { id: 'nav-launch',    key: 'launch',    required: true  },
];

// Phase 2.8.19 — one-time migration: rewrite stale numeric prefixes on saved
// h2 label overrides (e.g. "1.5. Rate & Limits" → "5. Rate & Limits") so
// renumbering after section reorders propagates without nuking user wording.
function _migrateStaleH2Numbers() {
  try {
    const raw = localStorage.getItem('ortus-edits');
    if (!raw) return false;
    const edits = JSON.parse(raw);
    if (!edits || typeof edits !== 'object') return false;
    const expectedNum = {
      'h2-settings':  '1.',
      'h2-sheet':     '2.',
      'h2-accounts':  '3.',
      'h2-pace':      '4.',
      'h2-templates': '5.',
      'h2-launch':    '6.',
    };
    let changed = false;
    for (const key of Object.keys(expectedNum)) {
      const cur = edits[key];
      if (typeof cur !== 'string') continue;
      // Match a leading number prefix: "5. ", "1.5. ", "10. ", etc.
      const m = cur.match(/^\s*\d+(?:\.\d+)?\.\s+(.*)$/);
      if (!m) continue;
      const rest = m[1];
      const corrected = `${expectedNum[key]} ${rest}`;
      if (corrected !== cur) {
        edits[key] = corrected;
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem('ortus-edits', JSON.stringify(edits));
    }
    return changed;
  } catch (_) {
    return false;
  }
}

function _humanAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _prettyMode(mode) {
  switch (mode) {
    case 'connect_only': return 'Connect';
    case 'message_only': return 'Message';
    case 'inmail_only': return 'InMail';
    case 'open_profile_only': return 'Open Profile';
    case 'check_status': return 'Check status';
    case 'auto': return 'Auto';
    default: return mode;
  }
}

function computeSectionReadiness() {
  const out = {};

  // Settings — done if mode is selected
  const modeEl = document.getElementById('campaign-mode');
  const mode = modeEl ? modeEl.value : '';
  const noteOn = (() => { try { return localStorage.getItem('ortus-add-note') === '1'; } catch (_) { return false; } })();
  out.settings = {
    state: mode ? 'done' : 'empty',
    summary: mode
      ? (mode === 'connect_only' ? `Connect · ${noteOn ? 'with note' : 'no note'}` : _prettyMode(mode))
      : '',
  };

  // Sheet — done if URL field non-empty
  const sheetUrl = (document.getElementById('sheet-url')?.value || '').trim();
  out.sheet = {
    state: sheetUrl ? 'done' : 'empty',
    summary: sheetUrl
      ? (window.__sheetPreviewCache
          ? `${window.__sheetPreviewCache.count} leads · ${_humanAgo(window.__sheetPreviewCache.at)}`
          : 'URL set · preview not loaded')
      : '',
  };

  // Accounts — done if at least one selected.
  // selectedProfileIds is a module-local `let` declared near the top of this file;
  // bare-symbol reference resolves because we're in the same script.
  const selCount = (typeof selectedProfileIds !== 'undefined' && selectedProfileIds && selectedProfileIds.length) || 0;
  out.accounts = {
    state: selCount > 0 ? 'done' : 'empty',
    summary: selCount > 0 ? `${selCount} selected` : '',
  };

  // Templates — done if a template body is non-empty for the current mode
  let tplBody = '';
  let tplName = '';
  const tplSel = document.getElementById('template-select');
  if (tplSel && tplSel.value) tplName = tplSel.value;
  if (mode === 'connect_only')           tplBody = (document.getElementById('tpl-note')?.value || '');
  else if (mode === 'message_only')      tplBody = (document.getElementById('tpl-followup')?.value || '');
  else if (mode === 'inmail_only')       tplBody = (document.getElementById('tpl-inmail-body')?.value || '');
  else if (mode === 'open_profile_only') tplBody = (document.getElementById('tpl-op-body')?.value || '');
  out.templates = {
    state: tplBody.trim() ? 'done' : 'empty',
    summary: tplBody.trim()
      ? `${tplName ? tplName + ' · ' : ''}${tplBody.trim().slice(0, 40)}${tplBody.trim().length > 40 ? '…' : ''}`
      : '',
  };

  // Throughput (pace) — non-required section. State still computed for
  // sidebar-glyph consistency, but no header summary (the section's own body
  // shows the live total — duplicating it in the header is noise).
  const rate = document.getElementById('rate-per-hour')?.value || '';
  out.pace = {
    state: rate ? 'done' : 'empty',
    summary: '',
  };

  // Launch — "done" means all required prior sections are done
  const allPriorDone =
    out.settings.state === 'done' &&
    out.sheet.state === 'done' &&
    out.accounts.state === 'done' &&
    out.templates.state === 'done';
  out.launch = { state: allPriorDone ? 'done' : 'empty', summary: allPriorDone ? 'ready' : 'blocked' };

  return out;
}

function updateSectionSummaries() {
  const readiness = computeSectionReadiness();
  for (const { key } of SECTION_ORDER) {
    const el = document.getElementById(`summary-${key}`);
    if (!el) continue;
    el.textContent = readiness[key].summary || '';
    el.classList.toggle('done', readiness[key].state === 'done');
    el.classList.toggle('empty', readiness[key].state === 'empty');
  }
  // A3 hook — refresh sidebar glyphs if A3 has been installed (safe no-op until then)
  if (typeof updateSidebarGlyphs === 'function') updateSidebarGlyphs(readiness);
  return readiness;
}

let _initialExpandApplied = false;
function applyInitialExpand() {
  if (_initialExpandApplied) return;
  _initialExpandApplied = true;
  const readiness = computeSectionReadiness();
  for (const { id, key, required } of SECTION_ORDER) {
    if (!required) continue;
    if (readiness[key].state !== 'empty') continue;
    const sec = document.getElementById(id);
    if (sec && sec.classList.contains('collapsible') && sec.classList.contains('collapsed')) {
      sec.classList.remove('collapsed');
      // intentional: do NOT writeback to localStorage
    }
    break;
  }
}

function updateSidebarGlyphs(readiness) {
  // readiness from computeSectionReadiness(); compute fresh if not provided
  const r = readiness || computeSectionReadiness();
  // Determine current section from existing scroll-spy active class
  const activeBtn = document.querySelector('.nav-item.active');
  const activeId = activeBtn ? activeBtn.getAttribute('data-nav') : null;

  // Items in scope: the five numbered sidebar nav items.
  // Throughput (`nav-pace`) is not in the sidebar (scroll-only).
  const items = [
    { id: 'nav-settings',  key: 'settings'  },
    { id: 'nav-sheet',     key: 'sheet'     },
    { id: 'nav-accounts',  key: 'accounts'  },
    { id: 'nav-templates', key: 'templates' },
    { id: 'nav-launch',    key: 'launch'    },
  ];
  for (const { id, key } of items) {
    const el = document.getElementById(`nav-glyph-${key}`);
    if (!el) continue;
    el.classList.remove('done', 'current', 'empty');
    if (id === activeId) {
      el.textContent = '▸';
      el.classList.add('current');
    } else if (r[key].state === 'done') {
      el.textContent = '✓';
      el.classList.add('done');
    } else {
      el.textContent = '◯';
      el.classList.add('empty');
    }
  }
}

// Wire summary refresh: a delegated input/change listener on document covers
// every form control inside any `.section` without needing to intercept the
// (locally-scoped) updateCampaignSummary symbol — that wrapper only catches
// `window.updateCampaignSummary` callers, missing direct in-file callers.
let _sectionSummaryDebounce = null;
function _scheduleSectionSummaryRefresh() {
  if (_sectionSummaryDebounce) return;
  _sectionSummaryDebounce = setTimeout(() => {
    _sectionSummaryDebounce = null;
    try { updateSectionSummaries(); } catch (_) {}
  }, 80);
}
document.addEventListener('input',  (e) => {
  if (e.target && e.target.closest && e.target.closest('.section')) _scheduleSectionSummaryRefresh();
}, true);
document.addEventListener('change', (e) => {
  if (e.target && e.target.closest && e.target.closest('.section')) _scheduleSectionSummaryRefresh();
}, true);

// Run once on initial load — apply default expand and render summaries.
// Defer slightly so other startup code (loadProfiles, fetchTemplateList, etc.)
// has a chance to populate state before we read it.
// Defer the one-shot initial render until after the async startup loaders
// (loadProfiles, fetchTemplateList, etc.) have had time to populate state.
// 1500 ms is a heuristic — these loaders are local-server fetches that
// typically settle in < 500 ms, but we leave headroom for slow machines
// (the project's target user base runs on overloaded laptops). The delegated
// input/change listeners above keep summaries fresh after this initial pass.
const INITIAL_RENDER_DELAY_MS = 1500;
function _doInitialSectionRender() {
  try {
    if (_migrateStaleH2Numbers()) {
      // Re-apply saved edits so the corrected labels paint to the DOM
      if (typeof applySavedEdits === 'function') applySavedEdits();
    }
    applyInitialExpand();
    updateSectionSummaries();
  } catch (_) {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_doInitialSectionRender, INITIAL_RENDER_DELAY_MS);
  });
} else {
  setTimeout(_doInitialSectionRender, INITIAL_RENDER_DELAY_MS);
}

// Run migration synchronously too — covers the < 1500ms window before deferred render
try {
  if (_migrateStaleH2Numbers() && typeof applySavedEdits === 'function') applySavedEdits();
} catch (_) {}

// Phase 2.8.19 (C3) — two-way bind Settings "Local browser name" with the
// dynamically-rendered profile-card input (#local-browser-first-name). Both
// read/write the same localStorage.localBrowserFirstName key, but the card
// input is rendered conditionally inside renderProfiles, so we use a
// delegated listener for that direction.
(function bindLocalBrowserNameSetting() {
  const settingsInput = document.getElementById('settings-local-browser-name');
  if (!settingsInput) return;

  // Initial hydrate from the module-local value (already loaded from localStorage at top of file)
  settingsInput.value = (typeof localBrowserFirstName === 'string') ? localBrowserFirstName : '';

  // Settings → state + card mirror
  settingsInput.addEventListener('input', (e) => {
    localBrowserFirstName = e.target.value;
    try { localStorage.setItem('localBrowserFirstName', localBrowserFirstName); } catch (_) {}
    const cardInput = document.getElementById('local-browser-first-name');
    if (cardInput && cardInput.value !== e.target.value) cardInput.value = e.target.value;
  });

  // Card → settings mirror (delegated because card input may not exist yet)
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'local-browser-first-name') {
      if (settingsInput.value !== e.target.value) settingsInput.value = e.target.value;
    }
  });
})();

// Phase 2.8.19 (C4) — sidebar Notifications panel state rendering.
async function refreshNotifPanel() {
  // Browser push permission
  const pushEl = document.getElementById('notif-push-state');
  const enableBtn = document.getElementById('notif-enable-btn');
  if (pushEl) {
    pushEl.classList.remove('ok', 'warn', 'bad');
    if (!('Notification' in window)) {
      pushEl.textContent = 'unavailable';
      pushEl.classList.add('warn');
      if (enableBtn) enableBtn.style.display = 'none';
    } else {
      const p = Notification.permission;
      if (p === 'granted') { pushEl.textContent = 'granted'; pushEl.classList.add('ok'); }
      else if (p === 'denied') { pushEl.textContent = 'denied'; pushEl.classList.add('bad'); }
      else { pushEl.textContent = 'default'; pushEl.classList.add('warn'); }
      if (enableBtn) enableBtn.style.display = (p === 'default') ? 'inline-block' : 'none';
    }
  }
  // SMTP wired
  const smtpEl = document.getElementById('notif-smtp-state');
  if (smtpEl) {
    smtpEl.classList.remove('ok', 'warn', 'bad');
    try {
      const res = await fetch('/api/notify/status');
      if (res.ok) {
        const data = await res.json();
        if (data.smtpConfigured) { smtpEl.textContent = 'wired'; smtpEl.classList.add('ok'); }
        else { smtpEl.textContent = 'not configured'; smtpEl.classList.add('warn'); }
      }
    } catch (_) { /* leave as — */ }
  }
  // Last test
  const lastEl = document.getElementById('notif-last-test');
  if (lastEl) {
    lastEl.classList.remove('ok', 'warn', 'bad');
    try {
      const raw = localStorage.getItem('ortus-last-notify-test');
      if (raw) {
        const { at, result } = JSON.parse(raw);
        const ago = (typeof _humanAgo === 'function') ? _humanAgo(at) : new Date(at).toLocaleTimeString();
        lastEl.textContent = `${ago} · ${result}`;
        lastEl.classList.add(result === 'delivered' ? 'ok' : 'bad');
      } else {
        lastEl.textContent = 'never';
        lastEl.classList.add('warn');
      }
    } catch (_) { /* */ }
  }
}

window.refreshNotifPanel = refreshNotifPanel;

// Run once on initial load (after the existing deferred render kick from A2).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setTimeout(refreshNotifPanel, 200); });
} else {
  setTimeout(refreshNotifPanel, 200);
}

// Phase 2.8.20 (W1-B1) — surface parked profiles in the right pane.
function _humanAgoFromTs(ts) {
  if (!ts || !Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _prettyParkReason(r) {
  switch (r) {
    case 'consecutive_skips': return 'too many skips';
    case 'session_expired':   return 'session expired';
    default:                  return r || 'parked';
  }
}

function renderParkedProfiles(parked) {
  const row = document.getElementById('rp-parked-row');
  const line = document.getElementById('rp-parked-line');
  const detail = document.getElementById('rp-parked-detail');
  if (!row || !line || !detail) return;
  const list = Array.isArray(parked) ? parked : [];
  if (list.length === 0) {
    row.hidden = true;
    line.classList.remove('has-parked');
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }
  row.hidden = false;
  line.classList.add('has-parked');
  const names = list.map(p => p.pName || p.profileId).join(', ');
  line.textContent = `${list.length} parked · ${names}`;
  detail.innerHTML = list.map(p => `
    <span class="rp-parked-item">
      <span class="rp-parked-name">${(p.pName || p.profileId)}</span>
      <span class="rp-parked-reason">${_prettyParkReason(p.reason)}</span>
      · ${_humanAgoFromTs(p.parkedAt)}
    </span>
  `).join('');
}

function toggleParkedDetail() {
  const detail = document.getElementById('rp-parked-detail');
  if (detail) detail.hidden = !detail.hidden;
}

window.toggleParkedDetail = toggleParkedDetail;

// ─── Soft warnings (W2 of 2.8.22) ───────────────────────────────────────────

function _prettyWarningKind(k) {
  switch (k) {
    case 'weekly_limit': return 'Weekly limit';
    case 'rate_limited': return 'Rate limited';
    case 'email_required': return 'Email required';
    case 'how_do_you_know': return 'Know-them prompt';
    case 'page_error': return 'Page error';
    default: return 'Warning';
  }
}

function renderSoftWarnings(warnings) {
  const row = document.getElementById('rp-warnings-row');
  const line = document.getElementById('rp-warnings-line');
  const detail = document.getElementById('rp-warnings-detail');
  if (!row || !line || !detail) return;

  const runtime = Array.isArray(warnings) ? warnings : [];
  const persisted = Array.isArray(_persistedWarnings) ? _persistedWarnings : [];
  // Merge by (profileId, kind, detectedAt) — runtime takes precedence on overlap
  const seen = new Set(runtime.map(w => `${w.profileId}|${w.kind}|${w.detectedAt}`));
  const merged = runtime.concat(persisted.filter(w => !seen.has(`${w.profileId}|${w.kind}|${w.detectedAt}`)));
  const list = merged;
  if (list.length === 0) {
    row.hidden = true;
    line.classList.remove('has-warnings');
    line.textContent = '—';
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }

  row.hidden = false;
  line.classList.add('has-warnings');

  // Most-recent first
  const sorted = list.slice().sort((a, b) => b.detectedAt - a.detectedAt);
  const newest = sorted[0];
  const ago = _humanAgoFromTs(newest.detectedAt);
  const summary = `${(newest.pName || newest.profileId)} · ${_prettyWarningKind(newest.kind)} · ${ago}`;
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '';
  line.textContent = summary + more;

  // Detail: full list, one per line
  detail.innerHTML = sorted.map(w => `
    <div class="rp-warnings-item">
      <span class="rp-warnings-name">${escapeHtml(w.pName || w.profileId)}</span> ·
      <span class="rp-warnings-kind">${_prettyWarningKind(w.kind)}</span> ·
      <span class="rp-warnings-msg">${escapeHtml(w.message || '')}</span>
      <span class="rp-warnings-time">${_humanAgoFromTs(w.detectedAt)}</span>
    </div>
  `).join('');
}

function toggleWarningDetail() {
  const detail = document.getElementById('rp-warnings-detail');
  if (!detail) return;
  detail.hidden = !detail.hidden;
}
window.toggleWarningDetail = toggleWarningDetail;

// Phase 2.8.20 (W1-B2) — fetch persisted errors and merge with in-memory ones.
// Public surfaces (hero-errors count) intentionally untouched — they aggregate
// from /api/history which already survives refresh. These helpers are exposed
// for future "Recent errors" UI surfaces.
let _persistedErrorsCache = [];
async function loadPersistedErrors() {
  try {
    const res = await fetch('/api/errors');
    if (!res.ok) return _persistedErrorsCache;
    const arr = await res.json();
    if (Array.isArray(arr)) _persistedErrorsCache = arr;
    return _persistedErrorsCache;
  } catch (_) { return _persistedErrorsCache; }
}

function mergedErrorsForCount(liveErrors) {
  // Dedup by `at + message` so the same error doesn't show twice when both
  // the live in-memory array and the disk log contain it.
  const seen = new Set();
  const out = [];
  const push = (e) => {
    if (!e) return;
    const at = e.at || e.time || '';
    const key = `${at}|${e.message || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of (_persistedErrorsCache || [])) push(e);
  for (const e of (liveErrors || [])) push(e);
  return out;
}

window.loadPersistedErrors = loadPersistedErrors;
window.mergedErrorsForCount = mergedErrorsForCount;

let _persistedWarnings = [];
async function loadPersistedWarnings() {
  try {
    const r = await fetch('/api/warnings');
    if (!r.ok) return;
    const { warnings } = await r.json();
    _persistedWarnings = Array.isArray(warnings) ? warnings : [];
    if (typeof renderSoftWarnings === 'function') {
      renderSoftWarnings(_persistedWarnings);
    }
  } catch {}
}
window.loadPersistedWarnings = loadPersistedWarnings;

// Phase 2.8.20 (W3-C2) — disk-low banner driven by /api/campaign/status payload.
function _formatBytesClient(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function renderDiskBanner(disk) {
  const banner = document.getElementById('disk-warning-banner');
  const text = document.getElementById('disk-warning-text');
  if (!banner || !text) return;
  if (!disk || disk.ok !== false) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  text.textContent = `Disk: ${_formatBytesClient(disk.freeBytes)} free — clear space before launching.`;
}

// ─────────────────────────────────────────────────────────────────────────
// v2.11.17: Introduce Back is now a first-class mode; the previous
// Standard DM / Introduction segment toggle inside Message Only is gone.
// Selecting the introduce_back card IS the introMode signal.
//
// What's retained: persistence of intro-name and intro-title across
// reloads (best-effort via localStorage with try/catch, since some
// Chromium / enterprise environments block storage). setIntroMode is
// kept as a no-op shim so any cached HTML still calling it doesn't error.
// ─────────────────────────────────────────────────────────────────────────
function setIntroMode() { /* deprecated in v2.11.17 — segment toggle removed */ }
function saveIntroFields() {
  const name  = document.getElementById('intro-name')?.value || '';
  const title = document.getElementById('intro-title')?.value || '';
  try { localStorage.setItem('ortus-intro-name', name); }   catch { /* storage blocked */ }
  try { localStorage.setItem('ortus-intro-title', title); } catch { /* storage blocked */ }
}

function restoreIntroState() {
  const nameEl  = document.getElementById('intro-name');
  const titleEl = document.getElementById('intro-title');
  try {
    if (nameEl)  nameEl.value  = localStorage.getItem('ortus-intro-name')  || nameEl.value;
    if (titleEl) titleEl.value = localStorage.getItem('ortus-intro-title') || titleEl.value;
  } catch { /* storage blocked — DOM defaults stand */ }
}
document.addEventListener('DOMContentLoaded', restoreIntroState);

// Connect + Introduce Back fields (mode-specific to connect_and_introduce).
// Persisted to localStorage so the wizard repopulates after navigation.
function savePrimaryPersonFields() {
  try {
    localStorage.setItem('ortus-primary-name', document.getElementById('primary-person-name')?.value || '');
    localStorage.setItem('ortus-primary-url',  document.getElementById('primary-person-url')?.value  || '');
    localStorage.setItem('ortus-primary-body', document.getElementById('primary-intro-body')?.value  || '');
  } catch { /* storage blocked */ }
}
function restorePrimaryPersonState() {
  try {
    const nameEl = document.getElementById('primary-person-name');
    const urlEl  = document.getElementById('primary-person-url');
    const bodyEl = document.getElementById('primary-intro-body');
    if (nameEl) nameEl.value = localStorage.getItem('ortus-primary-name') || nameEl.value;
    if (urlEl)  urlEl.value  = localStorage.getItem('ortus-primary-url')  || urlEl.value;
    if (bodyEl) bodyEl.value = localStorage.getItem('ortus-primary-body') || bodyEl.value;
  } catch { /* storage blocked — DOM defaults stand */ }
}
window.savePrimaryPersonFields = savePrimaryPersonFields;
document.addEventListener('DOMContentLoaded', restorePrimaryPersonState);
if (document.readyState !== 'loading') restorePrimaryPersonState();
// app.js is loaded as <script type="module">, so top-level `function`
// declarations are module-scoped. onclick="setIntroMode(true)" in the HTML
// can't see them unless we explicitly attach to window. Same pattern as
// applyPreset / setAddNote / toggleSection above.
window.setIntroMode = setIntroMode;
window.saveIntroFields = saveIntroFields;
// If the script loads after DOMContentLoaded already fired (common with
// type=module), the listener above won't fire — call once now too.
if (document.readyState !== 'loading') restoreIntroState();

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard route — landing view at #/, lists active + past campaigns
// ─────────────────────────────────────────────────────────────────────────────
// v2.52.0: dashboard-only short codes so the row subtitle doesn't read
// like raw enum values (CONNECT_AND_INTRODUCE looked like a database
// column). Operator-facing nicknames only — the canonical mode strings
// in payloads, history, and the wizard stay untouched.
const DASHBOARD_MODE_LABELS = {
  connect_only: 'Connect Only',
  check_status: 'Check Status',
  message_only: 'Message Only',
  inmail_only: 'InMail Only',
  open_profile_only: 'Open Profile Message',
  check_dms: 'Check DMs',
  connect_and_introduce: 'CC + IB',
  introduce_back: 'IB',
};
function dashboardModeLabel(value) {
  return DASHBOARD_MODE_LABELS[value] || value || '—';
}
function dashboardFormatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Auto-refresh the active campaign row while the operator is on the dashboard.
// 5s feels live for pause/resume transitions without being noisy. Stops when
// the route changes to the wizard so we don't hit /api/campaign/status from
// inside the campaign page (which already polls separately).
let _dashboardPollTimer = null;
function startDashboardPolling() {
  if (_dashboardPollTimer) return;
  _dashboardPollTimer = setInterval(() => {
    if (document.body.classList.contains('route-dashboard')) {
      refreshActiveCampaign();
    } else {
      stopDashboardPolling();
    }
  }, 5000);
}
function stopDashboardPolling() {
  if (_dashboardPollTimer) {
    clearInterval(_dashboardPollTimer);
    _dashboardPollTimer = null;
  }
}

// While the wizard is open, poll campaign status so the Add to Queue /
// Start Campaign label flips the moment the running campaign finishes
// (no need to navigate away and back).
let _wizardPollTimer = null;
function startWizardPolling() {
  if (_wizardPollTimer) return;
  _wizardPollTimer = setInterval(() => {
    if (document.body.classList.contains('route-wizard')) {
      if (typeof updateWizardQueueState === 'function') updateWizardQueueState();
    } else {
      stopWizardPolling();
    }
  }, 5000);
}
function stopWizardPolling() {
  if (_wizardPollTimer) {
    clearInterval(_wizardPollTimer);
    _wizardPollTimer = null;
  }
}

function applyRoute() {
  const isWizard = (window.location.hash || '#/').startsWith('#/new');
  document.body.classList.toggle('route-wizard', isWizard);
  document.body.classList.toggle('route-dashboard', !isWizard);
  if (!isWizard) {
    refreshDashboard();
    startDashboardPolling();
    stopWizardPolling();
  } else {
    stopDashboardPolling();
    // Pull the latest name on entry so a rename done from the dashboard (or
    // from another tab) is reflected in the wizard input. No-op if nothing
    // has changed.
    if (typeof syncCampaignNameInput === 'function') syncCampaignNameInput();
    if (typeof updateWizardQueueState === 'function') updateWizardQueueState();
    startWizardPolling();
  }
}

// Updates the wizard's banner + Start button label based on whether a
// campaign is currently running. When running, this build will be queued
// (server already enforces this) — say so out loud so the operator knows
// they're not editing the active campaign.
async function updateWizardQueueState() {
  const banner = document.getElementById('wizard-queue-banner');
  const startBtn = document.getElementById('btn-start');
  if (!banner && !startBtn) return;
  let isRunning = false;
  let runningName = '';
  try {
    const r = await fetch('/api/campaign/status');
    if (r.ok) {
      const status = await r.json();
      isRunning = !!(status.running || status.paused);
      runningName = status.name || '';
    }
  } catch {}
  if (banner) {
    banner.style.display = isRunning ? '' : 'none';
    const detail = document.getElementById('wizard-queue-banner-detail');
    if (detail && isRunning) {
      const ref = runningName ? `"${runningName}"` : 'A campaign';
      detail.textContent = `${ref} is currently running — this one will be added to the queue and start automatically when there's a free slot.`;
    }
  }
  if (startBtn) {
    if (isRunning) {
      startBtn.textContent = 'Add to Queue';
      startBtn.classList.add('btn-queue');
      // Force-enable: setCampaignButtons disables btn-start while a
      // campaign runs (correct for the "single-campaign" world). In queue
      // mode the operator IS clicking it intentionally to enqueue, so we
      // override that disable.
      startBtn.disabled = false;
    } else {
      startBtn.textContent = 'Start Campaign';
      startBtn.classList.remove('btn-queue');
      // Don't touch disabled here — let setCampaignButtons own it when
      // we're back to single-campaign mode.
    }
  }
  // Live Status section is always visible on the wizard route — that's where
  // the log panel + Copy/Clear Log + Show Browsers buttons live. Prior
  // attempts to hide it mid-run also hid those controls, which the operator
  // needs even while a campaign is running. CSS already hides the section
  // on the dashboard route via the #wizard-view parent.
}
window.updateWizardQueueState = updateWizardQueueState;
function goCreateCampaign() { window.location.hash = '#/new'; }
function goDashboard()      { window.location.hash = '#/'; }

async function refreshDashboard() {
  await Promise.all([refreshActiveCampaign(), refreshDashboardQueue(), refreshDashboardSchedules(), refreshDashboardDrafts(), refreshPastCampaigns()]);
}

// Dashboard's Drafts section. Multi-draft store backs this — operator can
// stage multiple campaigns in parallel, queue or delete any of them.
async function refreshDashboardDrafts() {
  const list = document.getElementById('drafts-campaign-list');
  if (!list) return;
  try {
    const data = await fetch('/api/drafts').then((r) => r.json());
    const drafts = Array.isArray(data?.drafts) ? data.drafts : [];
    if (drafts.length === 0) {
      list.innerHTML = '<p class="empty-state">No drafts yet.</p>';
      return;
    }
    drafts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    list.innerHTML = drafts.map((d) => {
      const name = d.name || '(unnamed draft)';
      const created = dashboardFormatDate(d.createdAt) || '—';
      return `
        <div class="campaign-row campaign-row--with-edit" data-campaign-id="${escHtml(d.id || '')}" data-state="draft">
          <span class="campaign-row-name">${escHtml(name)}</span>
          <span class="campaign-row-type">Draft</span>
          <span class="campaign-row-progress">Created ${escHtml(created)}</span>
          <span class="campaign-row-status">Draft</span>
          <span class="campaign-row-actions">
            <button type="button" class="campaign-row-edit" onclick="editDraft('${escHtml(d.id)}')" title="Open in wizard">Edit</button>
            <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="deleteDraft('${escHtml(d.id)}')" title="Delete this draft" aria-label="Delete draft">×</button>
          </span>
        </div>
      `;
    }).join('');
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load drafts.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

async function deleteDraft(id) {
  if (!id) return;
  if (!confirm('Delete this draft?')) return;
  try {
    await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (err) {
    alert('Failed: ' + err.message);
    return;
  }
  // If the wizard is currently editing this draft, drop the reference.
  try {
    if (localStorage.getItem('currentDraftId') === id) {
      localStorage.removeItem('currentDraftId');
    }
  } catch {}
  refreshDashboardDrafts();
}
window.deleteDraft = deleteDraft;

async function editDraft(id) {
  if (!id) return;
  try { localStorage.setItem('currentDraftId', id); } catch {}
  // Pre-fill the wizard's name input from the draft so the user sees it
  // immediately (syncCampaignNameInput will pick up currentDraftId on
  // wizard entry too, but setting it here avoids a flicker).
  try {
    const r = await fetch('/api/drafts/' + encodeURIComponent(id));
    if (r.ok) {
      const d = await r.json();
      const input = document.getElementById('campaign-name-input');
      if (input && d) input.value = d.name || '';
    }
  } catch {}
  goCreateCampaign();
}
window.editDraft = editDraft;

// Dashboard's Queued section. Lists campaigns waiting for the running
// one to finish so they can auto-launch in FIFO order. Cancel button
// removes an entry before its slot comes up.
async function refreshDashboardQueue() {
  const list = document.getElementById('queued-campaign-list');
  if (!list) return;
  try {
    const data = await fetch('/api/queue').then((r) => r.json());
    const queue = Array.isArray(data?.queue) ? data.queue : [];
    if (queue.length === 0) {
      list.innerHTML = '<p class="empty-state">No queued campaigns.</p>';
      return;
    }
    list.innerHTML = queue.map((q, idx) => {
      const name = q.name || '(unnamed)';
      const modeLabel = dashboardModeLabel(q.mode || '');
      const accountCount = (q.profileIds || []).length;
      const accountLabel = accountCount ? `${accountCount} account${accountCount === 1 ? '' : 's'}` : '';
      const positionLabel = idx === 0 ? 'Next up' : `Position ${idx + 1}`;
      const isFirst = idx === 0;
      const isLast = idx === queue.length - 1;
      return `
        <div class="campaign-row campaign-row--with-edit" data-campaign-id="${escHtml(q.id || '')}" data-state="queued">
          <span class="campaign-row-name">${escHtml(name)}</span>
          <span class="campaign-row-type">${escHtml(modeLabel)}${accountLabel ? ' · ' + accountLabel : ''}</span>
          <span class="campaign-row-progress">${escHtml(positionLabel)}</span>
          <span class="campaign-row-status">Queued</span>
          <span class="campaign-row-actions">
            <button type="button" class="campaign-row-edit" onclick="editQueuedCampaign('${escHtml(q.id)}')" title="Edit this queued campaign">Edit</button>
            <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="moveQueuedCampaign('${escHtml(q.id)}','up')" title="Move up" aria-label="Move up" ${isFirst ? 'disabled' : ''}>↑</button>
            <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="moveQueuedCampaign('${escHtml(q.id)}','down')" title="Move down" aria-label="Move down" ${isLast ? 'disabled' : ''}>↓</button>
            <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="cancelQueuedCampaign('${escHtml(q.id)}')" title="Remove from queue" aria-label="Remove from queue">×</button>
          </span>
        </div>
      `;
    }).join('');
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load queue.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

async function cancelQueuedCampaign(id) {
  if (!id) return;
  if (!confirm('Remove this campaign from the queue?')) return;
  try {
    await fetch('/api/queue/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch {}
  refreshDashboardQueue();
}
window.cancelQueuedCampaign = cancelQueuedCampaign;

// Edit a queued campaign: pulls full config, removes the entry from the
// queue (so it doesn't auto-fire mid-edit), creates a draft from it, and
// opens the wizard hydrated. Re-queueing happens when the operator hits
// Add to Queue at the bottom of the wizard.
async function editQueuedCampaign(id) {
  if (!id) return;
  let entry = null;
  try {
    const r = await fetch('/api/queue/' + encodeURIComponent(id));
    if (!r.ok) { alert('Could not load queued campaign.'); return; }
    entry = await r.json();
  } catch (err) { alert('Failed: ' + err.message); return; }
  if (!entry || !entry.config) { alert('Queue entry has no config to edit.'); return; }

  // Remove from queue so we don't have a duplicate when the user re-saves.
  try { await fetch('/api/queue/' + encodeURIComponent(id), { method: 'DELETE' }); } catch {}

  // Stage as a draft so the same wizard plumbing the multi-draft store uses
  // applies (Save Name updates the draft, launching consumes it).
  let draftId = '';
  try {
    const r = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: entry.name || '', config: entry.config }),
    });
    if (r.ok) {
      const data = await r.json();
      draftId = data?.draft?.id || '';
    }
  } catch {}
  if (draftId) {
    try { localStorage.setItem('currentDraftId', draftId); } catch {}
  }

  const nameInput = document.getElementById('campaign-name-input');
  if (nameInput) nameInput.value = entry.name || '';
  if (typeof applyPresetConfig === 'function') applyPresetConfig(entry.config);
  goCreateCampaign();
}
window.editQueuedCampaign = editQueuedCampaign;

async function moveQueuedCampaign(id, direction) {
  if (!id || (direction !== 'up' && direction !== 'down')) return;
  try {
    await fetch('/api/queue/' + encodeURIComponent(id) + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction }),
    });
  } catch {}
  refreshDashboardQueue();
}
window.moveQueuedCampaign = moveQueuedCampaign;

// v2.14 — fetches monitoring state alongside cron schedules. Renders the
// Monitoring card (if active) above the existing cron-schedule rows.
async function refreshDashboardSchedules() {
  const list = document.getElementById('schedules-campaign-list');
  if (!list) return;
  try {
    // Fetch both in parallel
    const [monState, schedules] = await Promise.all([
      fetch('/api/monitoring/state').then((r) => r.json()).catch(() => null),
      fetch('/api/schedules').then((r) => r.json()).catch(() => []),
    ]);

    const parts = [];
    const monHtml = renderMonitoringCard(monState);
    if (monHtml) parts.push(monHtml);

    if (Array.isArray(schedules) && schedules.length > 0) {
      const dayMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
      const schedHtml = schedules.map((s) => {
        const sParts = (s.cron || '').split(' ');
        let cronFriendly = s.cron || '';
        if (sParts.length === 5) {
          const min = sParts[0].padStart(2, '0');
          const hr = sParts[1].padStart(2, '0');
          const days = sParts[4] === '*' ? 'Every day' : sParts[4].split(',').map(d => dayMap[d] || d).join(', ');
          cronFriendly = `${hr}:${min} · ${days}`;
        }
        const lastRun = s.lastRun ? dashboardFormatDate(s.lastRun) : 'Never run';
        const limit = s.dailyLimit != null ? `${s.dailyLimit}/day` : '';
        return `
          <div class="campaign-row campaign-row--with-edit" data-campaign-id="${escHtml(s.id || '')}" data-state="schedules">
            <span class="campaign-row-name">${escHtml(s.name || 'Schedule')}</span>
            <span class="campaign-row-type">${escHtml(dashboardModeLabel(s.mode))}</span>
            <span class="campaign-row-progress">${escHtml(cronFriendly)}${limit ? ' · ' + escHtml(limit) : ''} · last ${escHtml(lastRun)}</span>
            <span class="campaign-row-status">Scheduled</span>
            <span class="campaign-row-actions">
              <button type="button" class="campaign-row-edit" onclick="queueScheduleNow('${escHtml(s.id)}')" title="Queue this schedule to run as soon as a slot opens">Run now</button>
              <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="deleteSchedule('${escHtml(s.id)}')" title="Delete this schedule" aria-label="Delete schedule">×</button>
            </span>
          </div>
        `;
      }).join('');
      parts.push(schedHtml);
    }

    if (parts.length === 0) {
      list.innerHTML = '<p class="empty-state">No schedules yet. Create one from the Launch step → switch to Schedule.</p>';
    } else {
      list.innerHTML = parts.join('');
    }
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load schedules.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

// v2.14 — renders the Monitoring card for the Schedules lane.
// Returns an HTML string (or '' if no monitoring campaign is active).
function renderMonitoringCard(state) {
  if (!state || state.state !== 'monitoring') return '';

  const now = Date.now();
  const next = state.nextCheckAt ? new Date(state.nextCheckAt) : null;
  const until = state.monitoringUntil ? new Date(state.monitoringUntil) : null;
  const remainingMs = until ? until.getTime() - now : 0;
  const endingSoon = remainingMs > 0 && remainingMs <= 24 * 60 * 60 * 1000;

  const hhmm = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—';
  const _fmtRemaining = (ms) => {
    if (ms <= 0) return '0m';
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const profileIds = state.profileIds || [];
  const profileNames = state.profileNames || [];
  const participating = state.participatingProfileIds || [];
  const accountRows = participating.map((pid) => {
    const idx = profileIds.indexOf(pid);
    const name = idx >= 0 ? (profileNames[idx] || pid) : pid;
    return `<div class="mon-account-row">${escHtml(name)}<span class="check-time">monitoring</span></div>`;
  }).join('') || '<div class="mon-account-row" style="color:var(--gray)">No accounts</div>';

  // Counts derived from logs would require backend work; for v1, show placeholders the operator can update if needed.
  // The operator's sheet is the source of truth — counts here are informational.
  const logs = state.logs || [];
  const logsHtml = logs.slice(-100).map((line) => `<div>${escHtml(line)}</div>`).join('');

  const badgeClass = endingSoon ? 'mon-badge ending-soon' : 'mon-badge';
  const badgeText = endingSoon ? '● ENDING SOON' : '● MONITORING';
  const endingLine = endingSoon
    ? `Window ends in <b>${escHtml(_fmtRemaining(remainingMs))}</b> — still-pending leads will be stamped <i>Closed - Not Connected</i>`
    : `Next check: <b>${escHtml(hhmm(next))}</b> · ends in <b>${escHtml(_fmtRemaining(remainingMs))}</b>`;

  return `
    <div class="mon-card" id="monitoring-card">
      <div class="mon-row">
        <div>
          <div class="mon-title">
            BULK CONNECTION CHECK + INTRODUCE
            <span class="${badgeClass}">${badgeText}</span>
          </div>
          <div class="mon-next">${endingLine}</div>
        </div>
      </div>
      <button class="mon-btn-expand" onclick="toggleMonitoringCard()">▾ Show details</button>
      <div class="mon-details" id="monitoring-details" style="display:none">
        <div class="mon-actions">
          <button class="mon-btn" id="mon-check-now-btn" onclick="monitoringCheckNow()">⚡ Check now</button>
          <button class="mon-btn danger" onclick="monitoringStop()">✕ Stop monitoring</button>
        </div>
        <div class="mon-sub-label">Accounts (${participating.length})</div>
        <div class="mon-accounts">${accountRows}</div>
        <div class="mon-sub-label">Log (live)</div>
        <div class="mon-log">${logsHtml || '<div style="color:var(--gray)">No log entries yet.</div>'}</div>
      </div>
    </div>
  `;
}

function toggleMonitoringCard() {
  const card = document.getElementById('monitoring-card');
  const details = document.getElementById('monitoring-details');
  if (!card || !details) return;
  const isOpen = details.style.display !== 'none';
  if (isOpen) {
    details.style.display = 'none';
    card.classList.remove('expanded');
    const btn = card.querySelector('.mon-btn-expand');
    if (btn) btn.textContent = '▾ Show details';
  } else {
    details.style.display = '';
    card.classList.add('expanded');
    const btn = card.querySelector('.mon-btn-expand');
    if (btn) btn.textContent = '▴ Hide details';
  }
}
window.toggleMonitoringCard = toggleMonitoringCard;

async function monitoringCheckNow() {
  const btn = document.getElementById('mon-check-now-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⚡ Checking…'; }
  try {
    await fetch('/api/monitoring/check-now', { method: 'POST' });
    setTimeout(() => refreshDashboardSchedules(), 1500);
  } catch (err) {
    alert('Check now failed: ' + err.message);
  } finally {
    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Check now'; }
    }, 3000);
  }
}
window.monitoringCheckNow = monitoringCheckNow;

async function monitoringStop() {
  if (!confirm('End monitoring now? Any still-pending leads will be stamped Closed - Not Connected.')) return;
  try {
    const res = await fetch('/api/monitoring/stop', { method: 'POST' }).then((r) => r.json());
    if (res.ok) {
      alert(`Monitoring ended. ${res.stampedCount || 0} lead(s) stamped Closed - Not Connected.`);
      refreshDashboardSchedules();
    } else {
      alert('Stop failed: ' + (res.error || 'unknown'));
    }
  } catch (err) {
    alert('Stop failed: ' + err.message);
  }
}
window.monitoringStop = monitoringStop;

// "Run now" on a schedule: post its config to /api/campaign/start. Server
// queues it if a campaign is already running, otherwise starts immediately.
// Schedule itself stays put (next cron tick will fire it again). Use Delete
// if you want it gone.
async function queueScheduleNow(id) {
  if (!id) return;
  try {
    const all = await fetch('/api/schedules').then((r) => r.json());
    const sched = Array.isArray(all) ? all.find((s) => s.id === id) : null;
    if (!sched) { alert('Schedule not found.'); return; }
    const r = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileIds: sched.profileIds,
        sheetUrl: sched.sheetUrl,
        templates: sched.templates || {},
        dailyLimit: sched.dailyLimit,
        mode: sched.mode,
        delayMin: sched.delayMin,
        delayMax: sched.delayMax,
        name: sched.name,
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) { alert('Failed: ' + (data.error || r.status)); return; }
    alert(data.queued ? (data.message || 'Added to queue.') : 'Started immediately.');
    refreshDashboard();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}
window.queueScheduleNow = queueScheduleNow;

function dashboardNameButton(name, rowKind, rowKey) {
  const trimmed = (name || '').trim();
  const cls = trimmed ? 'campaign-row-name-text' : 'campaign-row-name-text is-empty';
  const display = trimmed || 'Add name';
  return `<button type="button" class="${cls}" data-row-kind="${rowKind}" data-row-key="${rowKey}" data-row-value="${escHtml(trimmed)}">${escHtml(display)}</button>`;
}

async function refreshActiveCampaign() {
  const list = document.getElementById('active-campaign-list');
  if (!list) return;
  try {
    const status = await fetch('/api/campaign/status').then((r) => r.json());
    const isActive = status && (status.running || status.paused);
    if (!isActive) {
      // Surface a saved draft name so the operator can see what they staged in
      // the wizard before clicking Start. Cleared via the row's × button.
      let draftName = '';
      try {
        const r = await fetch('/api/draft-name');
        if (r.ok) draftName = (await r.json())?.name || '';
      } catch {}
      if (draftName) {
        list.innerHTML = `
          <div class="campaign-row campaign-row--with-edit" data-campaign-id="draft" data-state="draft">
            <div class="campaign-row-name">${dashboardNameButton(draftName, 'draft', 'draft')}</div>
            <span class="campaign-row-type">Draft</span>
            <span class="campaign-row-progress">Not started</span>
            <span class="campaign-row-status is-paused">Draft</span>
            <div class="campaign-row-actions">
              <button type="button" class="campaign-row-edit" onclick="goCreateCampaign()" title="Open the campaign page">Edit</button>
              <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="clearDraftName()" title="Discard draft" aria-label="Discard draft">×</button>
            </div>
          </div>
        `;
      } else {
        list.innerHTML = '<p class="empty-state">No active campaigns.</p>';
      }
      return;
    }
    const total = Number(status.totalTargets) || 0;
    const done = Number(status.totalProcessed) || 0;
    const left = Math.max(0, total - done);
    // Three-state label matching the campaign module's two-flag pause model:
    // _pauseRequested flips immediately on click; _paused only flips once the
    // loop boundary acknowledges. Showing "Pausing…" while the gap closes
    // tells the operator the click was received without lying about state.
    let statusLabel, statusClass;
    if (status.paused) {
      statusLabel = 'Paused';
      statusClass = 'is-paused';
    } else if (status.pauseRequested) {
      statusLabel = 'Pausing…';
      statusClass = 'is-paused';
    } else {
      statusLabel = 'Running';
      statusClass = 'is-running';
    }
    const progress = total > 0 ? `${done} / ${total} · ${left} left` : `${done} processed`;
    list.innerHTML = `
      <div class="campaign-row campaign-row--with-edit" data-campaign-id="active" data-state="active">
        <div class="campaign-row-name">${dashboardNameButton(status.name, 'active', 'active')}</div>
        <span class="campaign-row-type">${escHtml(dashboardModeLabel(status.mode))}</span>
        <span class="campaign-row-progress">${escHtml(progress)}</span>
        <span class="campaign-row-status ${statusClass}">${statusLabel}</span>
        <button type="button" class="campaign-row-edit" onclick="goCreateCampaign()" title="Open the campaign page">Edit</button>
      </div>
    `;
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load active campaign.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

// v2.11.5: collapse + search for the past-campaigns list.
//   - Default state: show 3 newest. Toggle reveals all via "Show N more"
//     where N is a live count of remaining rows.
//   - Search box matches across name, mode label, and the formatted date
//     string. While the search query is non-empty, ALL matches render
//     (the 3-row cap doesn't apply) and the toggle hides.
//   - State is module-scoped (resets on page reload) — pastExpanded
//     deliberately doesn't persist; fresh dashboard load → 3 newest.
const PAST_COLLAPSED_LIMIT = 3;
const UNDO_WINDOW_MS = 5000;
let pastExpanded = false;
let pastSearchQuery = '';
// v2.11.7: cache of the most-recently rendered filtered+sorted history so
// the modal click-handler can resolve idx → entry without re-fetching.
let pastCampaignsCache = [];
// v2.11.9: manage-mode gate. Checkboxes, per-row X buttons, and the bulk
// action bar are all hidden until the operator opts in via the trash-icon
// toggle in the past-section header. Exiting clears selection.
let pastManageMode = false;
// v2.11.8: bulk-select state for the past list. Stores history.json indexes
// (not array positions) so multi-delete addresses the on-disk record.
let pastSelectedIdxs = new Set();
// v2.11.8: queue of indexes pending deletion. While the timer is alive the
// rows are hidden client-side but the server hasn't been hit yet — Undo
// cancels the timer and restores. Timer commit fires the batch DELETE.
let pastPendingDeletes = [];
let pastPendingTimer = null;


// ─── v2.11.8: per-row delete + multi-select bulk + undo flow ──────────────
//
// Indexes throughout this section are history.json indexes (not array
// positions in the sorted/filtered view). The server endpoints all address
// the on-disk array, so handing the same idx through every layer keeps the
// model consistent.
//
// Lifecycle:
//   click X (single)        → singleDeletePast(idx)        → queue + start timer
//   click "Delete N"        → bulkDeletePastSelected()     → queue + start timer
//   click Undo              → undoPendingDeletes()         → cancel timer + restore
//   timer fires             → commitPendingDeletes()       → POST /api/history/delete-batch
//
// While the timer is alive the rows are hidden client-side via
// pastPendingDeletes; the server hasn't been touched yet, so closing
// the app within the 5s window leaves history.json intact (data-safe).

function onPastRowCheckboxChange(event, idx) {
  event.stopPropagation();
  if (event.target.checked) {
    pastSelectedIdxs.add(idx);
  } else {
    pastSelectedIdxs.delete(idx);
  }
  renderPastBulkBar();
}


function renderPastBulkBar() {
  const bar = document.getElementById('past-bulk-bar');
  const countEl = document.getElementById('past-bulk-count');
  const btn = document.getElementById('past-bulk-delete-btn');
  if (!bar || !countEl || !btn) return;
  const n = pastSelectedIdxs.size;
  // v2.11.9: bar is gated on manage-mode AND selection ≥ 1. Without
  // manage-mode there are no checkboxes to drive selection anyway, so
  // this is mostly defensive — keeps the bar invisible if pastSelectedIdxs
  // ever lingers from a previous session.
  if (!pastManageMode || n === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  countEl.textContent = `${n} selected`;
  btn.textContent = `Delete ${n}`;
}


function singleDeletePast(idx) {
  // Drop from selection if it was selected (so the bulk bar doesn't keep
  // counting an idx that's already in the pending-delete queue).
  pastSelectedIdxs.delete(idx);
  enqueuePendingDeletes([idx], 'Campaign deleted.');
}


function enqueuePendingDeletes(newIdxs, baseLabel) {
  // Merge with anything already queued — dedupe.
  const merged = new Set([...pastPendingDeletes, ...newIdxs]);
  pastPendingDeletes = [...merged];

  // Reset the timer on every enqueue so the operator gets a fresh 5s
  // after the most recent click (regardless of what was queued before).
  if (pastPendingTimer) {
    clearTimeout(pastPendingTimer);
    pastPendingTimer = null;
  }

  // Surface the toast with the latest count (independent of baseLabel —
  // if you queued 1, then queued 2 more, label should reflect total).
  const total = pastPendingDeletes.length;
  const message = total === 1 ? 'Campaign deleted.' : `${total} campaigns deleted.`;
  showUndoToast(message);

  pastPendingTimer = setTimeout(commitPendingDeletes, UNDO_WINDOW_MS);

  // Re-render so the queued rows disappear immediately.
  refreshPastCampaigns();
  // baseLabel parameter retained for future per-batch labelling; merged
  // count above replaces it for now.
  void baseLabel;
}

function undoPendingDeletes() {
  if (pastPendingTimer) {
    clearTimeout(pastPendingTimer);
    pastPendingTimer = null;
  }
  pastPendingDeletes = [];
  hideUndoToast();
  refreshPastCampaigns();
}

async function commitPendingDeletes() {
  const idxs = [...pastPendingDeletes];
  pastPendingDeletes = [];
  pastPendingTimer = null;
  hideUndoToast();
  if (idxs.length === 0) return;
  try {
    const res = await fetch('/api/history/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexes: idxs }),
    });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);
  } catch (err) {
    // Server rejected — surface a brief failure toast and refresh from
    // the source of truth. The deleted rows will reappear because the
    // server still has them.
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(`Delete failed: ${err.message}`, 5000);
    }
  } finally {
    refreshPastCampaigns();
  }
}

function showUndoToast(message) {
  const toast = document.getElementById('undo-toast');
  const msg = document.getElementById('undo-toast-message');
  if (!toast || !msg) return;
  msg.textContent = message;
  toast.hidden = false;
  toast.classList.add('visible');
}

function hideUndoToast() {
  const toast = document.getElementById('undo-toast');
  if (!toast) return;
  toast.classList.remove('visible');
  toast.hidden = true;
}

// v2.11.7: past-campaign details modal. Reads from pastCampaignsCache so the
// click handler doesn't re-hit /api/history.
let pastCampaignModalEntry = null;

function openPastCampaignModal(idx) {
  // Inline name-edit clicks bubble up to the row; if an inline-edit input
  // is currently focused we don't want a stray click to also open the modal.
  if (document.activeElement && document.activeElement.classList.contains('campaign-row-name-input')) return;
  const entry = pastCampaignsCache.find(e => e.idx === idx);
  if (!entry) return;
  pastCampaignModalEntry = entry;

  const c = entry.c;
  const dateStr = dashboardFormatDate(c.startedAt || c.date) || '—';
  const reason = c.endReason || 'completed';
  const reasonLabel = reason === 'stopped' ? 'Stopped'
                    : reason === 'errored' ? 'Errored'
                    : 'Completed';
  const reasonClass = reason === 'stopped' ? 'is-stopped'
                    : reason === 'errored' ? 'is-errored'
                    : 'is-done';
  const profiles = Array.isArray(c.profiles) ? c.profiles : [];
  const total = c.totalProcessed != null ? c.totalProcessed : (c.successCount || 0);
  const success = c.successCount != null ? c.successCount : 0;
  const errors = c.errorCount != null ? c.errorCount : 0;
  const durationStr = c.duration != null ? formatDurationSeconds(c.duration) : '—';
  const hasSettings = !!(c.settings && c.settings.profileIds);

  const rowsHtml = [
    ['Name', escHtml(c.name || '— unnamed —')],
    ['Mode', escHtml(dashboardModeLabel(c.mode))],
    ['Started', escHtml(dateStr)],
    ['Duration', escHtml(durationStr)],
    ['End reason', `<span class="campaign-row-status ${reasonClass}">${reasonLabel}</span>`],
    ['Accounts used', profiles.length === 0 ? '—' : `<span>${profiles.map(p => escHtml(p)).join(', ')}</span>`],
    ['Successes', escHtml(String(success))],
    ['Total processed', escHtml(String(total))],
    ['Errors', escHtml(String(errors))],
  ];

  const body = document.getElementById('past-campaign-modal-body');
  if (body) {
    body.innerHTML = rowsHtml.map(([k, v]) =>
      `<div class="past-detail-row"><span class="past-detail-key">${escHtml(k)}</span><span class="past-detail-val">${v}</span></div>`
    ).join('');
  }

  // Disable Re-run button if no settings snapshot (older entries from before
  // v2.11.7 won't have it).
  const rerunBtn = document.getElementById('past-campaign-rerun-btn');
  if (rerunBtn) {
    rerunBtn.disabled = !hasSettings;
    rerunBtn.title = hasSettings ? '' : 'This campaign predates settings-snapshot persistence';
  }

  document.getElementById('past-campaign-modal').classList.remove('hidden');
}

function closePastCampaignModal() {
  document.getElementById('past-campaign-modal').classList.add('hidden');
  pastCampaignModalEntry = null;
}

// Pre-fill the wizard from the saved settings snapshot. Mode + accounts +
// templates + sheet URL + delays are restored; the operator confirms (or
// edits) before clicking Launch.
function rerunPastCampaign() {
  if (!pastCampaignModalEntry) return;
  const c = pastCampaignModalEntry.c;
  const s = c.settings;
  if (!s) return;

  // Build a preset-config-shaped object so we can reuse applyPresetConfig.
  // v2.14.x: include CC+IC fields (primaryName / primaryUrl / primaryIntroBody
  // / introTitle) and the concurrency knob so Re-run truly carries forward
  // every operator-visible setting from the prior run. They live inside
  // s.templates (the campaign loop reads them from there) and as a top-level
  // s.concurrency — operator screenshot 2026-05-16 showed the primary person
  // name + concurrency missing on Re-run.
  const config = {
    mode: c.mode,
    sheetUrl: s.sheetUrl || '',
    dailyLimit: s.dailyLimit ?? 50,
    delayMin: s.delayMin ?? 15,
    delayMax: s.delayMax ?? 45,
    linkedinColumn: s.linkedinColumn || '',
    messageOpenProfiles: !!s.messageOpenProfiles,
    addNote: !!(s.templates && s.templates.connectionNote),
    templates: s.templates || {},
    profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
    concurrency: s.concurrency ?? 1,
    senderFirstNames: s.senderFirstNames || {},
  };

  closePastCampaignModal();
  goCreateCampaign();          // navigate to wizard at #/new
  // Defer applyPresetConfig until the wizard view is mounted.
  setTimeout(() => {
    if (typeof applyPresetConfig === 'function') applyPresetConfig(config);
    // Surface the campaign name (with "(re-run)" suffix) so the operator can
    // tweak. The wizard's #campaign-name-input drives the new run.
    const nameInput = document.getElementById('campaign-name-input');
    if (nameInput) {
      const base = (c.name || '').trim();
      nameInput.value = base ? `${base} (re-run)` : '';
    }
    // Friendly toast — operator should at least eyeball before launching.
    if (typeof showCampaignToast === 'function') {
      showCampaignToast('Wizard pre-filled from past run — review before launching.');
    }
  }, 50);
}

// Format seconds → "1h 23m" / "12m 04s" / "45s". Used by the past modal.
function formatDurationSeconds(s) {
  const sec = Math.max(0, Math.round(Number(s) || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, '0')}m`;
}

async function refreshPastCampaigns() {
  const list = document.getElementById('past-campaign-list');
  const toggleRow = document.getElementById('past-toggle-row');
  const toggleBtn = document.getElementById('past-toggle-btn');
  if (!list) return;
  try {
    const data = await fetch('/api/history').then((r) => r.json());
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<p class="empty-state">No past campaigns yet.</p>';
      if (toggleRow) toggleRow.hidden = true;
      return;
    }
    // Preserve the on-disk index — that's what the PATCH endpoint addresses,
    // and sorting newest-first would otherwise lose the mapping.
    const indexed = data.map((c, idx) => ({ idx, c }));
    indexed.sort((a, b) => {
      const ta = new Date(a.c.startedAt || a.c.date).getTime();
      const tb = new Date(b.c.startedAt || b.c.date).getTime();
      return tb - ta;
    });

    // Search filter: matches name, mode label, or formatted date string.
    const q = pastSearchQuery;
    const filtered = q
      ? indexed.filter(({ c }) => {
          const name = (c.name || '').toLowerCase();
          const mode = (dashboardModeLabel(c.mode) || '').toLowerCase();
          const date = (dashboardFormatDate(c.startedAt || c.date) || '').toLowerCase();
          return name.includes(q) || mode.includes(q) || date.includes(q);
        })
      : indexed;

    if (filtered.length === 0) {
      list.innerHTML = `<p class="empty-state">No campaigns match "${escHtml(q)}".</p>`;
      if (toggleRow) toggleRow.hidden = true;
      return;
    }

    // v2.11.7: cache the visible entries so the click-handler can pick the
    // right one without re-fetching /api/history. Click on the row body opens
    // the details modal; clicks inside the inline-edit name button bubble
    // up but the name button calls stopPropagation in its own handler.
    // v2.11.8: skip rows in pastPendingDeletes — they're queued for deletion
    // and shouldn't render until either the timer fires (server delete +
    // re-fetch) or undo restores them.
    const pendingSet = new Set(pastPendingDeletes);
    const renderable = filtered.filter(({ idx }) => !pendingSet.has(idx));
    pastCampaignsCache = renderable;

    if (renderable.length === 0) {
      // All filtered entries are queued for deletion → show empty/searching state.
      list.innerHTML = q
        ? `<p class="empty-state">No campaigns match "${escHtml(q)}".</p>`
        : '<p class="empty-state">No past campaigns yet.</p>';
      if (toggleRow) toggleRow.hidden = true;
      renderPastBulkBar();
      return;
    }

    // Split renderable into past-only and monitoring-only. The original `idx`
    // is preserved in each entry — it maps to the /api/history/:idx endpoint.
    const _renderablePast = renderable.filter(({ c }) => c.state !== 'monitoring');
    const _renderableMonitoring = renderable.filter(({ c }) => c.state === 'monitoring');

    // v2.52.0: drop the 3-row collapse. The "Show N more" toggle button
    // was removed in the dashboard rebuild (commit b4ffff0), so the slice
    // truncation was hiding rows with no way to recover them — and
    // renderDashboardAll cloning from this list meant the All tab only ever
    // saw 3 past entries no matter how many existed. The Monitoring/All
    // tabs need the full list; the dashboard search input handles "I have
    // hundreds of past campaigns" use cases instead of collapsing.
    const visible2 = _renderablePast;

    const _buildPastRowHtml = ({ idx, c }) => {
      const dateStr = dashboardFormatDate(c.startedAt || c.date) || '—';
      const subtitle = `${dashboardModeLabel(c.mode)} · ${dateStr}`;
      const processed = c.totalProcessed != null ? c.totalProcessed : (c.successCount || 0);
      const reason = c.endReason || 'completed';
      const reasonLabel = reason === 'stopped' ? 'Stopped'
                        : reason === 'errored' ? 'Errored'
                        : 'Completed';
      const reasonClass = reason === 'stopped' ? 'is-stopped'
                        : reason === 'errored' ? 'is-errored'
                        : 'is-done';
      const checked = pastSelectedIdxs.has(idx) ? 'checked' : '';
      // v2.14.x: Resume button — only on stopped entries that DIDN'T pick
      // "Stop everything" (fullStop flag set by the CC+IC stop-choice
      // modal). Full-halt stops are semantically "I'm done with this
      // campaign" — no Resume offered. Opens a choice modal asking whether
      // to resume with identical settings (instant) or pre-fill the wizard
      // for tweaks. Completed campaigns are NOT resumable (they hit their
      // target — operator re-runs as a fresh campaign via the existing
      // details-modal "Re-run" CTA).
      const restartBtn = (reason === 'stopped' && !c.fullStop)
        ? `<button type="button" class="campaign-row-edit campaign-row-resume" onclick="event.stopPropagation(); openResumeChoice(${idx})" title="Resume this campaign — pick up where it stopped">Resume</button>`
        : '';
      const rowState = c.state === 'monitoring' ? 'monitoring' : (c.state || 'past');
      return `
        <div class="campaign-row campaign-row-clickable campaign-row--with-edit" data-campaign-id="${escHtml(c.id || c.runId || 'past-' + idx)}" data-state="${escHtml(rowState)}" data-history-idx="${idx}" data-past-idx="${idx}" onclick="openPastCampaignModal(${idx})">
          <input type="checkbox" class="past-row-checkbox" data-past-idx="${idx}" ${checked} onclick="event.stopPropagation()" onchange="onPastRowCheckboxChange(event, ${idx})" aria-label="Select campaign" />
          <div class="campaign-row-name">${dashboardNameButton(c.name, 'past', String(idx))}</div>
          <span class="campaign-row-type">${escHtml(subtitle)}</span>
          <span class="campaign-row-progress">${escHtml(processed + ' processed')}</span>
          <span class="campaign-row-status ${reasonClass}">${reasonLabel}</span>
          ${restartBtn}
          <button type="button" class="campaign-row-edit" onclick="event.stopPropagation(); goCreateCampaign()" title="Open the campaign page">Edit</button>
          <button type="button" class="past-row-delete" aria-label="Delete campaign" onclick="event.stopPropagation(); singleDeletePast(${idx})">&times;</button>
        </div>
      `;
    };

    list.innerHTML = visible2.map(_buildPastRowHtml).join('');

    // Render monitoring entries into their own list (if the element exists).
    // v2.52.0: include the LIVE in-memory campaign when it's in monitoring
    // state. Without this, the cockpit shows "WATCHING FOR ACCEPTANCES" but
    // the Monitoring tab is empty because /api/history only contains
    // finished campaigns. Source: __cockpit is populated by pollStatus from
    // /api/campaign/status (see line ~2956), so it's already in sync.
    const monList = document.getElementById('monitoring-campaign-list');
    if (monList) {
      let liveRowHtml = '';
      if (__cockpit && __cockpit.state === 'monitoring') {
        const liveName = (__cockpit.name || '').trim() || 'Live campaign';
        const liveMode = dashboardModeLabel(__cockpit.mode);
        const liveProcessed = Number(__cockpit.totalProcessed) || 0;
        const nextCheckMs = __cockpit.nextCheckAt ? new Date(__cockpit.nextCheckAt).getTime() : NaN;
        const minsToNext = !isNaN(nextCheckMs)
          ? Math.max(0, Math.round((nextCheckMs - Date.now()) / 60000))
          : null;
        const subtitle = `${liveMode} · monitoring${minsToNext != null ? ` · next check in ${minsToNext}m` : ''}`;
        liveRowHtml = `
          <div class="campaign-row campaign-row-clickable campaign-row--with-edit" data-campaign-id="live-monitoring" data-state="monitoring" onclick="goCreateCampaign()">
            <div class="campaign-row-name"><button type="button" class="campaign-row-name-text" disabled style="cursor:default">${escHtml(liveName)}</button></div>
            <span class="campaign-row-type">${escHtml(subtitle)}</span>
            <span class="campaign-row-progress">${escHtml(liveProcessed + ' processed')}</span>
            <span class="campaign-row-status is-running">Monitoring</span>
            <button type="button" class="campaign-row-edit" onclick="event.stopPropagation(); scrollToSection('nav-status')" title="Open the Live Status section in the cockpit">Live status</button>
            <button type="button" class="campaign-row-edit" onclick="event.stopPropagation(); goCreateCampaign()" title="Open the live cockpit">View cockpit</button>
          </div>
        `;
      }
      const pastMonitoringHtml = _renderableMonitoring.map(_buildPastRowHtml).join('');
      monList.innerHTML = liveRowHtml + pastMonitoringHtml;
    }

    renderPastBulkBar();

    // Toggle visibility + label. Hidden when searching (search shows all
    // matches inherently) or when total ≤ limit (nothing to expand).
    // v2.11.8: count uses `_renderablePast` so pending-deleted rows don't
    // inflate the "Show N more" pill while they're awaiting their commit timer.
    if (toggleRow && toggleBtn) {
      const remaining = _renderablePast.length - PAST_COLLAPSED_LIMIT;
      if (q || _renderablePast.length <= PAST_COLLAPSED_LIMIT) {
        toggleRow.hidden = true;
      } else {
        toggleRow.hidden = false;
        toggleBtn.textContent = pastExpanded ? 'Show fewer' : `Show ${remaining} more`;
      }
    }
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load history.</p>';
    if (toggleRow) toggleRow.hidden = true;
  }
  // v2.52.0: the All tab is a CLONE of the past + monitoring lists. After any
  // past-list refresh, the All tab's clones are stale — explicitly re-render
  // here so bulk-delete operators don't have to tab away + back to see
  // their deletion take effect. (Repro: select rows in All tab → Delete →
  // server deletes succeed → past-campaign-list re-renders → all-campaign-list
  // keeps stale clones until next dashSetTab('all') call.)
  if (typeof renderDashboardAll === 'function') renderDashboardAll();
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

async function deletePastCampaign(idx) {
  if (!confirm('Delete this past campaign from history? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/history/' + idx, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Failed to delete: ' + (err.error || r.status));
      return;
    }
  } catch (err) {
    alert('Failed: ' + err.message);
    return;
  }
  refreshPastCampaigns();
}
window.deletePastCampaign = deletePastCampaign;

// Hydrate the wizard from a past-campaign history entry, then navigate. Pulls
// from history.json by index — entry.config carries the original start payload
// (added 2026-05). Older entries (pre-config-snapshot) only restore name + the
// few legacy fields that were stored.
async function editPastCampaign(idx) {
  try {
    const data = await fetch('/api/history').then(r => r.json());
    if (!Array.isArray(data) || !data[idx]) {
      alert('Could not find that campaign in history.');
      return;
    }
    const entry = data[idx];
    // Name → restore via the wizard's input + persist as the current draft so
    // the dashboard's draft row stays consistent.
    const name = entry.name || '';
    const nameInput = document.getElementById('campaign-name-input');
    if (nameInput) nameInput.value = name;
    try { localStorage.setItem('campaignName', name); } catch {}
    fetch('/api/draft-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    // Full restore from the snapshot config when present. Older history rows
    // without `config` only restore what little was stored at the top level.
    if (entry.config) {
      applyPresetConfig(entry.config);
    } else {
      applyPresetConfig({
        mode: entry.mode,
        dailyLimit: entry.dailyLimit,
      });
    }
    goCreateCampaign();
  } catch (err) {
    alert(`Failed to open campaign: ${err.message}`);
  }
}
window.editPastCampaign = editPastCampaign;

// Restart a past campaign: hydrate the wizard from its saved config (same
// as Edit), then nudge the operator to click Start. Doesn't auto-start —
// safer because the operator can review accounts/limits before relaunching.
async function restartPastCampaign(idx) {
  await editPastCampaign(idx);
  if (typeof showCampaignToast === 'function') {
    showCampaignToast('Campaign config restored — review and click Start Campaign to relaunch.', 6000);
  }
}
window.restartPastCampaign = restartPastCampaign;

// ─── Resume choice modal (v2.14.x) ──────────────────────────────────────
// Opens when the operator clicks Resume on a stopped campaign in the past-
// campaigns list. Two paths: instant resume with same settings, or open
// the wizard prefilled. The backend (campaign.js) seeds today's per-account
// counts from state.processed so accounts pick up where they left off.

let _resumeChoiceIdx = null;

function openResumeChoice(idx) {
  _resumeChoiceIdx = idx;
  const entry = (pastCampaignsCache || []).find(e => e.idx === idx);
  if (!entry) {
    console.warn('[resume] entry not in cache for idx', idx);
    return;
  }
  const c = entry.c;
  const hasSettings = !!(c && c.settings);
  const body = document.getElementById('resume-choice-body');
  const sameBtn = document.getElementById('resume-choice-same');

  // Build summary rows so the operator sees what they're resuming.
  const modeLabel = (typeof dashboardModeLabel === 'function' ? dashboardModeLabel(c.mode) : c.mode) || '—';
  const dateStr = (typeof dashboardFormatDate === 'function' ? dashboardFormatDate(c.startedAt || c.date) : c.date) || '—';
  const profiles = Array.isArray(c.profiles) ? c.profiles : [];
  const dailyLimit = c.settings?.dailyLimit ?? c.dailyLimit ?? '—';
  const processed = c.totalProcessed != null ? c.totalProcessed : (c.successCount || 0);

  const rows = [
    ['Name', escHtml(c.name || '(unnamed)')],
    ['Mode', escHtml(modeLabel)],
    ['Stopped at', escHtml(dateStr)],
    ['Sheet', escHtml(c.settings?.sheetUrl || '—')],
    ['Accounts', profiles.length ? escHtml(profiles.join(', ')) : '—'],
    ['Daily limit', escHtml(String(dailyLimit))],
    ['Already processed', escHtml(`${processed} lead${processed === 1 ? '' : 's'}`)],
  ];

  if (body) {
    body.innerHTML = rows.map(([k, v]) =>
      `<div class="past-detail-row"><span class="past-detail-key">${escHtml(k)}</span><span class="past-detail-val">${v}</span></div>`
    ).join('') +
    `<p style="margin-top:14px; color:var(--gray); font-size:.78rem; line-height:1.5;">
      Today's per-account counts will be preserved — accounts pick up where they left off, not from 0.
    </p>`;
  }

  // Disable "Resume same" if no settings snapshot (older entries from before
  // v2.11.7 didn't persist settings).
  if (sameBtn) {
    sameBtn.disabled = !hasSettings;
    sameBtn.title = hasSettings ? '' : 'This campaign predates settings-snapshot persistence — use "Edit settings first" to reconfigure.';
  }

  document.getElementById('resume-choice-modal').classList.remove('hidden');
}
window.openResumeChoice = openResumeChoice;

function closeResumeChoiceModal() {
  document.getElementById('resume-choice-modal').classList.add('hidden');
  _resumeChoiceIdx = null;
}
window.closeResumeChoiceModal = closeResumeChoiceModal;

// Resume now · same settings — POST directly to /api/campaign/start with
// the saved settings snapshot. Backend's campaignCounts seeder handles the
// "pick up at 22/50" piece automatically (campaign.js, look for the
// _todayPrefix block).
async function resumeWithSameSettings() {
  if (_resumeChoiceIdx == null) return;
  const entry = (pastCampaignsCache || []).find(e => e.idx === _resumeChoiceIdx);
  if (!entry || !entry.c.settings) {
    if (typeof showCampaignToast === 'function') {
      showCampaignToast('This campaign has no saved settings — use "Edit settings first" instead.', 5000);
    }
    return;
  }
  const c = entry.c;
  const s = c.settings;
  const payload = {
    profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
    sheetUrl: s.sheetUrl || '',
    templates: s.templates || {},
    dailyLimit: s.dailyLimit ?? 50,
    mode: c.mode,
    messageOpenProfiles: !!s.messageOpenProfiles,
    delayMin: s.delayMin ?? 15,
    delayMax: s.delayMax ?? 45,
    linkedinColumn: s.linkedinColumn || '',
    concurrency: s.concurrency ?? 1,
    name: c.name ? `${c.name} (resumed)` : '',
    // v2.52.0: carry forward the operator-chosen monitoring cadence so resume
    // doesn't silently fall back to the server's 60-min default. Pre-v2.52
    // history entries don't have the field — undefined here lets the server
    // apply its 60-min default just like before.
    checkIntervalMinutes: s.checkIntervalMinutes,
  };

  closeResumeChoiceModal();
  try {
    const r = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      if (typeof showCampaignToast === 'function') {
        showCampaignToast(`Resume failed: ${err || r.statusText}`, 6000);
      }
      return;
    }
    if (typeof showCampaignToast === 'function') {
      showCampaignToast('Resumed — accounts will pick up at today\'s current counts.', 4000);
    }
    // Refresh state so cockpit/runbar reflect the running campaign.
    if (typeof startPolling === 'function') startPolling();
  } catch (err) {
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(`Resume failed: ${err.message}`, 6000);
    }
  }
}
window.resumeWithSameSettings = resumeWithSameSettings;

// Edit-first path — close the choice modal and fall through to the
// existing wizard-prefill flow (rerunPastCampaign already does this for
// the past-campaign details modal).
function resumeWithEditFirst() {
  if (_resumeChoiceIdx == null) return;
  const idx = _resumeChoiceIdx;
  closeResumeChoiceModal();
  // Set the pastCampaignModalEntry so rerunPastCampaign can find it.
  const entry = (pastCampaignsCache || []).find(e => e.idx === idx);
  if (entry) {
    pastCampaignModalEntry = entry;
    rerunPastCampaign();
  }
}
window.resumeWithEditFirst = resumeWithEditFirst;

// Dashboard "+ Start new campaign" — creates a brand-new draft entry and
// opens the wizard with empty inputs. Other drafts are preserved (visible
// in the Dashboard's Drafts section), so the operator can stage multiple
// campaigns in parallel without losing any.
async function startNewCampaign() {
  // Spawn a fresh draft on the server; remember its id so saveDraftName
  // updates this specific entry rather than colliding with an existing one.
  try {
    const r = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    if (r.ok) {
      const data = await r.json();
      try { localStorage.setItem('currentDraftId', data?.draft?.id || ''); } catch {}
    }
  } catch { /* fall through; wizard still works without a draft id */ }
  try { localStorage.removeItem('campaignName'); } catch {}
  const input = document.getElementById('campaign-name-input');
  if (input) input.value = '';
  goCreateCampaign();
}
window.startNewCampaign = startNewCampaign;

// On-demand bulk Connection Status check, triggered by the wizard's
// "Bulk check connections" button. Uses the first selected account
// (selectedProfileIds[0]) and the current sheet URL. Server enforces the
// "no campaign running" guard.
// v2.14.x: in-flight bulk-check panel (Variant A). Parses campaign.logs
// for bulk-check activity and renders into the .bulk-check-live panel
// in public/index.html. Same panel is used for two scenarios:
//   (1) manual BULK CHECK CONNECTIONS button — bulkCheckNow's streaming
//       poll feeds it.
//   (2) campaign in-batch bulk-check (📡 In-batch ... 5-min cooldown
//       elapsed) — pollStatus detects the lines and feeds the same
//       renderer.
// Both paths flow through renderBulkCheckLive() so the panel looks
// identical whether the operator triggered it or the campaign did.

// Returns { matched, stamped, fetched, currentProfile, currentStep,
// profilesTotal, profilesDone, completed, lastEventMs } from the most
// recent bulk-check "session" in the logs (a chain of 📡 lines without
// a >30s gap). Returns null if no bulk-check activity found.
function parseBulkCheckFromLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  const SESSION_GAP_MS = 30000;
  // First pass: scan from the END backwards to find the latest session.
  // A "session" is a run of bulk-check-related lines without a >30s gap.
  let sessionStart = -1;
  let lastTs = 0;
  const bulkRe = /📡|Manual bulk check complete/;
  for (let i = logs.length - 1; i >= 0; i--) {
    const ts = logs[i].match(/^\[(.*?)\]/);
    if (!ts) continue;
    const t = new Date(ts[1]).getTime();
    if (isNaN(t)) continue;
    const isBulk = bulkRe.test(logs[i]);
    if (sessionStart === -1) {
      if (!isBulk) continue;
      sessionStart = i;
      lastTs = t;
      continue;
    }
    if (!isBulk) continue;
    const prevT = new Date((logs[sessionStart].match(/^\[(.*?)\]/) || [])[1]).getTime();
    if (prevT - t > SESSION_GAP_MS) break;
    sessionStart = i;
  }
  if (sessionStart === -1) return null;

  const state = {
    matched: 0, stamped: 0, fetched: 0,
    currentProfile: '', currentStep: '',
    profilesTotal: 0, profilesDone: 0,
    completed: false, lastEventMs: lastTs,
  };
  const done = new Set();

  for (let i = sessionStart; i < logs.length; i++) {
    const raw = logs[i];
    const ts = raw.match(/^\[(.*?)\]/);
    if (!ts) continue;
    const t = new Date(ts[1]).getTime();
    if (isNaN(t)) continue;
    if (t - lastTs > SESSION_GAP_MS) break;
    if (t > lastTs) lastTs = t;
    const line = raw.replace(/^\[.*?\]\s*/, '').trim();

    let m;
    if ((m = line.match(/Manual bulk Connection Status check — sweeping (\d+) account/))) {
      state.profilesTotal = parseInt(m[1], 10);
      continue;
    }
    if (line.match(/Manual bulk check complete/)) {
      state.completed = true;
      continue;
    }

    const pmatch = line.match(/^📡\s*\[([^\]]+)\]\s*(.*)$/);
    if (!pmatch) continue;
    const name = pmatch[1];
    const rest = pmatch[2];

    // Account result lines — count once per (account, session).
    let r;
    if ((r = rest.match(/Bulk check:\s*(\d+)\s*marked Connected,\s*(\d+)\s*marked Still Pending \(of\s*(\d+)\s*recent connections fetched\)/))) {
      if (!done.has(name)) {
        state.matched += parseInt(r[1], 10);
        state.stamped += parseInt(r[2], 10);
        state.fetched += parseInt(r[3], 10);
        state.profilesDone += 1;
        done.add(name);
      }
      continue;
    }
    if ((r = rest.match(/Idle bulk-check:\s*(\d+)\s*Connected,\s*(\d+)\s*Still Pending \(of\s*(\d+)\)/))) {
      if (!done.has(name)) {
        state.matched += parseInt(r[1], 10);
        state.stamped += parseInt(r[2], 10);
        state.fetched += parseInt(r[3], 10);
        state.profilesDone += 1;
        done.add(name);
      }
      continue;
    }
    if ((r = rest.match(/Check now:\s*(\d+)\s*Connected,\s*(\d+)\s*Still Pending \(of\s*(\d+)\)/))) {
      if (!done.has(name)) {
        state.matched += parseInt(r[1], 10);
        state.stamped += parseInt(r[2], 10);
        state.fetched += parseInt(r[3], 10);
        state.profilesDone += 1;
        done.add(name);
      }
      continue;
    }

    // In-flight state — most recent line wins.
    state.currentProfile = name;
    if (/Launching browser/i.test(rest))                    state.currentStep = 'launching browser…';
    else if (/Sweeping recent connections/i.test(rest))     state.currentStep = 'sweeping recent connections…';
    else if (/In-batch bulk Connection Status/i.test(rest)) state.currentStep = 'in-batch bulk check (cooldown elapsed)…';
    else if (/Idle bulk-check — briefly reopening/i.test(rest)) state.currentStep = 'idle bulk-check — reopening profile…';
    else if (/Check now — bulk check pass starting/i.test(rest)) state.currentStep = 'check now — pass starting…';
    else if (/Auto-introducing/i.test(rest))                state.currentStep = 'auto-introducing newly connected leads…';
    else state.currentStep = rest.slice(0, 100);
  }

  state.lastEventMs = lastTs;
  if (state.profilesTotal > 0 && state.profilesDone >= state.profilesTotal) {
    state.completed = true;
  }
  return state;
}

// Render the bulk-check live state into the .bulk-check-live panel. Pass
// null to hide. Idempotent — safe to call on every poll.
function renderBulkCheckLive(state) {
  const panel = document.querySelector('.bulk-check-live');
  if (!panel) return;
  // Hide if no state OR activity is older than 30s (campaign moved on).
  if (!state || (Date.now() - (state.lastEventMs || 0) > 30000 && !state.__keepAlive)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const set = (k, v) => {
    const el = panel.querySelector(`[data-bcl="${k}"]`);
    if (el) el.textContent = String(v);
  };
  set('matched', state.matched || 0);
  set('stamped', state.stamped || 0);
  set('fetched', state.fetched || 0);

  const doingTextEl = panel.querySelector('[data-bcl="doing-text"]');
  if (doingTextEl) {
    if (state.completed) {
      const total = state.profilesDone || state.profilesTotal || 0;
      doingTextEl.innerHTML = `Completed — <strong>${escHtml(String(total))}</strong> ${total === 1 ? 'account' : 'accounts'} swept`;
    } else if (state.currentProfile) {
      doingTextEl.innerHTML = `<strong>${escHtml(state.currentProfile)}</strong> · ${escHtml(state.currentStep || 'working…')}`;
    } else {
      doingTextEl.innerHTML = `<strong>—</strong> · waiting…`;
    }
  }

  const pillEl = panel.querySelector('[data-bcl="pill"]');
  const pillTextEl = panel.querySelector('[data-bcl="pill-text"]');
  if (pillEl && pillTextEl) {
    if (state.completed) {
      pillTextEl.textContent = 'DONE';
      pillEl.classList.add('bulk-check-live__pill--done');
    } else {
      const denom = state.profilesTotal > 0 ? ` · ${state.profilesDone || 0} OF ${state.profilesTotal}` : '';
      pillTextEl.textContent = `RUNNING${denom}`;
      pillEl.classList.remove('bulk-check-live__pill--done');
    }
  }

  const prog = panel.querySelector('[data-bcl="progress"]');
  if (prog) {
    const pct = state.profilesTotal > 0
      ? Math.min(100, Math.round(((state.profilesDone || 0) / state.profilesTotal) * 100))
      : (state.completed ? 100 : 0);
    prog.style.width = pct + '%';
  }
}

// v2.14.x: graphical Bulk Check result card. Replaces the long inline
// text line. Called after /api/bulk-check-now returns a final result.
// Card markup is in public/index.html (.bulk-check-summary with
// [data-bcs="..."] hooks); styles in public/css/style.css.
function renderBulkCheckSummary({ matched, stamped, fetched, profilesSweep, derivedFromSheet, failures, skippedParked }) {
  const card = document.querySelector('.bulk-check-summary');
  if (!card) return;
  const set = (key, val) => {
    const el = card.querySelector(`[data-bcs="${key}"]`);
    if (el) el.textContent = String(val);
  };
  set('matched', matched);
  set('stamped', stamped);
  set('fetched', fetched);

  // Sub-label: "across N accounts from the sheet" / "across N accounts"
  // / blank. Mirrors the per-call source hint the old text line carried.
  const sub = profilesSweep
    ? (derivedFromSheet
        ? `across ${profilesSweep} accounts from the sheet`
        : `across ${profilesSweep} ${profilesSweep === 1 ? 'account' : 'accounts'}`)
    : '';
  set('sub', sub);

  // Notes: failures (red glyph) + parked-account skips (neutral glyph).
  // Each row is "<glyph> <body>" with the glyph styled per note class.
  const notesEl = card.querySelector('[data-bcs="notes"]');
  if (notesEl) {
    const parts = [];
    if (Array.isArray(failures) && failures.length > 0) {
      const names = failures.map((p) => p.profileName || p.profileId).join(', ');
      const errs  = failures.map((p) => `${p.profileName || p.profileId}: ${p.error}`).join(' • ');
      parts.push(`<div class="note note--warn"><span class="glyph">⚠</span><span class="body"><strong>${failures.length} ${failures.length === 1 ? 'account' : 'accounts'} failed:</strong> ${escapeHtml(names)}<br><span style="opacity:0.75">${escapeHtml(errs)}</span></span></div>`);
    }
    if (Array.isArray(skippedParked) && skippedParked.length > 0) {
      const detail = skippedParked.map((s) => `${s.profileName || s.profileId} (${s.reason})`).join(', ');
      parts.push(`<div class="note"><span class="glyph">⊘</span><span class="body"><strong>${skippedParked.length} parked ${skippedParked.length === 1 ? 'account' : 'accounts'} skipped:</strong> ${escapeHtml(detail)}</span></div>`);
    }
    notesEl.innerHTML = parts.join('');
  }

  card.hidden = false;
}

async function bulkCheckNow() {
  // Two buttons exist (wizard Advanced + live status panel) and two status
  // spans share the .bulk-check-status-msg class. Update all instances.
  const btns = document.querySelectorAll('#btn-bulk-check-now, #btn-bulk-check-live');
  const statusEls = document.querySelectorAll('.bulk-check-status-msg');
  const setStatus = (txt) => { statusEls.forEach((el) => { el.textContent = txt; }); };
  const setBtnDisabled = (b) => { btns.forEach((el) => { el.disabled = b; }); };

  // v2.14.x: hide the previous result card (if any) at the start of a new
  // sweep so the operator doesn't see stale numbers while the new check
  // is running. The new in-flight panel (.bulk-check-live) takes over;
  // pollStatus also feeds it from /api/campaign/status logs for any
  // in-campaign bulk-check that wasn't manually triggered.
  const _summaryCard = document.querySelector('.bulk-check-summary');
  if (_summaryCard) _summaryCard.hidden = true;

  const sheetUrl = document.getElementById('sheet-url')?.value?.trim() || '';
  const linkedinColumn = document.getElementById('linkedin-col-select')?.value || '';
  // Pass ALL selected accounts so the sweep covers each one (subject to
  // server-side parked-account filtering). Old behaviour only sent the
  // first selected, which silently skipped the sweep entirely when the
  // first account was parked.
  const profileIds = (Array.isArray(selectedProfileIds) && selectedProfileIds.length)
    ? selectedProfileIds.slice() : [];

  if (!sheetUrl) { setStatus('Paste a sheet URL first.'); return; }

  // Show the live panel immediately with the known profile total so the
  // operator sees "RUNNING · 0 OF N" within ~100ms instead of waiting for
  // the first log line to arrive.
  if (profileIds.length) {
    renderBulkCheckLive({
      matched: 0, stamped: 0, fetched: 0,
      currentProfile: '', currentStep: 'starting…',
      profilesTotal: profileIds.length, profilesDone: 0,
      completed: false,
      lastEventMs: Date.now(),
      __keepAlive: true,
    });
  }

  setBtnDisabled(true);
  // Live log streaming: poll campaign.logs every 2s while the sweep runs and
  // mirror new lines into the status display. Same source the in-campaign
  // log panel uses, so the bulk-check shows up wherever the operator clicked
  // it (dashboard or wizard) without needing to navigate away.
  const startedAt = Date.now();
  const seenLines = new Set();
  let liveLines = [];
  const renderLive = (footer = '') => {
    const tail = liveLines.slice(-8).join('\n');
    setStatus(tail + (footer ? '\n\n' + footer : ''));
  };
  const livePoll = setInterval(async () => {
    try {
      const r = await fetch('/api/campaign/status');
      if (!r.ok) return;
      const s = await r.json();
      const logs = Array.isArray(s.logs) ? s.logs : [];
      for (const line of logs) {
        if (seenLines.has(line)) continue;
        // Only stream bulk-check-related lines (📡 / ⏭ / Bulk check / Sweep).
        if (!/📡|⏭|Bulk check|Sweep|Manual bulk/.test(line)) continue;
        const m = line.match(/^\[(.*?)\]/);
        if (m) {
          const t = new Date(m[1]).getTime();
          if (!isNaN(t) && t < startedAt) continue;
        }
        seenLines.add(line);
        liveLines.push(line.replace(/^\[.*?\]\s*/, ''));
      }
      // Feed the in-flight panel from the parsed logs. Override
      // profilesTotal with the locally-known count so the "0 OF 3" denominator
      // shows immediately (before any log line has set it from server-side).
      const parsed = parseBulkCheckFromLogs(logs);
      if (parsed) {
        if (profileIds.length && !parsed.profilesTotal) parsed.profilesTotal = profileIds.length;
        parsed.__keepAlive = true; // keep visible during the active manual sweep
        renderBulkCheckLive(parsed);
      }
    } catch { /* swallow */ }
  }, 2000);
  setStatus(profileIds.length
    ? `Launching browser + sweeping ${profileIds.length} account(s)…`
    : 'No accounts selected — checking sheet for previously-used accounts…');

  try {
    // Send the full selected array. Server now accepts profileIds (plural).
    // Falls back to deriving from the sheet's Account Used column when the
    // operator hasn't selected anyone.
    const body = { sheetUrl, linkedinColumn };
    if (profileIds.length) body.profileIds = profileIds;
    // Pull the wizard's Primary Person fields if filled — server uses them
    // to fire the auto-intro DM after the bulk-check stamps Connected.
    // Empty values mean no auto-intro happens (no behaviour change for
    // non-introduce campaigns).
    const primaryName = document.getElementById('primary-person-name')?.value?.trim() || '';
    const primaryIntroBody = document.getElementById('primary-intro-body')?.value || '';
    const primaryUrl = document.getElementById('primary-person-url')?.value?.trim() || '';
    if (primaryName && primaryIntroBody) {
      body.primaryName = primaryName;
      body.primaryIntroBody = primaryIntroBody;
      body.primaryUrl = primaryUrl;
    }
    const r = await fetch('/api/bulk-check-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const result = data.result || {};
    const perProfile = Array.isArray(data.perProfile) ? data.perProfile : [];
    const skippedParked = Array.isArray(data.skippedParked) ? data.skippedParked : [];
    const profilesSweep = data.profilesSweep || 0;
    const sourceTag = data.derivedFromSheet ? ` (across ${profilesSweep} accounts from the sheet)` : '';

    // All candidates skipped because they were parked from a recent campaign.
    if (profilesSweep === 0 && skippedParked.length > 0) {
      const list = skippedParked.map((s) => `${s.profileName || s.profileId} (${s.reason})`).join(', ');
      setStatus(`Skipped ${skippedParked.length} parked account(s) — none left to sweep: ${list}`);
      return;
    }
    const matched = result.matched || 0;
    const stamped = result.stamped || 0;
    const fetched = result.fetched || 0;
    // Aggregate fetched=0 = nothing happened. Surface per-profile errors so
    // the operator sees "session-expired" / "no-endpoint-ok" / etc. instead
    // of the misleading "0 of 0 connections fetched" success line.
    const failures = perProfile.filter((p) => p && p.error);
    if (fetched === 0 && failures.length > 0) {
      const summary = failures.map((p) => {
        const who = p.profileName || p.profileId || 'profile';
        return `${who}: ${p.error}`;
      }).join('  •  ');
      setStatus(`Sweep failed on ${failures.length} of ${profilesSweep} account(s) — ${summary}`);
    } else if (result.error) {
      setStatus(`Sweep error: ${result.error}`);
    } else {
      // v2.14.x: render the graphical summary card instead of the long
      // single-line text. Clear the inline streaming text so we don't
      // show both. The card is a sibling div with [data-bcs="..."]
      // hooks for the three stat numbers + sub label + notes list.
      renderBulkCheckSummary({
        matched, stamped, fetched,
        profilesSweep,
        derivedFromSheet: !!data.derivedFromSheet,
        failures,
        skippedParked,
      });
      // Hide the in-flight live panel — the summary card takes over.
      const _livePanel = document.querySelector('.bulk-check-live');
      if (_livePanel) _livePanel.hidden = true;
      setStatus('');
      if (typeof showCampaignToast === 'function') {
        const msg = `${matched} marked Connected, ${stamped} marked Still Pending (of ${fetched} recent connections fetched)${sourceTag}`;
        showCampaignToast(`Bulk check: ${msg}`, 6000);
      }
    }
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  } finally {
    clearInterval(livePoll);
    setBtnDisabled(false);
  }
}
window.bulkCheckNow = bulkCheckNow;

// Inline-edit a campaign name. Delegated click → input swap → save on Enter
// or blur, cancel on Escape. Save hits POST /api/campaign/name for active or
// PATCH /api/history/:idx/name for past, then re-renders the section.
async function saveCampaignName(kind, key, value) {
  let url, method;
  if (kind === 'active') {
    url = '/api/campaign/name';
    method = 'POST';
  } else if (kind === 'draft') {
    // Draft row uses the persistent draft-name file. Empty string clears it.
    url = '/api/draft-name';
    method = 'POST';
  } else {
    url = `/api/history/${encodeURIComponent(key)}/name`;
    method = 'PATCH';
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }),
  });
  if (!res.ok) throw new Error(`Rename failed (${res.status})`);
  // Keep the wizard input + localStorage in sync so a follow-up wizard visit
  // shows the renamed draft, not the old value.
  if (kind === 'draft') {
    try { localStorage.setItem('campaignName', value); } catch {}
    const input = document.getElementById('campaign-name-input');
    if (input) input.value = value;
  }
  return res.json();
}

function enterInlineEditCampaignName(btn) {
  if (btn.dataset.editing === '1') return;
  btn.dataset.editing = '1';
  const kind = btn.dataset.rowKind;
  const key = btn.dataset.rowKey;
  const original = btn.dataset.rowValue || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'campaign-row-name-input';
  input.placeholder = 'Name this campaign';
  input.maxLength = 120;
  btn.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const restore = (newValue) => {
    if (settled) return;
    settled = true;
    // Re-render the section so the row reflects whatever the server now holds.
    if (kind === 'active') refreshActiveCampaign();
    else refreshPastCampaigns();
    void newValue;
  };

  const commit = async () => {
    if (settled) return;
    const next = input.value.trim();
    if (next === original) { restore(original); return; }
    try {
      await saveCampaignName(kind, key, next);
      restore(next);
    } catch (err) {
      input.classList.add('save-failed');
      input.title = err.message || 'Save failed';
      // Keep the input open so the operator can retry; don't settle.
    }
  };

  const cancel = () => restore(original);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { commit(); });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.campaign-row-name-text');
  if (btn) enterInlineEditCampaignName(btn);
});

window.addEventListener('hashchange', applyRoute);
document.addEventListener('DOMContentLoaded', applyRoute);
if (document.readyState !== 'loading') applyRoute();

window.goCreateCampaign = goCreateCampaign;
window.goDashboard = goDashboard;

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Name — top-of-wizard text input. Source-of-truth precedence on
// every wizard view: running campaign's live name → backend draft-name (set
// by Save Name) → localStorage (in-progress draft so half-typed names survive
// Cmd+R).
// ─────────────────────────────────────────────────────────────────────────────
async function syncCampaignNameInput() {
  const input = document.getElementById('campaign-name-input');
  if (!input) return;
  let value = '';
  let isRunning = false;
  let draftId = '';
  try { draftId = localStorage.getItem('currentDraftId') || ''; } catch {}
  // Active draft (multi-draft store) wins — that's the entry the wizard
  // is currently editing. Fall back to the running campaign name (only
  // when no campaign is running, so we don't make the wizard look like an
  // edit form for the active run), then to legacy single-draft, then to
  // localStorage.
  if (draftId) {
    try {
      const r = await fetch('/api/drafts/' + encodeURIComponent(draftId));
      if (r.ok) value = (await r.json())?.name || '';
      else if (r.status === 404) {
        // Draft was deleted from the dashboard while wizard was open.
        try { localStorage.removeItem('currentDraftId'); } catch {}
      }
    } catch {}
  }
  try {
    const sRes = await fetch('/api/campaign/status');
    if (sRes.ok) {
      const status = await sRes.json();
      isRunning = !!(status.running || status.paused);
      if (!value && !isRunning && status.name) value = status.name;
    }
  } catch {}
  if (!value) {
    try {
      const r = await fetch('/api/draft-name');
      if (r.ok) value = (await r.json())?.name || '';
    } catch {}
  }
  if (!value && !isRunning) {
    try { value = localStorage.getItem('campaignName') || ''; } catch {}
  }
  input.value = value;
}

async function initCampaignNameInput() {
  const input = document.getElementById('campaign-name-input');
  if (!input) return;
  await syncCampaignNameInput();
  input.addEventListener('input', () => {
    try { localStorage.setItem('campaignName', input.value); } catch {}
  });
}
document.addEventListener('DOMContentLoaded', initCampaignNameInput);
if (document.readyState !== 'loading') initCampaignNameInput();
window.syncCampaignNameInput = syncCampaignNameInput;

async function saveDraftName() {
  const input = document.getElementById('campaign-name-input');
  const btn = document.getElementById('btn-save-name');
  if (!input) return;
  const name = (input.value || '').trim();
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // Always save to the draft slot. ALSO rename the running campaign IFF
    // there isn't one — i.e., we're staging a single campaign about to
    // launch. When a campaign IS running, this wizard is for a queued
    // build; renaming the active campaign here would clobber it (which
    // is exactly what was happening before this guard).
    let isRunning = false;
    try {
      const sRes = await fetch('/api/campaign/status');
      if (sRes.ok) {
        const status = await sRes.json();
        isRunning = !!(status.running || status.paused);
      }
    } catch {}

    // Persist to the new multi-draft store under the wizard's current
    // draft id (set by startNewCampaign or editDraft). If somehow there
    // isn't one (legacy state), spin one up so this Save sticks.
    let draftId = '';
    try { draftId = localStorage.getItem('currentDraftId') || ''; } catch {}
    if (draftId) {
      try {
        const r = await fetch('/api/drafts/' + encodeURIComponent(draftId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (r.status === 404) {
          // Draft was deleted out from under us — recreate.
          draftId = '';
        }
      } catch { /* fall through to legacy save */ }
    }
    if (!draftId) {
      try {
        const r = await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (r.ok) {
          const data = await r.json();
          try { localStorage.setItem('currentDraftId', data?.draft?.id || ''); } catch {}
        }
      } catch {}
    }
    // Keep legacy single-draft endpoint in sync so syncCampaignNameInput's
    // back-compat fallback still picks up the right name.
    await fetch('/api/draft-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!isRunning) {
      await fetch('/api/campaign/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    }
    const toast = name
      ? (isRunning ? `Saved as draft (queued campaign): ${name}` : `Saved name: ${name}`)
      : 'Cleared draft name';
    showCampaignToast(toast, 3000);
  } catch (err) {
    showCampaignToast(`Failed to save name: ${err.message}`, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || 'Save Name'; }
  }
}
window.saveDraftName = saveDraftName;

async function clearDraftName() {
  try {
    await fetch('/api/draft-name', { method: 'DELETE' });
    const input = document.getElementById('campaign-name-input');
    if (input) input.value = '';
    try { localStorage.removeItem('campaignName'); } catch {}
    if (typeof refreshDashboard === 'function') refreshDashboard();
  } catch (err) {
    showCampaignToast(`Failed to clear draft: ${err.message}`, 5000);
  }
}
window.clearDraftName = clearDraftName;

// ─────────────────────────────────────────────────────────────────────────────
// Sheet tab URL — warn when the operator pastes a URL with no #gid= so the
// campaign doesn't silently pull from the first tab. Non-blocking.
// ─────────────────────────────────────────────────────────────────────────────
function updateSheetTabHint() {
  const input = document.getElementById('sheet-url');
  const hint = document.getElementById('sheet-tab-hint');
  if (!input || !hint) return;
  const v = input.value.trim();
  if (!v) {
    hint.classList.remove('is-warning');
    hint.innerHTML = 'Open the specific tab inside the sheet, then copy the URL from your browser address bar — it should include <code>#gid=…</code>.';
    return;
  }
  // Match #gid=, ?gid=, or &gid= — same shapes extractSheetGid recognises.
  const hasGid = /[#&?]gid=\d+/.test(v);
  if (hasGid) {
    hint.classList.remove('is-warning');
    hint.innerHTML = 'Specific tab detected — campaign will pull from this tab.';
  } else {
    hint.classList.add('is-warning');
    hint.innerHTML = 'No tab selector found — open the specific tab and re-copy the URL, otherwise the campaign reads the first tab in the sheet.';
  }
}
document.addEventListener('DOMContentLoaded', updateSheetTabHint);
if (document.readyState !== 'loading') updateSheetTabHint();
window.updateSheetTabHint = updateSheetTabHint;

// ---------------------------------------------------------------------------
// Dev tools — Preview intro DM (no LinkedIn interaction, pure text preview)
// ---------------------------------------------------------------------------
async function devPreviewIntroDM() {
  const sheetUrl   = (document.getElementById('sheet-url')?.value         || '').trim();
  // Intro DM body lives in Section 5 Message Templates textarea
  const introBody  = (document.getElementById('primary-intro-body')?.value || '').trim();
  const primaryName = (document.getElementById('primary-person-name')?.value || '').trim();
  const primaryUrl  = (document.getElementById('primary-person-url')?.value  || '').trim();
  // Group conversation title input (Section IV, CC+IC mode)
  const introTitle  = (document.getElementById('intro-title')?.value         || '').trim();

  if (!sheetUrl)    { alert('Configure the Google Sheet URL in the wizard first (Section II).'); return; }
  if (!introBody)   { alert('The intro DM body is empty — fill in the message body in Section V (Message Templates) first.'); return; }
  if (!primaryName) { alert('Fill in Primary Person Name in Section IV (Campaign Settings) first.'); return; }

  try {
    const res = await fetch('/api/preview-intro-dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl, introBody, primaryName, primaryUrl, introTitle }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert(`Preview failed:\n\n${err.error || res.statusText}`);
      return;
    }

    const data = await res.json();

    // Populate and show the modal
    document.getElementById('preview-intro-sample').textContent =
      `Sample lead from row 1: ${data.sampleLead.firstName || '(no first name)'} ${data.sampleLead.lastName || ''} · ${data.sampleLead.company || '—'}`.trim();
    document.getElementById('preview-intro-recipients').textContent =
      `${data.sampleLead.firstName || '(lead)'} ${data.sampleLead.lastName || ''} · ${data.primaryName}`.trim();
    document.getElementById('preview-intro-title').textContent = data.resolvedTitle;
    document.getElementById('preview-intro-body').textContent  = data.resolvedBody;

    const warnEl = document.getElementById('preview-intro-warnings');
    if (data.unresolvedPlaceholders && data.unresolvedPlaceholders.length > 0) {
      warnEl.textContent = `⚠ Unresolved placeholders: ${data.unresolvedPlaceholders.join(', ')} — these will be stripped from the actual message.`;
      warnEl.style.display = '';
    } else {
      warnEl.style.display = 'none';
    }

    document.getElementById('preview-intro-modal').classList.remove('hidden');
  } catch (e) {
    alert(`Network error:\n\n${e.message}`);
  }
}
window.devPreviewIntroDM = devPreviewIntroDM;

function closePreviewIntroModal() {
  const m = document.getElementById('preview-intro-modal');
  if (m) m.classList.add('hidden');
}
window.closePreviewIntroModal = closePreviewIntroModal;

// ──────────────────────────────────────────────────────────────────────
// Dashboard tabbed layout — v2.51
// Spec: docs/superpowers/specs/2026-05-18-dashboard-tabbed-design.md
// All exported as window.dashXxx so onclick attributes in index.html find them.
// ──────────────────────────────────────────────────────────────────────

import {
  pickDefaultTab as _dashPickDefaultTab,
  computeCrossTabQualifier as _dashComputeQualifier,
  toggleInSelection as _dashToggleSel,
} from './dashboard-state.js';

const DASH_TABS = ['active', 'monitoring', 'queued', 'schedules', 'drafts', 'past', 'all'];
const DASH_PERSIST_KEY = 'ortus.dashboard.activeTab';

let _dashActiveTab = '';        // current tab name
let _dashSelection = new Set(); // selected campaign ids (across tabs)
let _dashSearch = '';           // current search query (per active tab)

/** Read campaign ids per tab from the rendered DOM. Source of truth: the
 *  list containers populated by the existing refresh* functions. */
function dashGetIdsByTab() {
  const out = {};
  for (const tab of DASH_TABS) {
    if (tab === 'all') continue; // special-cased below
    const list = document.getElementById(`${tab}-campaign-list`);
    if (!list) { out[tab] = []; continue; }
    out[tab] = Array.from(list.querySelectorAll('.campaign-row[data-campaign-id]'))
      .map((r) => r.dataset.campaignId);
  }
  // 'all' is the union of every other tab — Set dedupes if the same id
  // appears in two tabs (shouldn't, but defensive).
  const allIds = new Set();
  for (const tab of DASH_TABS) {
    if (tab === 'all') continue;
    for (const id of (out[tab] || [])) allIds.add(id);
  }
  out.all = Array.from(allIds);
  return out;
}

/** Update the count badges on the tab bar. */
function dashUpdateCounts() {
  const ids = dashGetIdsByTab();
  for (const tab of DASH_TABS) {
    const el = document.querySelector(`.dash-tab-ct[data-ct="${tab}"]`);
    if (el) el.textContent = (ids[tab] || []).length;
  }
}

/** Show the panel for `tab`, hide all others. Updates aria-selected. */
function dashShowPanel(tab) {
  for (const t of DASH_TABS) {
    const panel = document.getElementById(`dash-panel-${t}`);
    const btn = document.querySelector(`.dash-tab[data-tab="${t}"]`);
    if (panel) {
      panel.hidden = (t !== tab);
      panel.classList.toggle('on', t === tab);
    }
    if (btn) {
      btn.classList.toggle('on', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
  }
}

/** Switch to `tab`. Clears search, re-renders selection state for the new tab. */
function dashSetTab(tab) {
  if (!DASH_TABS.includes(tab)) return;
  _dashActiveTab = tab;
  _dashSearch = '';
  const search = document.getElementById('dash-search');
  if (search) search.value = '';
  if (tab === 'all') renderDashboardAll();
  dashShowPanel(tab);
  dashApplySearch();
  dashRenderSelection();
  dashRenderBulkStrip();
  try { localStorage.setItem(DASH_PERSIST_KEY, tab); } catch {}
}

/** Apply the current search filter to the rows in the active panel.
 *  Rows that don't match get display:none. A "no matches" overlay is added
 *  when the filter would leave zero visible rows. */
function dashApplySearch() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  if (!panel) return;
  const q = (_dashSearch || '').toLowerCase().trim();
  const rows = panel.querySelectorAll('.campaign-row[data-campaign-id]');
  let visibleCount = 0;
  rows.forEach((row) => {
    if (!q) {
      row.style.display = '';
      visibleCount++;
      return;
    }
    const text = row.textContent.toLowerCase();
    const match = text.includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  // Toggle a "no matches" overlay
  let overlay = panel.querySelector('.dash-search-empty');
  if (q && visibleCount === 0 && rows.length > 0) {
    if (!overlay) {
      overlay = document.createElement('p');
      overlay.className = 'empty-state dash-search-empty';
      overlay.textContent = 'No matches. Try a different search term.';
      const list = panel.querySelector('.campaign-list');
      if (list) list.appendChild(overlay);
    }
  } else if (overlay) {
    overlay.remove();
  }
}

/** Apply the selection state (gold tint + checkbox state) to every visible row. */
function dashRenderSelection() {
  // For every campaign-row in every panel, ensure the checkbox is present and
  // reflects the current selection state.
  const allRows = document.querySelectorAll('.dash-panel .campaign-row[data-campaign-id]');
  allRows.forEach((row) => {
    const id = row.dataset.campaignId;
    if (!id) return;
    let check = row.querySelector(':scope > .dash-row-check');
    if (!check) {
      check = document.createElement('span');
      check.className = 'dash-row-check';
      check.dataset.id = id;
      check.setAttribute('role', 'checkbox');
      check.tabIndex = 0;
      row.prepend(check);
    }
    const sel = _dashSelection.has(id);
    check.classList.toggle('on', sel);
    row.classList.toggle('dash-row-sel', sel);
    check.setAttribute('aria-checked', sel ? 'true' : 'false');
  });
  // Master select-all reflects the visible-row state of the active panel
  dashRenderSelectAll();
}

/** Update the master select-all checkbox state (none / some / all). */
function dashRenderSelectAll() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  const check = document.getElementById('dash-selall-check');
  if (!panel || !check) return;
  const visible = Array.from(panel.querySelectorAll('.campaign-row[data-campaign-id]'))
    .filter((r) => r.style.display !== 'none');
  const selected = visible.filter((r) => _dashSelection.has(r.dataset.campaignId));
  check.classList.remove('on', 'some');
  if (visible.length > 0 && selected.length === visible.length) check.classList.add('on');
  else if (selected.length > 0) check.classList.add('some');
}

/** Show or hide the bulk-action strip, update count + qualifier + button visibility. */
function dashRenderBulkStrip() {
  const strip = document.getElementById('dash-bulkstrip');
  const nEl = document.getElementById('dash-bulk-n');
  const qualEl = document.getElementById('dash-bulk-qual');
  const pauseBtn = document.getElementById('dash-bulk-pause');
  if (!strip || !nEl || !qualEl || !pauseBtn) return;
  const n = _dashSelection.size;
  strip.hidden = (n === 0);
  nEl.textContent = String(n);
  const ids = dashGetIdsByTab();
  qualEl.textContent = _dashComputeQualifier(_dashSelection, _dashActiveTab, ids);
  // Show PAUSE WATCH only when at least one monitoring row is selected
  const monitoringIds = new Set(ids.monitoring || []);
  let anyMonitoringSelected = false;
  for (const id of _dashSelection) {
    if (monitoringIds.has(id)) { anyMonitoringSelected = true; break; }
  }
  pauseBtn.hidden = !anyMonitoringSelected;
}

/** Wire row-checkbox + select-all + search + tab clicks. Idempotent. */
function dashInitListeners() {
  // Tab clicks
  const tabs = document.getElementById('dash-tabs');
  if (tabs && !tabs.__dashWired) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.dash-tab');
      if (btn) dashSetTab(btn.dataset.tab);
    });
    tabs.__dashWired = true;
  }
  // Select-all
  const selall = document.getElementById('dash-selall');
  if (selall && !selall.__dashWired) {
    selall.addEventListener('click', dashToggleSelectAll);
    selall.__dashWired = true;
  }
  // Search input
  const search = document.getElementById('dash-search');
  if (search && !search.__dashWired) {
    search.addEventListener('input', (e) => {
      _dashSearch = e.target.value;
      dashApplySearch();
      dashRenderSelectAll();
    });
    search.__dashWired = true;
  }
  // Row checkbox clicks — event delegation on the body since rows come and go.
  // Capture phase is required: past rows have an inline onclick="openPastCampaignModal(idx)"
  // on the row itself, which fires in the bubble phase BEFORE the body's
  // bubble-phase listener gets a chance to stopPropagation. Capturing on the body
  // means we see the click before it descends into the row's bubble handlers.
  if (!document.body.__dashRowWired) {
    document.body.addEventListener('click', (e) => {
      const check = e.target.closest('.dash-row-check');
      if (check) {
        e.stopPropagation();
        e.preventDefault();
        const id = check.dataset.id;
        if (id) {
          _dashSelection = _dashToggleSel(_dashSelection, id);
          dashRenderSelection();
          dashRenderBulkStrip();
        }
      }
    }, true);
    document.body.__dashRowWired = true;
  }
}

/** Master select-all click. Toggles every VISIBLE row in the active panel. */
function dashToggleSelectAll() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  if (!panel) return;
  const visible = Array.from(panel.querySelectorAll('.campaign-row[data-campaign-id]'))
    .filter((r) => r.style.display !== 'none');
  const visibleIds = visible.map((r) => r.dataset.campaignId);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => _dashSelection.has(id));
  if (allSelected) {
    for (const id of visibleIds) _dashSelection.delete(id);
  } else {
    for (const id of visibleIds) _dashSelection.add(id);
  }
  dashRenderSelection();
  dashRenderBulkStrip();
}

function dashClearSelection() {
  _dashSelection = new Set();
  dashRenderSelection();
  dashRenderBulkStrip();
}

function dashBulkPauseWatch() {
  // v2.51 — backend pause-monitoring not yet wired. Show a toast.
  const n = _dashSelection.size;
  if (typeof window.showToast === 'function') {
    window.showToast(`Pause Watch is not wired yet (${n} selected). Coming in the next release.`);
  } else {
    alert(`Pause Watch is not wired yet (${n} selected). Coming in the next release.`);
  }
}

/** Called by the existing refresh* functions OR on demand to re-decorate
 *  everything. Updates counts + selection + strip. Safe to call frequently. */
function dashRefreshAll() {
  dashUpdateCounts();
  dashRenderSelection();
  dashRenderBulkStrip();
}

/** First-paint: pick the default tab and show it. Called once on app load. */
function dashInit() {
  dashInitListeners();
  dashUpdateCounts();
  const ids = dashGetIdsByTab();
  const counts = {};
  for (const t of DASH_TABS) counts[t] = (ids[t] || []).length;
  let persisted = '';
  try { persisted = localStorage.getItem(DASH_PERSIST_KEY) || ''; } catch {}
  const tab = _dashPickDefaultTab(counts, persisted);
  dashSetTab(tab);
}

// Expose globals for index.html onclick handlers and for other modules to call
window.dashSetTab = dashSetTab;
window.dashClearSelection = dashClearSelection;
window.dashBulkPauseWatch = dashBulkPauseWatch;
window.dashRefreshAll = dashRefreshAll;
window.dashInit = dashInit;
// dashBulkDelete is wired in Task 5

// First-paint: invoke dashInit on DOM ready (or immediately if already loaded)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if (typeof dashInit === 'function') dashInit(); });
} else {
  if (typeof dashInit === 'function') dashInit();
}

/** Open a confirmation dialog for the current selection. On confirm, deletes
 *  past campaigns via /api/history/delete-batch. Non-past selections in v1
 *  are skipped with a toast — operator should use per-row delete for those. */
function dashBulkDelete() {
  if (_dashSelection.size === 0) return;
  const ids = Array.from(_dashSelection);

  // Partition selection into past (deletable in v1) vs other (skipped in v1)
  const pastRows = [];
  const otherRows = [];
  ids.forEach((id) => {
    const row = document.querySelector(`.campaign-row[data-campaign-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const state = row.dataset.state || '';
    if (state === 'past' || state === 'stopped' || state === 'completed' || state === 'failed') {
      const idx = row.dataset.historyIdx;
      if (idx !== undefined && idx !== '') pastRows.push({ id, idx: Number(idx), row });
    } else {
      otherRows.push({ id, state, row });
    }
  });

  // If nothing in selection is deletable, just toast and bail
  if (pastRows.length === 0) {
    const msg = otherRows.length > 0
      ? 'Bulk delete only works for Past campaigns in this release. Use per-row delete for the others.'
      : 'Nothing to delete.';
    if (typeof window.showToast === 'function') window.showToast(msg);
    else alert(msg);
    return;
  }

  // Build the dialog
  const names = pastRows.map(({ row, id }) => {
    const nameEl = row.querySelector('.campaign-row-name, .campaign-row-name-text');
    return nameEl ? (nameEl.textContent || id).trim() : id;
  });

  const bg = document.createElement('div');
  bg.className = 'dash-dialog-bg';
  bg.innerHTML = `
    <div class="dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dash-dialog-h">
      <h2 id="dash-dialog-h">Delete ${pastRows.length} past campaign${pastRows.length === 1 ? '' : 's'}?</h2>
      <p>This removes <b>${pastRows.length}</b> past campaign${pastRows.length === 1 ? '' : 's'} from the dashboard. <b>Google Sheet rows are not affected.</b></p>
      <div class="dash-dialog-preview"></div>
      <div class="dash-dialog-actions">
        <button type="button" class="btn btn-secondary" id="dash-dialog-cancel">CANCEL</button>
        <button type="button" class="btn btn-stop" id="dash-dialog-confirm">DELETE ${pastRows.length}</button>
      </div>
    </div>
  `;
  // Populate preview with escaped names (no innerHTML — safer)
  const preview = bg.querySelector('.dash-dialog-preview');
  for (const name of names) {
    const span = document.createElement('span');
    span.textContent = `· ${name}`;
    preview.appendChild(span);
  }
  // If there are skipped rows, append a note
  if (otherRows.length > 0) {
    const note = document.createElement('span');
    note.style.cssText = 'display:block; padding-top:6px; color: rgba(255,255,255,0.5); font-size:0.66rem; letter-spacing:0.06em;';
    note.textContent = `(${otherRows.length} non-past row${otherRows.length === 1 ? '' : 's'} in selection will NOT be deleted — bulk delete supports past only in v1.)`;
    preview.appendChild(note);
  }
  document.body.appendChild(bg);

  // Focus the cancel button by default — safer than focusing the destructive one
  const cancelBtn = bg.querySelector('#dash-dialog-cancel');
  const confirmBtn = bg.querySelector('#dash-dialog-confirm');
  cancelBtn.focus();

  let escHandler;
  const close = () => {
    bg.remove();
    if (escHandler) document.removeEventListener('keydown', escHandler);
  };
  cancelBtn.onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);

  confirmBtn.onclick = async () => {
    close();
    await dashPerformBulkDelete(pastRows);
  };
}

/** Perform the actual deletion via /api/history/delete-batch. Refreshes the
 *  past list + dashboard state on completion. */
async function dashPerformBulkDelete(pastRows) {
  const indexes = pastRows.map((r) => r.idx).filter((n) => Number.isInteger(n) && n >= 0);
  if (indexes.length === 0) return;
  let succeeded = 0;
  let failed = 0;
  try {
    const resp = await fetch('/api/history/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexes }),
    });
    if (resp.ok) {
      succeeded = indexes.length;
    } else {
      failed = indexes.length;
    }
  } catch {
    failed = indexes.length;
  }
  // Drop the just-deleted ids from the selection set
  for (const r of pastRows) _dashSelection.delete(r.id);
  // Refresh the past list — this is the standard refresh function from the
  // existing code; it re-fetches /api/history and re-renders the past panel.
  try { if (typeof refreshPastCampaigns === 'function') await refreshPastCampaigns(); } catch {}
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
  const msg = failed === 0
    ? `Deleted ${succeeded} past campaign${succeeded === 1 ? '' : 's'}.`
    : `Delete failed (${failed} unaffected). Try again.`;
  if (typeof window.showToast === 'function') window.showToast(msg);
}

window.dashBulkDelete = dashBulkDelete;

/** Render the All tab by cloning rows from every other panel's list into
 *  #all-campaign-list, prepending a status pill based on data-state. */
function renderDashboardAll() {
  const target = document.getElementById('all-campaign-list');
  if (!target) return;
  const sources = ['active', 'monitoring', 'queued', 'schedules', 'drafts', 'past'];
  const fragments = [];
  for (const src of sources) {
    const list = document.getElementById(`${src}-campaign-list`);
    if (!list) continue;
    list.querySelectorAll('.campaign-row[data-campaign-id]').forEach((row) => {
      const clone = row.cloneNode(true);
      // Remove any previously-injected checkbox so the cloned row picks up
      // the fresh one when dashRenderSelection() runs next.
      clone.querySelectorAll('.dash-row-check').forEach((c) => c.remove());
      // Prepend a status pill
      const state = clone.dataset.state || 'past';
      const pill = document.createElement('span');
      pill.className = `dash-row-pill ${state}`;
      pill.textContent = state.toUpperCase();
      // Insert pill at the start of the name cell if it exists, else as first child
      const nameCell = clone.querySelector('.campaign-row-name') || clone;
      nameCell.prepend(pill);
      fragments.push(clone);
    });
  }
  target.innerHTML = '';
  if (fragments.length === 0) {
    target.innerHTML = '<p class="empty-state">No campaigns yet.</p>';
  } else {
    for (const f of fragments) target.appendChild(f);
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}
window.renderDashboardAll = renderDashboardAll;

// Dashboard keyboard shortcuts. Only fire when focus is inside the dashboard view
// (or on body) AND no input/textarea is focused (so typing doesn't trigger).
function dashKeyHandler(e) {
  const dashView = document.getElementById('dashboard-view');
  if (!dashView || dashView.style.display === 'none') return;
  // Ignore key events when typing in an input/textarea/contenteditable
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  // 1..7 → tab
  if (e.key >= '1' && e.key <= '7') {
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < DASH_TABS.length) {
      dashSetTab(DASH_TABS[idx]);
      e.preventDefault();
    }
    return;
  }
  // / → focus search
  if (e.key === '/') {
    const search = document.getElementById('dash-search');
    if (search) { search.focus(); e.preventDefault(); }
    return;
  }
  // Esc → clear selection
  if (e.key === 'Escape' && _dashSelection.size > 0) {
    dashClearSelection();
    e.preventDefault();
    return;
  }
  // Cmd/Ctrl+A → select all visible
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    dashToggleSelectAll();
    e.preventDefault();
    return;
  }
  // Backspace/Delete → bulk delete (only when selection non-empty)
  if ((e.key === 'Backspace' || e.key === 'Delete') && _dashSelection.size > 0) {
    dashBulkDelete();
    e.preventDefault();
    return;
  }
}
document.addEventListener('keydown', dashKeyHandler);

