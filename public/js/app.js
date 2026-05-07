/* global fetch */

// Phase 11.3 — app.js is now an ES module so we can import the Replies renderer
// directly (no setTimeout race between classic + module script loading).
// Every function referenced from an inline onclick handler in index.html is
// re-exposed on `window` at the bottom of this file.
import { renderRepliesPanel } from '/js/replies-panel.mjs';

let selectedProfileIds = [];
let selectedProfileNames = {};
let allProfilesData = [];
let localBrowserFirstName = (typeof localStorage !== 'undefined' && localStorage.getItem('localBrowserFirstName')) || '';

function resolveSenderFirstName(profileId, profileName) {
  if (profileId === 'local-browser') return (localBrowserFirstName || '').trim();
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
};

// Display labels used in the modal card section headers.
const PREVIEW_FIELD_LABELS = {
  connectionNote: 'Connection Note',
  followUpMessage: 'Follow-up Message',
  inmailSubject: 'InMail Subject',
  inmailBody: 'InMail Body',
  opProfileSubject: 'Open Profile Subject',
  opProfileBody: 'Open Profile Body',
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
    introMode: mode === 'message_only' && localStorage.getItem('ortus-intro-mode') === '1',
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
  const sec = document.getElementById('nav-status');
  if (sec && sec.classList.contains('collapsible') && sec.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    try { localStorage.setItem('section-collapsed:nav-status', '0'); } catch (_) {}
  }
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
}

