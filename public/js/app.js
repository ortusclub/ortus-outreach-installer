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
  try {
    const res = await fetch('/api/notify/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert('Test failed: ' + (data.error || `HTTP ${res.status}`));
      return;
    }
    alert(`Test email sent.\nRecipients reached: ${data.sent ?? 0}${data.reason ? '\nNote: ' + data.reason : ''}`);
  } catch (err) {
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
function toggleServerLog() {
  const panel = document.getElementById('server-log-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    fetchServerLog();
    if (!serverLogInterval) serverLogInterval = setInterval(fetchServerLog, 3000);
  } else {
    if (serverLogInterval) { clearInterval(serverLogInterval); serverLogInterval = null; }
  }
}

async function fetchServerLog() {
  try {
    const res = await fetch('/api/server-log');
    const lines = await res.json();
    const el = document.getElementById('server-log');
    el.innerHTML = lines.map(line => {
      let cls = '';
      if (line.includes('[ERR]')) cls = 'error';
      else if (line.includes('[WARN]')) cls = 'warn';
      else if (line.includes('✓')) cls = 'success';
      return `<div class="entry ${cls}">${escHtml(line)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  } catch { /* */ }
}

async function clearServerLog() {
  try { await fetch('/api/server-log', { method: 'DELETE' }); } catch { /* */ }
  const el = document.getElementById('server-log');
  if (el) el.innerHTML = '';
}

function copyServerLog() {
  const el = document.getElementById('server-log');
  if (!el) return;
  const text = Array.from(el.querySelectorAll('.entry')).map(e => e.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = el.closest('#server-log-panel').querySelector('button');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

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

  // Add Local Browser option at the top
  const localItem = document.createElement('label');
  localItem.className = 'profile-item local-browser' + (selectedProfileIds.includes('local-browser') ? ' selected' : '');
  localItem.dataset.profileId = 'local-browser';
  localItem.innerHTML = `
    <input type="checkbox" class="local-cb" value="local-browser" ${selectedProfileIds.includes('local-browser') ? 'checked' : ''} />
    <div style="flex:1">
      <div class="name">Local Browser</div>
      <div class="id" style="color:#8b949e">Your system Chrome. If first time, please log into LinkedIn.</div>
      <div style="margin-top:6px">
        <input type="text" id="local-browser-first-name" placeholder="Your first name (used as {senderFirstName})"
          value="${escHtml(localBrowserFirstName)}"
          style="width:100%;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:4px;font-size:12px" />
      </div>
    </div>
  `;
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
    } else {
      selectedProfileIds = selectedProfileIds.filter(id => id !== 'local-browser');
      delete selectedProfileNames['local-browser'];
      localItem.classList.remove('selected');
    }
    renderSelectedPanel();
  });
  grid.appendChild(localItem);

  profiles.forEach((p) => {
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
  try { localStorage.setItem('ortus-my-identifier', el.value.trim()); } catch (_) {}
  updateChipCounts();
}

function initMyIdentifier() {
  const el = document.getElementById('my-identifier');
  if (!el) return;
  let saved = '';
  try { saved = localStorage.getItem('ortus-my-identifier') || ''; } catch (_) {}
  if (!saved) {
    const chip = document.getElementById('user-chip-email');
    saved = (chip?.textContent || '').trim();
  }
  el.value = saved;
}

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
// Kinetic Campaign Mode picker
// ─────────────────────────────────────────────────────────────────────────────
const MODE_LIST = [
  { value: 'connect_only',        name: 'Connect Only',        desc: 'Send connection requests only. Safest, highest-volume mode for top-of-funnel outreach.' },
  { value: 'check_status',        name: 'Check Status',        desc: 'Verify which pending connection requests have been accepted. Updates the sheet.' },
  { value: 'message_only',        name: 'Message Only',        desc: 'Send follow-up messages to existing 1st-degree connections. Fast, low-risk.' },
  { value: 'inmail_only',         name: 'InMail Only',         desc: 'Premium InMail to targets. Consumes InMail credits; use during passover windows.' },
  { value: 'open_profile_only',   name: 'Open Profile Message', desc: 'Free direct message to Open Profiles. No credits used; no connection required.' },
];

function renderModeSelector() {
  const select = document.getElementById('campaign-mode');
  if (!select) return;
  const current = select.value;
  let activeIdx = MODE_LIST.findIndex((m) => m.value === current);
  if (activeIdx < 0) activeIdx = 0;

  const active = MODE_LIST[activeIdx];
  const prev = MODE_LIST[(activeIdx - 1 + MODE_LIST.length) % MODE_LIST.length];
  const next = MODE_LIST[(activeIdx + 1) % MODE_LIST.length];

  // Saved label/description overrides (per-mode, keyed by mode value).
  // This lets the generic "Edit labels" flow persist per-mode edits.
  const saved = loadEditsFromStorage();
  const nameFor = (m) => saved[`mode-name-${m.value}`] || m.name;
  const descFor = (m) => saved[`mode-desc-${m.value}`] || m.desc;

  const set = (id, v, editKey) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Don't stomp on text the user is currently editing
    if (!document.body.classList.contains('edit-mode')) el.textContent = v;
    if (editKey) el.dataset.edit = editKey;
  };
  set('mode-prev-name', nameFor(prev), `mode-name-${prev.value}`);
  set('mode-next-name', nameFor(next), `mode-name-${next.value}`);
  set('mode-title',     nameFor(active), `mode-name-${active.value}`);
  set('mode-desc',      descFor(active), `mode-desc-${active.value}`);
  set('mode-counter', `${String(activeIdx + 1).padStart(2, '0')} / ${String(MODE_LIST.length).padStart(2, '0')}`);

  const fill = document.getElementById('mode-progress-fill');
  if (fill) fill.style.width = `${((activeIdx + 1) / MODE_LIST.length) * 100}%`;

  const chips = document.getElementById('mode-chips');
  if (chips) {
    chips.innerHTML = MODE_LIST.map((m, i) =>
      `<button type="button" class="mode-chip ${i === activeIdx ? 'active' : ''}" onclick="setModeByIndex(${i})">${escHtml(nameFor(m))}</button>`
    ).join('');
  }
}

function setModeByIndex(i) {
  const mode = MODE_LIST[(i + MODE_LIST.length) % MODE_LIST.length];
  const select = document.getElementById('campaign-mode');
  if (!select) return;
  const title = document.getElementById('mode-title');
  const apply = () => {
    select.value = mode.value;
    onModeChange();
    renderModeSelector();
    if (title) title.classList.remove('switching');
  };
  if (title) {
    title.classList.add('switching');
    setTimeout(apply, 180);
  } else {
    apply();
  }
}

function modeStep(direction) {
  const select = document.getElementById('campaign-mode');
  if (!select) return;
  const idx = MODE_LIST.findIndex((m) => m.value === select.value);
  const cur = idx < 0 ? 0 : idx;
  const n = (cur + direction + MODE_LIST.length) % MODE_LIST.length;
  setModeByIndex(n);
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
  const extras = ['senderFirstName', 'senderName'];
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
// Phase 2.8.14 — Alpha Throughput panel (replaces the old Rate & Limits steppers).
// alpha-leads-per-hour is the visible knob (5-30, step 5). rate-per-hour stays
// as the hidden source-of-truth for the backend (1-6 batches/hour). The two
// are kept in sync via alphaSyncRate (leads = batches × 5).
// ─────────────────────────────────────────────────────────────────────────
function alphaSyncRate() {
  const leadsEl = document.getElementById('alpha-leads-per-hour');
  const batchesEl = document.getElementById('rate-per-hour');
  if (!leadsEl || !batchesEl) return;
  let leads = parseInt(leadsEl.value, 10);
  if (!Number.isFinite(leads)) leads = 10;
  // Snap to multiples of 5 within [5, 30]
  leads = Math.max(5, Math.min(30, Math.round(leads / 5) * 5));
  if (parseInt(leadsEl.value, 10) !== leads) leadsEl.value = String(leads);
  batchesEl.value = String(leads / 5);
  updateCampaignSummary();
}

function alphaStepLeads(delta) {
  const leadsEl = document.getElementById('alpha-leads-per-hour');
  if (!leadsEl) return;
  const cur = parseInt(leadsEl.value, 10) || 10;
  leadsEl.value = String(Math.max(5, Math.min(30, cur + delta)));
  alphaSyncRate();
}

function alphaRecalc() {
  const leadsEl = document.getElementById('alpha-leads-per-hour');
  const totalEl = document.getElementById('alpha-total-leads');
  const acctCountEl = document.getElementById('alpha-acct-count');
  const perAcctEl = document.getElementById('alpha-per-acct');
  const eqTotalEl = document.getElementById('alpha-eq-total');
  const dailyTargetEl = document.getElementById('alpha-daily-target');
  const roundTimeEl = document.getElementById('alpha-round-time');
  if (!leadsEl || !totalEl) return; // alpha panel not on page — nothing to do

  const leads = parseInt(leadsEl.value, 10) || 10;
  const numAccounts = Array.isArray(selectedProfileIds) ? selectedProfileIds.length : 0;
  const total = leads * numAccounts;

  totalEl.textContent = total > 0 ? String(total) : '—';
  if (acctCountEl) acctCountEl.textContent = String(numAccounts);
  if (perAcctEl)   perAcctEl.textContent   = String(leads);
  if (eqTotalEl)   eqTotalEl.textContent   = String(total);

  // Daily target: clamp at the per-account daily limit × accounts.
  const dailyLimit = parseInt(document.getElementById('daily-limit')?.value, 10) || 40;
  if (dailyTargetEl) {
    if (numAccounts === 0) {
      dailyTargetEl.textContent = '—';
    } else {
      // 10-hour working window approximation, capped by per-account daily limit
      const tenHrCap = total * 10;
      const safetyCap = dailyLimit * numAccounts;
      dailyTargetEl.textContent = Math.min(tenHrCap, safetyCap) + ' leads / day';
    }
  }

  // Round time: 60 / batchesPerHour minutes between rounds.
  if (roundTimeEl) {
    const batches = Math.max(1, Math.round(leads / 5));
    roundTimeEl.textContent = '~' + Math.round(60 / batches);
  }
}

function updateCampaignSummary() {
  // Phase 2.8.14: alpha throughput panel recalculates whenever this fires
  // (account toggle, rate/pause edit). Safe to call before alpha is ready —
  // it null-guards every element lookup.
  alphaRecalc();
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';

  // Mode-specific vocabulary. Phase 11.2 (D-06..D-09): rate is ALWAYS "Batches
  // per hour" — the rate input is the same batches-per-hour knob in every mode
  // post-11.2. limitLabel is decorative (the #daily-limit-wrap is hidden) but
  // still assigned so downstream setters don't crash.
  const MODE_WORDS = {
    connect_only:        { action: 'connections',            actionVerb: 'sending',  rateLabel: 'Batches per hour', limitLabel: 'Safety cap' },
    message_only:        { action: 'messages',               actionVerb: 'sending',  rateLabel: 'Batches per hour', limitLabel: 'Safety cap' },
    inmail_only:         { action: 'InMails',                actionVerb: 'sending',  rateLabel: 'Batches per hour', limitLabel: 'Safety cap' },
    open_profile_only:   { action: 'Open Profile messages',  actionVerb: 'sending',  rateLabel: 'Batches per hour', limitLabel: 'Safety cap' },
    check_status:        { action: 'checks',                 actionVerb: 'checking', rateLabel: 'Batches per hour', limitLabel: 'Safety cap' },
  };
  const words = MODE_WORDS[mode] || MODE_WORDS.connect_only;

  // Update field labels
  const rateLabelEl = document.getElementById('rate-per-hour-label');
  if (rateLabelEl) rateLabelEl.textContent = words.rateLabel;
  const limitLabelEl = document.getElementById('daily-limit-label');
  if (limitLabelEl) limitLabelEl.textContent = words.limitLabel;

  // Cap the daily-limit input at the sheet row count once known. Note: the
  // wrapper is hidden post-11.2 (D-08), but the input remains so its value
  // still posts as the backend safety cap.
  const limitInput = document.getElementById('daily-limit');
  const rows = typeof window.sheetTotalRows === 'number' && window.sheetTotalRows > 0 ? window.sheetTotalRows : null;
  if (limitInput && rows) {
    limitInput.max = String(rows);
    const current = parseInt(limitInput.value, 10) || 0;
    if (current > rows) limitInput.value = String(rows);
  }

  const limit = parseInt(document.getElementById('daily-limit').value, 10) || 40;
  // Phase 2.8.16: use REAL account count, no defensive Math.max(..., 1) — that
  // was making the forecast tiles show numbers (e.g. 40 actions) when the
  // operator hadn't selected any account yet. Downstream renders "—" if 0.
  const numAccounts = selectedProfileIds.length;
  const numAccountsForMath = Math.max(numAccounts, 1); // for divisions / clamps only

  // Phase 11.2: rate is batches/hour for every mode. In message_only we still
  // derive a rate-ish value from the gap field for the summary text.
  const MSG_OUTREACH_TIME = 25;

  let rate;
  if (mode === 'message_only') {
    const gap = parseInt(document.getElementById('message-gap')?.value, 10) || 60;
    rate = Math.max(1, Math.round(3600 / (MSG_OUTREACH_TIME + gap)));
  } else {
    rate = parseInt(document.getElementById('rate-per-hour').value, 10) || 2;
  }

  // Phase 11.2 (D-01): each batch = 5 leads. Approximate leads/hour from the
  // batch rate for the hero copy. In message mode this is the rate (pure msgs).
  const LEADS_PER_BATCH = 5;
  const leadsPerHour = mode === 'message_only' ? rate : rate * LEADS_PER_BATCH;
  const totalPerHour = leadsPerHour * numAccounts;
  const totalActions = limit * numAccounts;
  // Duration based on leads/hour (batches × 5), capped by the backend safety
  // limit. Example: 2 bph × 1 account × 5 leads = 10 leads/hr. 40 cap ⇒ 240 min.
  const effectiveRate = Math.max(1, leadsPerHour);
  const minutesNeeded = Math.max(1, Math.ceil((limit / effectiveRate) * 60));
  const durationStr = minutesNeeded < 60
    ? `${minutesNeeded} min`
    : `${Math.floor(minutesNeeded / 60)}h ${minutesNeeded % 60}m`;

  const now = new Date();
  const finishTime = new Date(now.getTime() + minutesNeeded * 60 * 1000);
  const finishStr = finishTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const el = document.getElementById('summary-stats');
  if (el) {
    const accountWord = numAccounts === 1 ? 'account' : 'accounts';
    if (mode === 'message_only') {
      el.innerHTML = `
        <div><strong>${numAccounts} ${accountWord}</strong>, each ${words.actionVerb} <strong>${rate}</strong> ${words.action} per hour</div>
        <div>= up to <strong>${totalActions}</strong> ${words.action} capped by the safety limit (${limit}/account)</div>
        <div style="margin-top:6px">&#9200; Starts now &#8594; finishes around <strong>${finishStr}</strong></div>
      `;
    } else {
      el.innerHTML = `
        <div><strong>${numAccounts} ${accountWord}</strong>, each running <strong>${rate}</strong> batch${rate === 1 ? '' : 'es'} per hour (~${leadsPerHour} leads/hour per account)</div>
        <div>= up to <strong>${totalActions}</strong> ${words.action} capped by the safety limit (${limit}/account)</div>
        <div style="margin-top:6px">&#9200; Starts now &#8594; finishes around <strong>${finishStr}</strong></div>
      `;
    }
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
    if (mode === 'message_only') {
      setText('hero-duration-sub', `${rate} ${words.action}/hr × ${numAccounts}`);
    } else {
      setText('hero-duration-sub', `${rate} batches/hr × ${numAccounts}`);
    }
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
  if (selectedProfileIds.length === 0) { alert('Select at least one GoLogin profile.'); return; }
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

  // Phase 11.2 (D-06): batchesPerHour is the primary pacing knob (1..6), sourced
  // from the relabeled #rate-per-hour input. Clamp defensively before POST.
  const batchesPerHour = Math.max(1, Math.min(6, parseInt(document.getElementById('rate-per-hour').value, 10) || 2));

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
        batchesPerHour,
        dailyLimit,
        mode,
        messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked,
        delayMin,
        delayMax,
        linkedinColumn: document.getElementById('linkedin-col-select')?.value || '',
        senderFirstNames
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
  try { await fetch('/api/campaign/stop', { method: 'POST' }); } catch { /* */ }
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
    if (!selectedProfileIds.length) {
      alert('Select at least one profile before running Check DMs.');
      return;
    }
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
      body: JSON.stringify({ profileIds: selectedProfileIds, sheetUrl, linkedinColumn }),
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
      html += '<dt>Daily Limit</dt><dd>' + escHtml(String(c.dailyLimit || '--')) + '</dd>';
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
  if (!dailyLimit || dailyLimit < 1) { alert('Daily limit must be at least 1.'); return; }

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

  // Phase 11.2 (D-06): persist batchesPerHour on the schedule so cron fires
  // honour the operator's pacing choice.
  const batchesPerHour = Math.max(1, Math.min(6, parseInt(document.getElementById('rate-per-hour').value, 10) || 2));

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
        batchesPerHour,
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
    // Phase 11.2: post-relabel, #rate-per-hour is batches/hour (1..6). Keep
    // ratePerHour field for cross-version back-compat read; batchesPerHour is
    // the 11.2+ canonical name.
    ratePerHour: getN('rate-per-hour', 2),
    batchesPerHour: getN('rate-per-hour', 2),
    dailyLimit: getN('daily-limit', 40),
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

  // Phase 11.2 (D-09): legacy presets saved before 11.2 carried a ratePerHour
  // with connections-per-hour semantics (1..30). Post-11.2 the same input is
  // batches-per-hour (1..6). If we detect a legacy preset (ratePerHour present,
  // batchesPerHour absent), reset the input to the new default (2) and flash a
  // one-time banner so the operator knows their old number did NOT survive.
  const isLegacyPreset = config.ratePerHour !== undefined && config.batchesPerHour === undefined;
  if (isLegacyPreset) {
    setV('rate-per-hour', 2);
    let banner = document.getElementById('legacy-preset-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'legacy-preset-banner';
      banner.style.cssText = 'padding:8px 12px; margin:8px 0; background:#3a2f1a; color:#ffd480; border-radius:6px; font-size:0.9rem;';
      banner.textContent = "Pacing was redesigned: 'Batches per hour' replaces 'Connections per hour'. Your saved preset's rate was reset to the default (2 batches/hour). Adjust if needed.";
      const main = document.querySelector('.main .container') || document.querySelector('main') || document.body;
      main.insertBefore(banner, main.firstChild);
    }
    banner.style.display = 'block';
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 20000);
  } else {
    setV('rate-per-hour', config.batchesPerHour ?? config.ratePerHour ?? 2);
  }
  setV('daily-limit', config.dailyLimit ?? 40);
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
window.copyServerLog = copyServerLog;
window.deleteSelectedTemplate = deleteSelectedTemplate;
window.deselectAll = deselectAll;
window.downloadCsv = downloadCsv;
window.filterProfiles = filterProfiles;
window.handlePreviewClick = handlePreviewClick;
window.loadLastUsedPreset = loadLastUsedPreset;
window.loadProfiles = loadProfiles;
window.loadSelectedTemplate = loadSelectedTemplate;
window.modeStep = modeStep;
window.onModeChange = onModeChange;
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
window.toggleSection = toggleSection;
window.toggleServerLog = toggleServerLog;
window.togglePresetPopover = togglePresetPopover;
window.updateCampaignSummary = updateCampaignSummary;