function removeProfile(id) {
  selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
  delete selectedProfileNames[id];
  const cb = document.querySelector(`#profiles-grid input[value="${id}"]`);
  if (cb) { cb.checked = false; cb.closest('.profile-item')?.classList.remove('selected'); }
  renderSelectedPanel();
}

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
function syncAddNoteUI(on) {
  const yesBtn = document.getElementById('add-note-yes');
  const noBtn = document.getElementById('add-note-no');
  const connect = document.getElementById('tpl-connect-section');
  if (yesBtn) yesBtn.classList.toggle('active', on);
  if (noBtn) noBtn.classList.toggle('active', !on);
  if (connect) connect.style.display = on ? '' : 'none';
  // Note: template-bar visibility is now driven by mode (see onModeChange),
  // so GDs can save/load template bundles in every mode except Check Status.
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
  const openToggle = document.getElementById('open-profile-toggle');
  const tplMgmt = document.getElementById('nav-templates');

  connect.style.display = 'none';
  message.style.display = 'none';
  inmail.style.display = 'none';
  if (op) op.style.display = 'none';
  openToggle.style.display = 'none';
  if (tplMgmt) tplMgmt.style.display = (mode === 'check_status') ? 'none' : '';

  // Template bar (Select/Load/Delete/Save As…) is available for every mode
  // that has a template to edit — i.e. everything except Check Status.
  const tplBar = document.getElementById('template-bar');
  if (tplBar) tplBar.style.display = (mode === 'check_status') ? 'none' : '';

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
    openToggle.style.display = '';
  } else if (mode === 'message_only') {
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
  // check_dms) hide the profile picker and show a coverage panel. message_only
  // KEEPS templates (you still need a message to send) but hides only the
  // profile picker. check_dms hides everything except the coverage panel.
  const csPanel = document.getElementById('nav-check-status');
  const moPanel = document.getElementById('nav-message-only');
  const cdPanel = document.getElementById('nav-check-dms');
  const navPace = document.getElementById('nav-pace');
  const navAccounts = document.getElementById('nav-accounts');
  const isCheckStatus = (mode === 'check_status');
  const isMessageOnly = (mode === 'message_only');
  const isCheckDms = (mode === 'check_dms');
  const isAutoRouted = isCheckStatus || isMessageOnly || isCheckDms;
  if (csPanel) csPanel.style.display = isCheckStatus ? '' : 'none';
  if (moPanel) moPanel.style.display = isMessageOnly ? '' : 'none';
  if (cdPanel) cdPanel.style.display = isCheckDms ? '' : 'none';
  // 2.9.7: Check DMs is now auto-routed too — hide the profile picker.
  if (navAccounts) navAccounts.style.display = isAutoRouted ? 'none' : '';
  // 2.8.34: Pace section hidden for auto-routed modes (no per-lead pacing).
  if (navPace) navPace.style.display = isAutoRouted ? 'none' : '';
  // 2.9.7: Check DMs has no templates (read-only mode). Hide the templates
  // section entirely; other modes (incl. message_only) keep it visible.
  const navTemplates = document.getElementById('nav-templates');
  if (navTemplates) navTemplates.style.display = isCheckDms ? 'none' : '';
  // Campaign-limit-per-account knob applies ONLY to Connect campaigns (LinkedIn
  // caps invitations per account per day). DM/IC/OP/InMail are unlimited.
  const isConnectMode = (mode === 'connect_only' || mode === 'connect_and_message');
  const dailyKnob = document.getElementById('daily-limit-knob');
  if (dailyKnob) dailyKnob.style.display = isConnectMode ? '' : 'none';
  if (isCheckStatus) {
    refreshCheckStatusPreview();
  } else if (isMessageOnly) {
    refreshMessageOnlyPreview();
  } else if (isCheckDms) {
    refreshCheckDmsPreview();
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
  // Stubs — not wired to any backend yet. Click shows a "Coming soon" toast
  // and the cards stay unselected so the operator can't accidentally start them.
  {
    value: 'connect_introduce_back',
    name: 'Connect and Introduce Back',
    bullets: [
      'Send a connection request',
      'Once accepted, introduce them to the team',
      'Coming soon',
    ],
    comingSoon: true,
  },
  {
    value: 'post_amplification',
    name: 'Post Amplification',
    bullets: [
      'Paste a LinkedIn post URL',
      'All Ortus accounts like, dwell, and engage',
      'Coming soon',
    ],
    comingSoon: true,
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
  // v2.11.6: 'intro first name' / 'intro last name' join the existing
  // sender chips. Always rendered (matches how senderFirstName/senderName
  // already show in non-message-only modes); harmless in non-intro
  // campaigns since they substitute to empty strings outside introMode.
  const extras = ['senderFirstName', 'senderName', 'intro first name', 'intro last name'];
  document.querySelectorAll('.placeholder-tags').forEach(container => {
    const tags = [...sheetColumns, ...extras].map(col =>
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

  // 2.9.8: Concurrency toggle is unlocked at ≥5 accounts. Hide otherwise.
  const concurrencyRow = document.getElementById('alpha-concurrency-row');
  if (concurrencyRow) {
    concurrencyRow.style.display = numAccounts >= 5 ? '' : 'none';
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

  const totalActions = limit * numAccounts;
  const minutesNeeded = totalActions > 0
    ? Math.max(1, Math.ceil((totalActions / effectiveLeadsPerHour) * 60))
    : 0;
  const durationStr = minutesNeeded === 0
    ? '—'
    : minutesNeeded < 60
      ? `${minutesNeeded} min`
      : `${Math.floor(minutesNeeded / 60)}h ${minutesNeeded % 60}m`;

  const now = new Date();
  const finishTime = new Date(now.getTime() + minutesNeeded * 60 * 1000);
  const finishStr = minutesNeeded === 0 ? '—' : finishTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const el = document.getElementById('summary-stats');
  if (el) {
    const accountWord = numAccounts === 1 ? 'account' : 'accounts';
    el.innerHTML = `
      <div><strong>${numAccounts} ${accountWord}</strong>, up to <strong>${limit}</strong> ${words.action} per account</div>
      <div>= up to <strong>${totalActions}</strong> total ${words.action} this run</div>
      <div style="margin-top:6px">&#9200; Starts now &#8594; finishes around <strong>${finishStr}</strong></div>
    `;
  }

  // Launch hero mirror
  const ln = document.getElementById('launch-number');
  if (ln) ln.textContent = String(totalActions);
  const lc = document.getElementById('launch-connections');
  if (lc) lc.textContent = `${totalActions} ${words.action}`;
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
    setText('hero-actions-sub', `${numAccounts} ${accountWord} · ${words.action}`);
    setText('hero-duration', durationStr);
    setText('hero-duration-sub', `~${effectiveLeadsPerHour} ${words.action}/hr (${concurrency} parallel)`);
    setText('hero-finish', finishStr);
    setText('hero-finish-sub', `from now · local time`);
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
    connectionNote: (mode === 'connect_only' && !addNoteOn) ? '' : document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    // 2.8.50: Introduction Messages sub-mode (active only when mode is message_only)
    introMode: mode === 'message_only' && localStorage.getItem('ortus-intro-mode') === '1',
    introName: document.getElementById('intro-name')?.value?.trim() || '',
    introTitle: document.getElementById('intro-title')?.value || 'Introduction: {first name} <> {intro name}',
  };

  // Show account queue
  renderAccountQueue(selectedProfileIds.map(id => selectedProfileNames[id] || id), null);

  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileIds: selectedProfileIds,
        sheetUrl,
        templates,
        dailyLimit,
        mode,
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
      }),
    });
    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }
    setCampaignButtons(true);
    // Snapshot the configuration so "Load Last Used" can restore it next time.
    if (typeof saveLastUsedPreset === 'function') saveLastUsedPreset();
    startPolling();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function stopCampaign() {
  // 2.9.7: Check DMs is a separate flow with its own stop endpoint. Stop
  // both — only the running one will react, and double-stop is harmless.
  try { await fetch('/api/campaign/stop', { method: 'POST' }); } catch { /* */ }
  try { await fetch('/api/check-dms/stop', { method: 'POST' }); } catch { /* */ }
}

// Phase 2.8.9: Stop confirmation modal — guards against accidental clicks.
function confirmStopCampaign() {
  const modal = document.getElementById('confirm-stop-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeStopModal() {
  const modal = document.getElementById('confirm-stop-modal');
  if (modal) modal.classList.add('hidden');
}

async function confirmStopCampaignNow() {
  closeStopModal();
  // Visual feedback while the server force-closes browsers (~1-2s).
  showCampaignToast('Stopping campaign — closing browsers…', 4000);
  await stopCampaign();
}

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
};
const COCKPIT_RING_CIRCUMFERENCE = 282.7; // 2πr where r=45

function updateCockpit(s) {
  __cockpit.running = !!s.running;
  __cockpit.paused = !!s.paused;
  __cockpit.pauseRequested = !!s.pauseRequested;
  __cockpit.action = s.currentAction || null;
  __cockpit.mode = s.mode || null;
  __cockpit.pName = s.currentProfile || null;
  renderCockpit();
}

function renderCockpit() {
  const ring = document.querySelector('.cockpit-ring');
  const ringFg = document.getElementById('cockpit-ring-fg');
  const num = document.getElementById('cockpit-ring-num');
  const unit = document.getElementById('cockpit-ring-unit');
  const tag = document.getElementById('cockpit-status-tag');
  const dot = document.getElementById('cockpit-pulse-dot');
  const action = document.getElementById('cockpit-action');
  const lead = document.getElementById('cockpit-lead');
  const account = document.getElementById('cockpit-account');
  const modeEl = document.getElementById('cockpit-mode-meta');
  if (!ring || !ringFg || !num || !unit || !tag || !dot || !action) return;

  // Idle — no campaign running.
  if (!__cockpit.running) {
    ring.classList.remove('indeterminate', 'paused');
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE;
    num.textContent = '—';
    unit.textContent = 'idle';
    tag.textContent = 'IDLE';
    dot.classList.remove('live', 'paused-dot');
    action.textContent = 'No campaign running';
    if (lead)    lead.textContent    = '—';
    if (account) account.textContent = '—';
    if (modeEl)  modeEl.textContent  = '—';
    return;
  }

  // Paused — distinct visual.
  if (__cockpit.paused) {
    ring.classList.remove('indeterminate');
    ring.classList.add('paused');
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
  ring.classList.remove('paused');
  tag.textContent = __cockpit.pauseRequested ? 'PAUSING…' : 'LIVE';
  dot.classList.remove('paused-dot'); dot.classList.add('live');

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
    connect_and_message: 'Connect + Message',
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
  ['btn-start', 'btn-start-rb'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = running; });
  ['btn-stop',  'btn-stop-rb' ].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !running; });
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
function renderAccountQueue(names, currentName) {
  const el = document.getElementById('account-queue');
  if (!names || names.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = names.map((name, i) => {
    let cls = 'queue-item';
    if (currentName && name === currentName) cls += ' active';
    else if (currentName && names.indexOf(currentName) > i) cls += ' done';
    return `<div class="${cls}"><span class="num">${i + 1}</span><span class="name">${escHtml(name)}</span></div>`;
  }).join('');
}

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
      if (s.logs?.length > 0 && !s.running) stopPolling();
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
      renderAccountQueue(s.profileNames, s.currentProfile);
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

async function loadSelectedTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  if (!name) { alert('Select a template first.'); return; }
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
  } catch (err) {
    alert('Failed to load template: ' + err.message);
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
    if (data.deleted) await fetchSchedules();
  } catch (err) {
    alert('Failed to delete schedule: ' + err.message);
  }
}

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
  // Auto-expand if collapsible+collapsed
  if (el.classList.contains('collapsible') && el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    try { localStorage.setItem(`section-collapsed:${id}`, '0'); } catch (_) {}
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setActiveNav(id);
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
    bar.classList.toggle('running', running);
    const profile = (__cockpit.action && __cockpit.action.account) || __cockpit.pName || '';
    const mode = formatMode(__cockpit.mode);
    const today = document.getElementById('st-today')?.textContent || '0';
    const total = document.getElementById('st-total')?.textContent || '0';
    if (running) {
      const label = __cockpit.paused ? 'Paused' : (__cockpit.pauseRequested ? 'Pausing…' : 'Running');
      txt.innerHTML = `<strong>${label}</strong> · ${mode} · ${profile} · ${today}/${total}`;
    } else {
      txt.textContent = 'Idle';
    }

    // Right-pane status mirror
    const rpDot = document.getElementById('rp-dot');
    const rpStatusText = document.getElementById('rp-status-text');
    const rpStatusSub = document.getElementById('rp-status-sub');
    if (rpDot) rpDot.classList.toggle('running', running);
    if (rpStatusText) rpStatusText.textContent = running ? 'Running' : 'Idle';
    if (rpStatusSub) {
      rpStatusSub.textContent = running
        ? `${mode} · ${profile} · ${today}/${total}`
        : 'No campaign running';
    }

    // Right-pane activity feed — mirror the last ~10 log entries
    syncActivityFeed();

    // Auto-expand Live Status when running, auto-collapse when idle
    if (statusSection && statusSection.classList.contains('collapsible')) {
      if (running && statusSection.classList.contains('collapsed')) {
        statusSection.classList.remove('collapsed');
      } else if (!running && wasRunning) {
        statusSection.classList.add('collapsed');
      }
    }
    wasRunning = running;
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
window.onPastSearchInput = onPastSearchInput;
window.togglePastExpanded = togglePastExpanded;
window.togglePresetPopover = togglePresetPopover;
window.updateCampaignSummary = updateCampaignSummary;

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
    case 'connect_and_message': return 'Connect + message';
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
// 2.8.50: Introduction Messages — sub-mode of Message Only
// Toggle the segment switcher, persist to localStorage, restore on load.
// ─────────────────────────────────────────────────────────────────────────
function setIntroMode(active) {
  localStorage.setItem('ortus-intro-mode', active ? '1' : '0');
  const stdBtn   = document.getElementById('intro-seg-standard');
  const introBtn = document.getElementById('intro-seg-intro');
  const fields   = document.getElementById('intro-mode-fields');
  if (stdBtn) {
    stdBtn.style.background = active ? 'transparent' : 'var(--ink)';
    stdBtn.style.color      = active ? 'var(--gray)' : 'var(--bg)';
  }
  if (introBtn) {
    introBtn.style.background = active ? 'var(--ink)' : 'transparent';
    introBtn.style.color      = active ? 'var(--bg)' : 'var(--gray)';
  }
  if (fields) fields.style.display = active ? '' : 'none';
}
function saveIntroFields() {
  const name  = document.getElementById('intro-name')?.value || '';
  const title = document.getElementById('intro-title')?.value || '';
  localStorage.setItem('ortus-intro-name', name);
  localStorage.setItem('ortus-intro-title', title);
}
function restoreIntroState() {
  const nameEl  = document.getElementById('intro-name');
  const titleEl = document.getElementById('intro-title');
  if (nameEl)  nameEl.value  = localStorage.getItem('ortus-intro-name')  || nameEl.value;
  if (titleEl) titleEl.value = localStorage.getItem('ortus-intro-title') || titleEl.value;
  const active = localStorage.getItem('ortus-intro-mode') === '1';
  setIntroMode(active);
}
document.addEventListener('DOMContentLoaded', restoreIntroState);
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
const DASHBOARD_MODE_LABELS = {
  connect_only: 'Connect Only',
  check_status: 'Check Status',
  message_only: 'Message Only',
  inmail_only: 'InMail Only',
  open_profile_only: 'Open Profile Message',
  check_dms: 'Check DMs',
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

function applyRoute() {
  const isWizard = (window.location.hash || '#/').startsWith('#/new');
  document.body.classList.toggle('route-wizard', isWizard);
  document.body.classList.toggle('route-dashboard', !isWizard);
  if (!isWizard) refreshDashboard();
}
function goCreateCampaign() { window.location.hash = '#/new'; }
function goDashboard()      { window.location.hash = '#/'; }

async function refreshDashboard() {
  await Promise.all([refreshActiveCampaign(), refreshPastCampaigns()]);
}

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
      list.innerHTML = '<p class="empty-state">No active campaigns.</p>';
      return;
    }
    const total = Number(status.totalTargets) || 0;
    const done = Number(status.totalProcessed) || 0;
    const left = Math.max(0, total - done);
    const statusLabel = status.paused ? 'Paused' : 'Running';
    const statusClass = status.paused ? 'is-paused' : 'is-running';
    const progress = total > 0 ? `${done} / ${total} · ${left} left` : `${done} processed`;
    list.innerHTML = `
      <div class="campaign-row">
        <div class="campaign-row-name">${dashboardNameButton(status.name, 'active', 'active')}</div>
        <span class="campaign-row-type">${escHtml(dashboardModeLabel(status.mode))}</span>
        <span class="campaign-row-progress">${escHtml(progress)}</span>
        <span class="campaign-row-status ${statusClass}">${statusLabel}</span>
      </div>
    `;
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load active campaign.</p>';
  }
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
let pastExpanded = false;
let pastSearchQuery = '';

function onPastSearchInput() {
  const inp = document.getElementById('past-search');
  pastSearchQuery = ((inp && inp.value) || '').trim().toLowerCase();
  refreshPastCampaigns();
}

function togglePastExpanded() {
  pastExpanded = !pastExpanded;
  refreshPastCampaigns();
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

    // Slice to PAST_COLLAPSED_LIMIT only when not searching and not expanded.
    const showAll = !!q || pastExpanded;
    const visible = showAll ? filtered : filtered.slice(0, PAST_COLLAPSED_LIMIT);

    list.innerHTML = visible.map(({ idx, c }) => {
      const dateStr = dashboardFormatDate(c.startedAt || c.date) || '—';
      const subtitle = `${dashboardModeLabel(c.mode)} · ${dateStr}`;
      const processed = c.totalProcessed != null ? c.totalProcessed : (c.successCount || 0);
      return `
        <div class="campaign-row">
          <div class="campaign-row-name">${dashboardNameButton(c.name, 'past', String(idx))}</div>
          <span class="campaign-row-type">${escHtml(subtitle)}</span>
          <span class="campaign-row-progress">${escHtml(processed + ' processed')}</span>
          <span class="campaign-row-status is-done">Completed</span>
        </div>
      `;
    }).join('');

    // Toggle visibility + label. Hidden when searching (search shows all
    // matches inherently) or when total ≤ limit (nothing to expand).
    if (toggleRow && toggleBtn) {
      const remaining = filtered.length - PAST_COLLAPSED_LIMIT;
      if (q || filtered.length <= PAST_COLLAPSED_LIMIT) {
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
}

// Inline-edit a campaign name. Delegated click → input swap → save on Enter
// or blur, cancel on Escape. Save hits POST /api/campaign/name for active or
// PATCH /api/history/:idx/name for past, then re-renders the section.
async function saveCampaignName(kind, key, value) {
  const url = kind === 'active'
    ? '/api/campaign/name'
    : `/api/history/${encodeURIComponent(key)}/name`;
  const method = kind === 'active' ? 'POST' : 'PATCH';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }),
  });
  if (!res.ok) throw new Error(`Rename failed (${res.status})`);
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
// Campaign Name — top-of-wizard text input. Persisted to localStorage for now;
// flowing it through /api/campaign/start → status → history is a Phase 2 task.
// ─────────────────────────────────────────────────────────────────────────────
function initCampaignNameInput() {
  const input = document.getElementById('campaign-name-input');
  if (!input) return;
  try { input.value = localStorage.getItem('campaignName') || ''; } catch {}
  input.addEventListener('input', () => {
    try { localStorage.setItem('campaignName', input.value); } catch {}
  });
}
document.addEventListener('DOMContentLoaded', initCampaignNameInput);
if (document.readyState !== 'loading') initCampaignNameInput();
