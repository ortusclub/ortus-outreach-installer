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
import { computePillState, shouldShowConsole } from '/js/live-console.mjs';
import { usesMonitoringCadence } from '/js/campaign-modes.mjs';
import { buildLiveActivity } from '/js/live-activity.mjs';
import { validatePrimaryUrl } from '/js/primary-url-validation.mjs';
import { shouldShowNoteHint } from '/js/note-hint.mjs';
import { summarizeUpdateError } from '/js/update-error.mjs';
import { classifyAccountFlag, summarizeSelection, classifyAccountState, isRestrictedStatus, isHiddenSection, lookupSoO, isBreakdownMode, classifyAccountChannels, breakdownAssignee } from '/js/account-guardrails.mjs';

// Floating live console — state used by renderLiveConsole(). The previous
// running flag is needed to detect the running → idle transition that
// resets the expanded-state localStorage flag (see Task 7).
let _lcPrevRunning = false;
let _lcWriteCache = {};
let selectedProfileIds = [];
let selectedProfileNames = {};
let allProfilesData = [];
// v2.78: accounts pre-benched in the wizard — selected but start the campaign
// out of the rotation (translated to campaign._skippedProfiles on launch).
let benchedProfileIds = new Set();
// Task 6: multi-tab lead-source guard state
window._chosenSheetGid = '';      // gid of the operator's chosen tab
window._tabsData = [];            // full tab list from last /api/sheet/tabs call
window._tabPickerMulti = false;   // true when workbook has >1 tabs
window._tabLeadOk = true;         // true when chosen tab passes lead-look check
window._savedSheetGid = '';       // gid from the history entry on a rerun — used by the tab-change modal
// #8: store-sourced primary status for the account picker (CC+IC mode).
// Populated by loadPrimaryStatusForPicker() before renderProfiles() renders.
let primaryStatusCache = { key: '', statuses: {} };
async function loadPrimaryStatusForPicker() {
  const url = (document.getElementById('primary-person-url')?.value || '').trim();
  const mode = document.getElementById('campaign-mode')?.value || '';
  if (mode !== 'connect_and_introduce' || !url) { primaryStatusCache = { key: '', statuses: {} }; return; }
  try {
    const r = await fetch('/api/primary-status?primaryUrl=' + encodeURIComponent(url));
    primaryStatusCache = await r.json();
  } catch { primaryStatusCache = { key: '', statuses: {} }; }
}

// ─────────────────────────────────────────────────────────────────────────
// Draft state: activeDraftId is the single source of truth for which draft
// the wizard is currently editing. Set by startNewCampaign(), editDraft(),
// or by clicking the resume pill. Cleared by launching the draft (via
// /api/campaign/queue-only) or by explicit cancel.
//
// 2026-05-27 (drafts-isolation): replaces the brittle `currentDraftIsNew`
// localStorage flag that conflated "is this a new draft?" with "should
// save create a row?". The legacy `currentDraftId` key is still written
// alongside for back-compat with code paths that read it directly (sync
// helpers, edit/delete confirmations, etc.) — both are kept in lock-step
// by the helpers below.
// ─────────────────────────────────────────────────────────────────────────
const ACTIVE_DRAFT_KEY = 'ortus.activeDraftId';

function getActiveDraftId() {
  try {
    // Prefer the new key; fall back to the legacy `currentDraftId` so any
    // residual state from a pre-refactor session still resolves.
    return localStorage.getItem(ACTIVE_DRAFT_KEY)
      || localStorage.getItem('currentDraftId')
      || null;
  } catch { return null; }
}

function setActiveDraftId(id) {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_DRAFT_KEY, id);
      localStorage.setItem('currentDraftId', id); // back-compat mirror
    } else {
      localStorage.removeItem(ACTIVE_DRAFT_KEY);
      localStorage.removeItem('currentDraftId');
    }
  } catch {}
}

function clearActiveDraft() { setActiveDraftId(null); }

// True when the wizard route is showing a campaign that is NOT the currently
// running one — used to blank the live status / log / right-pane / runbar
// identity / button state so the running campaign's data doesn't bleed in.
// True whenever there's an active draft in the wizard (new or loaded). The
// running campaign's own Edit button (from the Active tab) clears the
// active-draft id before navigating so this returns false there and the
// live data shows through. Phase 6.1 of the parallel-campaigns refactor
// replaces this heuristic with proper id comparison once the registry
// tracks per-campaign run state.
function isOnNewCampaignView() {
  try {
    if (typeof location === 'undefined' || location.hash !== '#/new') return false;
    return !!getActiveDraftId();
  } catch { return false; }
}
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
  primaryIntroBody: 'Intro DM Body',
  ccDmBody: 'Post-acceptance DM',
};

// Collects the same form state that startCampaign() sends to /api/campaign/start.
// Mirrors app.js:1122-1185 so the server-side normalization works identically.
function gatherCampaignFormState() {
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  const linkedinColumn = document.getElementById('linkedin-col-select')?.value || '';
  const mode = document.getElementById('campaign-mode').value;
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';

  // v2.59.x — Per-mode preview suppression. Both intro flows (IC and
  // CC+IC) do NOT use tpl-followup in their actual UI; surfacing leftover
  // Follow-up Message text in the preview confused operators about what
  // gets sent. For IC the body comes from primary-intro-body (with tpl-
  // followup fallback); for CC+IC the body also comes from primary-intro-
  // body (sent post-acceptance via runAutoIntros).
  const _isIc   = mode === 'introduce_back';
  const _isCcIc = mode === 'connect_and_introduce';
  const _isCcDm = mode === 'connect_and_message';
  const _isIntroFlow = _isIc || _isCcIc;
  const _tplFollow = document.getElementById('tpl-followup').value;
  const _primaryIntro = document.getElementById('primary-intro-body')?.value || '';
  const _icResolvedBody = _primaryIntro || _tplFollow; // mirror startCampaign:2668

  const templates = {
    // v2.59: drop addNoteOn gate — textarea value IS the note.
    connectionNote: document.getElementById('tpl-note').value,
    // Intro flows suppress Follow-up Message because the body is shown
    // separately as Intro DM Body. Other modes pass tpl-followup through.
    followUp1: _isIntroFlow ? '' : _tplFollow,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
    // 2.8.50: Introduction Messages sub-mode of message_only
    // v2.11.13: read from introModeActive (in-memory) instead of localStorage
    // because Chrome enterprise/privacy enforcement can block storage reads.
    introMode: _isIc,
    introName: document.getElementById('intro-name')?.value?.trim() || '',
    // v2.13.x — Group conversation title is an intro-flow field only. Without
    // this gate it was sent (and previewed) in every mode — even falling back
    // to the hardcoded default — so CC+DM showed a phantom "Group conversation
    // title" with {first name}/{intro name} warnings. Mirror the primary-* gating.
    introTitle: _isIntroFlow
      ? (document.getElementById('intro-title')?.value || 'Introduction: {first name} <> {intro name}')
      : '',
    // For IC, send the resolved body (primary-intro-body OR tpl-followup
    // fallback). For CC+IC and any other mode that uses it, send the raw
    // primary-intro-body value.
    // v2.59.2: CC+DM never uses primary/intro fields — blank them so a
    // leftover CC+IC config can't leak "Antonio Varlese" into the DM run's
    // campaign.templates (which the bulk-check path read to send an IC).
    primaryIntroBody: _isIc ? _icResolvedBody : (_isCcDm ? '' : _primaryIntro),
    // v2.59.x — Route the right name into templates.primaryName based on
    // mode so primary-* token substitution matches what outreach.js does
    // at send time. In IC mode the operator fills `intro-name` (Sam Adcock);
    // in CC+IC they fill `primary-person-name`. The chip vocabulary is the
    // same in both modes ({primary first name}, etc.) so we just route the
    // active source. Prevents stale leftover values from one mode leaking
    // into the other's preview.
    primaryName: _isIc
      ? (document.getElementById('intro-name')?.value?.trim() || '')
      : (_isCcDm ? '' : (document.getElementById('primary-person-name')?.value?.trim() || '')),
    primaryUrl:  (_isIc || _isCcDm)
      ? ''
      : (document.getElementById('primary-person-url')?.value?.trim() || ''),
    // v2.91: CC+IC auto-accept + automated first follow-up. DOM-read, gated to
    // intro flows so leftover CC+IC config can't leak into other modes.
    autoAcceptPrimary: _isIntroFlow ? !!document.getElementById('auto-accept-toggle')?.checked : false,
    autoAcceptAllPending: _isIntroFlow ? !!document.getElementById('auto-accept-all-toggle')?.checked : false,
    followUpEnabled: _isIntroFlow ? !!document.getElementById('follow-up-toggle')?.checked : false,
    followUpBody: _isIntroFlow ? (document.getElementById('follow-up-body')?.value || '') : '',
    followUpDelayMinutes: _isIntroFlow ? (Number(document.getElementById('follow-up-delay')?.value) || 10) : 10,
    primarySource: _isIntroFlow ? readPrimarySource() : 'local-browser',
    // v2.62: CC+DM post-acceptance body. Only meaningful when
    // mode === 'connect_and_message'; campaign.js reads templates.ccDmBody
    // from runAutoDms. Other modes ignore it.
    ccDmBody: document.getElementById('tpl-cc-dm-body')?.value || '',
  };

  const senderFirstNames = {};
  for (const id of selectedProfileIds) {
    const pName = selectedProfileNames[id] || id;
    senderFirstNames[id] = resolveSenderFirstName(id, pName);
  }

  // v2.59.x — Send mode + senderColumn so the backend preview can do per-
  // row sender lookups for IC and message_only (where the sender comes
  // from the sheet, not the wizard's profile picker). senderColumn mirrors
  // startCampaign's IC-only override at app.js:2708-2710.
  // v2.61: Extended to message_only (Direct Messages) — same #ic-extras
  // sender-column dropdown is shared.
  const senderColumn = (mode === 'introduce_back' || mode === 'message_only')
    ? (document.getElementById('ic-sender-col-select')?.value || '')
    : '';

  return {
    sheetUrl,
    linkedinColumn,
    templates,
    profileIds: [...selectedProfileIds],
    benchedProfileIds: [...benchedProfileIds].filter((id) => selectedProfileIds.includes(id)),
    senderFirstNames,
    mode,
    senderColumn,
  };
}

function refreshPreviewButtonState() {
  // Bug 6: the Preview button is ALWAYS enabled now. The old enable/disable
  // gating (on sheet URL + which template fields had content) was a recurring
  // source of "locked until you type X" bugs across modes. Instead the button
  // is always clickable and handlePreviewClick() shows a friendly message in
  // the modal when there's nothing to render yet.
  const btn = document.getElementById('btn-preview-messages');
  if (!btn) return;
  btn.disabled = false;
  btn.title = 'Render your templates against sample rows from the sheet';
}

async function handlePreviewClick() {
  const btn = document.getElementById('btn-preview-messages');
  if (!btn) return;
  // Always openable. Need a sheet to render against real rows — if it's missing,
  // open the modal with guidance instead of silently doing nothing.
  const sheetUrl = document.getElementById('sheet-url')?.value?.trim() || '';
  if (!sheetUrl) {
    renderPreviewModal([], 'Enter a Google Sheet URL first — the preview renders your templates against real rows from your sheet.');
    return;
  }

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
    // v2.59.x — IC / CC+IC fields. Without these, typing into Intro DM Body
    // didn't update the Preview button state until something else (mode
    // change, etc.) re-ran refreshPreviewButtonState.
    'primary-intro-body', 'intro-title',
    // v2.59.8 — CC+DM post-acceptance DM body. Its own oninput= calls
    // saveCcDmFields (not refreshPreviewButtonState), so without this the
    // Preview button wouldn't re-enable live as the operator typed the DM.
    'tpl-cc-dm-body',
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
  // v2.86.1 (port): explicit request to see the log — reveal Live Status even
  // when idle, then scroll to it. Without forcing, scrollToSection targets a
  // display:none element and nothing happens.
  liveStatusForcedOpen = true;
  try { syncLiveStatusVisibility(); } catch (_) { /* */ }
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
// v2.102.0: GoLogin can hold more than one profile with the same login email (a
// profile got duplicated). The picker keys accounts by name (= email), so the
// duplicate shows as two identical cards while SoO has a single row (Sam:
// "two of this guy, only one in SoO"). Keep the first profile per email, hide
// the rest from the picker, and tag the survivor with how many we hid so the
// card can flag it — auto-hidden, but not silently (clean up in GoLogin).
function dedupeProfilesByEmail(profiles) {
  const seen = new Map();   // emailKey -> kept profile
  const hidden = new Map(); // emailKey -> count hidden
  const out = [];
  for (const p of (profiles || [])) {
    const key = ((p && p.name) || '').toLowerCase().trim();
    if (!key) { out.push(p); continue; }                 // unnamed → never dedupe away
    if (seen.has(key)) { hidden.set(key, (hidden.get(key) || 0) + 1); continue; }
    seen.set(key, p);
    out.push(p);
  }
  for (const p of out) {
    const key = ((p && p.name) || '').toLowerCase().trim();
    if (hidden.has(key)) p._dupHidden = hidden.get(key);
  }
  return out;
}

// v2.102.0: isRestrictedStatus moved to account-guardrails.mjs (imported above).
// SoO column B "Status" — block accounts the SoO marks unusable.
// Restricted dropdown values: "Identity Restricted", "Identity Restricted II",
// "Unjust Identity Restricted", "Hard Identity Restricted" (all contain
// "restricted"); "Inaccessible" is also unusable. Active/Construction/Rented/?
// stay selectable. getSoO returns every column raw, so soo['Status'] is present.

// v2.102.0: at least one channel (OP/InMail/SN/CC) currently shows 'available'.
function hasAvailableChannel(soo) {
  if (!soo) return false;
  return [soo.linkedinCredits, soo.inmailCredits, soo.salesNavCredits, soo.ccCredits]
    .some((v) => (v || '').toString().toLowerCase().trim() === 'available');
}

// v2.102.0: "Available now" preset = ready to use right now — NOT restricted/
// inaccessible AND has at least one free channel.
function isAvailableNow(soo) {
  if (!soo) return false;
  return !isRestrictedStatus(soo['Status'] || soo['status']) && hasAvailableChannel(soo);
}

function findSoOForProfile(profileName) {
  if (!profileName || Object.keys(sooData).length === 0) return null;
  // lookupSoO matches the bare email first, then the email embedded in a
  // decorated GoLogin name (e.g. "ryan.ceballo@ortus.solutions [1]"). Exact
  // string match alone left those accounts showing FREE.
  return lookupSoO(sooData, profileName);
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
    const cls = info.active ? ' class="passover-active"' : ' class="passover-closed"';
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

  // v2.112.10 (Window C): big banner at the top of section 3. Pull the day
  // count out of the label (e.g. "ACTIVE — closes in 12d" / "in 4d" → "12d"),
  // falling back to the raw label if no digit-d match. State = ● Active/Closed
  // with a green/gray class.
  const days = (label) => {
    const m = String(label || '').match(/(\d+d)/);
    return m ? m[1] : (label || '—');
  };
  // Phase-aware: an "active" window = post-passover (accounts not yet used are
  // AVAILABLE/green for everyone); an "inactive" window = start of the cycle
  // (accounts are locked to their assignees, ASSIGNED/blue). The note says the
  // NEXT change, not a misleading "Resets <day>".
  const setBannerWindow = (info, daysId, stateId, noteId, freeDay, lockDay) => {
    const daysEl = document.getElementById(daysId);
    const stateEl = document.getElementById(stateId);
    const noteEl = document.getElementById(noteId);
    if (daysEl) daysEl.textContent = days(info.label);
    if (stateEl) {
      stateEl.textContent = info.active ? 'Available' : 'Assigned';
      stateEl.className = 'acct-cd-s ' + (info.active ? 'pass-on' : 'pass-assigned');
    }
    if (noteEl) noteEl.textContent = info.active ? ('Re-locks ' + lockDay) : ('Frees ' + freeDay);
  };
  setBannerWindow(monthly, 'pass-monthly-days', 'pass-monthly-state', 'pass-monthly-note', 'the 16th', 'the 1st');
  setBannerWindow(cc, 'pass-cc-days', 'pass-cc-state', 'pass-cc-note', 'Thursday', 'Monday');
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
    allProfilesData = dedupeProfilesByEmail(profiles);
    loading.classList.add('hidden');
    grid.classList.remove('hidden');
    await loadPrimaryStatusForPicker();
    renderProfiles(allProfilesData);
    renderPassoverBanner();
    updateChipCounts();

    // SoO loads in background — re-render profiles + refresh counts when it arrives
    loadSoOStatus().then(() => {
      if (Object.keys(sooData).length > 0) renderProfiles(allProfilesData);
      // v2.94.x: also refresh the primary-source picker + read-only labels so a
      // restored GoLogin primary shows its badges/name once SoO arrives.
      if (typeof renderPrimarySourcePicker === 'function') renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
      if (typeof refreshPrimarySourceLabels === 'function') refreshPrimarySourceLabels();
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
      // The Local Browser counts as an account toward the 2+-account parallel
      // unlock and the throughput math — recompute, matching the GoLogin handler.
      updateCampaignSummary();
    });
    localHost.appendChild(localItem);
  }

  // v2.112.10 (Window C, free-first): compute each profile's state ONCE so we can
  // both sort (usable accounts first) and render from the same value. State comes
  // only from classifyAccountState (SoO) — no invented status.
  const _mode = document.getElementById('campaign-mode')?.value || '';
  const _passover = getPassoverStatus();
  const _meId = getMyIdentifier();
  // Breakdown modes (Message Campaign / Direct Messages / InMail Only) don't use
  // CC, so the tile shows every non-CC channel divided; all other modes collapse
  // to one CC/credit verdict (the two-zone tile).
  const _breakdown = isBreakdownMode(_mode);
  const _RANK = { 'free': 0, 'assigned': 1, 'in-use': 2, 'blocked': 3 };
  // Accounts under the SoO "Construction" section never show in the launcher.
  // SoO loads after the first render, so pre-SoO these can't be identified yet;
  // the post-SoO re-render (loadProfiles) drops them once their section is known.
  const _visible = profiles.filter((p) => !isHiddenSection(findSoOForProfile(p.name)));
  const _ordered = _visible
    .map((p, i) => {
      const soo = findSoOForProfile(p.name);
      if (_breakdown) {
        const br = classifyAccountChannels(soo);
        // free-first: usable (0) → has-status-but-none-free (1) → blocked (2).
        return { p, i, soo, br, rank: br.blocked ? 2 : (br.anyFree ? 0 : 1) };
      }
      const st = classifyAccountState(soo, _meId, _mode, _passover);
      return { p, i, soo, st, rank: (_RANK[st.state] ?? 9) };
    })
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i)); // stable within rank

  _ordered.forEach(({ p, soo: _soo, st: _state, br: _br }) => {
    // 'blocked' / unusable is never selectable (greyed + disabled). Single-verdict
    // modes: blocked when classifyAccountState says so (restricted, or the CC/credit
    // column is NA/Used/etc.). Breakdown modes: blocked when restricted OR no channel
    // is Available (nothing usable for this campaign right now).
    const _locked = _breakdown ? (_br.blocked || !_br.anyActive) : (_state.state === 'blocked');
    // Defensive: a restored preset/schedule must not keep a now-unusable account
    // selected — drop it (before building the tile so `checked` reflects reality).
    if (_locked && selectedProfileIds.includes(p.id)) {
      selectedProfileIds = selectedProfileIds.filter(id => id !== p.id);
      delete selectedProfileNames[p.id];
    }
    if (selectedProfileIds.includes(p.id)) selectedProfileNames[p.id] = p.name;
    const _checked = selectedProfileIds.includes(p.id) ? 'checked' : '';
    const _disabled = _locked ? 'disabled' : '';
    const _dup = p._dupHidden ? ` <span class="dup-flag" title="${escHtml(p._dupHidden + ' other GoLogin profile(s) share this email — hidden here. Delete the duplicate(s) in GoLogin.')}">⚠ dup</span>` : '';

    let _classes, _inner;
    if (_breakdown) {
      // Variant C — clean per-channel breakdown: thin accent (green if any channel
      // free) + email + a 3-cell row showing each channel's RAW SoO status verbatim.
      const _cells = (_br.channels || []).map((c) => {
        const v = (c.status || '').toLowerCase().trim();
        const dot = v === 'available' ? 'd-avail'
          : v === 'in use' ? 'd-inuse'
          : (v === 'na' || v === 'n/a' || v.includes('inaccessible')) ? 'd-na'
          : 'd-spent'; // used / - / blank / other
        // Operator preference: don't print the verbose "Partial Inaccessible" —
        // show it as NA (it can't be accessed). Everything else shown verbatim.
        const txt = /inaccessible/i.test(c.status) ? 'NA' : (c.status ? escHtml(c.status) : '—');
        const who = c.who ? ' · ' + escHtml(c.who) : '';
        const title = c.who ? `In use by ${escHtml(c.who)}` : txt;
        return `<div class="brk-col"><div class="brk-k">${escHtml(c.label)}</div>`
          + `<div class="brk-v" title="${title}"><i class="brk-vdot ${dot}"></i><span class="brk-vt">${txt}${who}</span></div></div>`;
      }).join('');
      // locked (no credits anywhere) → heavy mute; selectable-but-no-free-channel
      // (all In Use) → light mute, like a busy Connect tile; has a free channel → full.
      _classes = 'profile-item jt jt-brk'
        + (_checked ? ' selected' : '')
        + (_locked ? ' muted' : (!_br.anyFree ? ' muted-soft' : ''))
        + (_br.blocked ? ' is-restricted' : '');
      // Accent (left "lip") reflects the best channel: green if any Available,
      // else gold if any In Use (even alongside reds), grey only when nothing's active.
      const _accent = _br.anyFree ? ' free' : (_br.anyActive ? ' busy' : '');
      // Owner pill (V1): the account is locked to its SoO Assignee for the monthly
      // cycle (only they should use it until passover frees it on the 16th).
      const _asg = breakdownAssignee(_soo, _meId, _passover);
      const _asgPill = _asg ? `<span class="asg-tag" title="Assigned to ${escHtml(_asg)} until the 16th">\u{1F512} ${escHtml(_asg)}</span>` : '';
      _inner = `
      <div class="brk-accent${_accent}"></div>
      <div class="jt-det">
        <div class="jt-top">
          <input type="checkbox" value="${p.id}" ${_checked} ${_disabled} />
          <span class="jt-email">${escHtml(p.name)}${_dup}</span>${_asgPill}
        </div>
        <div class="brk-grid">${_cells}</div>
      </div>`;
    } else {
      // Two-zone tile: classifyAccountState collapses SoO assignee + status +
      // live-use + passover into one of four states; tinted stat zone + one sub line.
      const _SMAP = {
        'free':     { cls: 'free',     word: 'FREE' },
        'assigned': { cls: 'assigned', word: 'ASSIGNED' },
        'in-use':   { cls: 'inuse',    word: 'IN USE' },
        'blocked':  { cls: 'stop',     word: 'BLOCKED' },
      };
      const _sm = _SMAP[_state.state] || _SMAP.free;
      // 'blocked' worded from what the SoO actually says (no invented copy):
      //   restricted → LinkedIn block · na → CC/credit = NA · unavailable → Used/-/Partial.
      const _reason = (_state.state === 'blocked') ? (_state.reason || 'restricted') : '';
      const _label = escHtml(_state.label || '');
      const _word = (_reason === 'na' || _reason === 'unavailable') ? 'N/A' : _sm.word;
      let _sub;
      // v2.112.27: operator asked to drop "who uses who" from the picker for now —
      // show bare states (the who is still in classifyAccountState/the log if needed).
      if (_state.state === 'assigned') _sub = 'Assigned.';
      else if (_state.state === 'in-use') _sub = 'In use.';
      else if (_state.state === 'blocked') {
        if (_reason === 'na') _sub = 'No credits for this campaign.';
        else if (_reason === 'unavailable') _sub = _label ? `Not available — <b>${_label}</b>.` : 'Not available for this campaign.';
        else _sub = 'Restricted by LinkedIn.';
      } else _sub = 'Anyone can use.';
      _classes = 'profile-item jt ' + _state.state
        + (_checked ? ' selected' : '')
        + (_state.state === 'in-use' ? ' muted-soft' : '')
        + (_locked ? ' muted is-restricted' : '');
      _inner = `
      <div class="jt-stat s-${_sm.cls}">
        <span class="jt-dot"></span>
        <span class="jt-word">${_word}</span>
      </div>
      <div class="jt-det">
        <div class="jt-top">
          <input type="checkbox" value="${p.id}" ${_checked} ${_disabled} />
          <span class="jt-email">${escHtml(p.name)}${_dup}</span>
        </div>
        <div class="jt-sub">${_sub}</div>
      </div>`;
    }

    const item = document.createElement('label');
    item.className = _classes;
    item.dataset.profileId = p.id;
    item.innerHTML = _inner;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (_locked) { cb.checked = false; return; } // blocked / NA — never selectable
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
    // v2.78: bench toggle — a benched account is still selected but starts the
    // campaign out of the rotation (you can un-bench it live mid-run).
    const benched = benchedProfileIds.has(id);
    const benchBtn = `<button type="button" class="bench-btn ${benched ? 'is-benched' : ''}" onclick="toggleBenchProfile('${id}')" title="${benched ? 'Benched — will start out of the rotation. Click to include.' : 'Active — click to bench (start this account out of the rotation).'}">${benched ? 'Benched' : 'Active'}</button>`;
    return `<div class="selected-item${benched ? ' is-benched' : ''}">
      <span class="order">${i + 1}</span>
      <span class="name">${escHtml(name)}</span>
      ${senderTag}
      ${benchBtn}
      <button class="btn-remove" onclick="removeProfile('${id}')" title="Remove">&times;</button>
    </div>`;
  }).join('');

  // v3.0: keep Post Amp engagement table in sync with profile selection.
  if (typeof renderPostAmpEngagementTable === 'function') {
    renderPostAmpEngagementTable();
  }

  // v2.112 (#5): refresh aggregate guardrail alert on every selection change.
  renderGuardrailAlert();
}

// v2.112 (#5): aggregate guardrail alert — from the currently-SELECTED accounts only.
function renderGuardrailAlert() {
  const el = document.getElementById('guardrail-alert');
  if (!el) return;
  const selected = (selectedProfileIds || []).map(id => {
    const name = selectedProfileNames[id] || id;
    return { email: name, soo: findSoOForProfile(name) };
  });
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';
  const s = summarizeSelection(selected, getMyIdentifier(), mode, getPassoverStatus());
  if (!s.hasWarnings) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const bits = [];
  if (s.flagged.length) bits.push(`<b>${s.flagged.length} of your selected accounts are assigned to / in use</b>`);
  if (s.passover) bits.push(`this campaign's <b>${s.passover.channel === 'cc' ? 'CC' : 'monthly'} credits are in passover (${escHtml(s.passover.label)})</b>`);
  el.innerHTML = `<span class="big">⚠</span><span class="txt">${bits.join(', and ')}.</span>`;
  el.classList.remove('hidden');
}

function toggleBenchProfile(id) {
  if (benchedProfileIds.has(id)) benchedProfileIds.delete(id);
  else benchedProfileIds.add(id);
  renderSelectedPanel();
}
window.toggleBenchProfile = toggleBenchProfile;

function removeProfile(id) {
  selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
  delete selectedProfileNames[id];
  benchedProfileIds.delete(id);
  const cb = document.querySelector(`#profiles-grid input[value="${id}"]`);
  if (cb) { cb.checked = false; cb.closest('.profile-item')?.classList.remove('selected'); }
  renderSelectedPanel();
  // Recompute throughput + the 2+-account parallel unlock — removing via the X
  // chip changes the account count just like unticking the checkbox does.
  if (typeof updateCampaignSummary === 'function') updateCampaignSummary();
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
  if (preset === 'available-now') return isAvailableNow(soo);
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
  // Construction-section accounts are hidden from the grid, so they must not be
  // counted here either — otherwise the totals/pills wouldn't match what's shown.
  const visibleProfiles = allProfilesData.filter((p) => !isHiddenSection(findSoOForProfile(p.name)));
  const counts = { all: visibleProfiles.length, available: 0, 'in-use': 0, selected: selectedProfileIds.length };
  const me = getMyIdentifier();
  let assignedToMeCount = 0, poolCount = 0, availableNowCount = 0;
  visibleProfiles.forEach((p) => {
    const soo = findSoOForProfile(p.name);
    if (!soo) return;
    const vals = [soo.linkedinCredits, soo.inmailCredits, soo.salesNavCredits, soo.ccCredits].map((v) => (v || '').toLowerCase());
    if (vals.some((v) => v === 'available')) counts.available++;
    if (vals.some((v) => v === 'in use' || v === 'in-use' || v === 'used')) counts['in-use']++;
    if (isAvailableNow(soo)) availableNowCount++;
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
  set('preset-count-available-now', availableNowCount);
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
// v2.59: live char counter under the Connection Note textarea so the
// operator can see how close they are to LinkedIn's 300-char cap. Goes
// red at 280+ as a soft warning. Idempotent — safe to call on init.
function updateTplNoteCount() {
  const ta = document.getElementById('tpl-note');
  const out = document.getElementById('tpl-note-count');
  if (!ta || !out) return;
  const n = (ta.value || '').length;
  out.textContent = `${n} / 300`;
  out.style.color = n >= 280 ? '#dc2626' : 'var(--gray)';
  const hint = document.getElementById('tpl-note-hint');
  if (hint) hint.classList.toggle('hidden', !shouldShowNoteHint(ta.value || ''));
}
window.updateTplNoteCount = updateTplNoteCount;
document.addEventListener('DOMContentLoaded', updateTplNoteCount);
if (document.readyState !== 'loading') updateTplNoteCount();

function applyTemplateUIVisibility(_mode, _addNoteOn) {
  // v2.59: template-bar (Select/Save/Create New/Delete) stays hidden — the
  // reusable-template save/load system isn't needed for the current
  // CC+IB / IC flow.
  // v2.62: Preview Messages button is back, surfaced in the visible
  // .tpl-cta-row at the top of Section 5. Visibility is no longer forced
  // here — refreshPreviewButtonState manages disabled state based on
  // sheet URL + template presence.
  const tplBar = document.getElementById('template-bar');
  if (tplBar) tplBar.style.display = 'none';
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

// v2.102.0: the v2.101 CC+IC connection-note OFF-by-default toggle was removed
// (band-aid for the wrong-person incident, now fixed by the pre-send identity
// gate). The note is a plain always-visible field again for every connect mode.

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
  // v2.58.x — Show the Intro DM Body section for IC too (was CC+IC only).
  // IC now uses the same template section as CC+IC for the body: Title
  // appears first, Body second — matching CC+IC's order exactly.
  if (intro) intro.style.display = (mode === 'connect_and_introduce' || mode === 'introduce_back') ? '' : 'none';
  if (primaryBlock) primaryBlock.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
  // v2.91: Auto-accept + automated first follow-up cards are CC+IC-only —
  // same predicate as the primary-person block so they appear/disappear together.
  const _showCcIcCards = (mode === 'connect_and_introduce');
  const autoAcceptBlock = document.getElementById('auto-accept-block');
  if (autoAcceptBlock) autoAcceptBlock.style.display = _showCcIcCards ? '' : 'none';
  const followUpBlock = document.getElementById('follow-up-block');
  if (followUpBlock) followUpBlock.style.display = _showCcIcCards ? '' : 'none';
  // When the CC+IC section becomes visible, sync the gate (URL may already be set)
  // and the follow-up fields' visibility against the current toggle state.
  if (_showCcIcCards) {
    try { if (typeof refreshAutoAcceptGate === 'function') refreshAutoAcceptGate(); } catch (_) {}
  }
  // v2.91: run toggleFollowUpFields on EVERY mode change (not only CC+IC) so
  // the Section-5 message editor hides when leaving CC+IC. It reads the toggle
  // + mode and hides appropriately, so it's safe in any mode.
  try { if (typeof toggleFollowUpFields === 'function') toggleFollowUpFields(); } catch (_) {}
  // v2.91: two flex columns. Left (primary + follow-up) only for CC+IC; the
  // right column spans full width when the left is hidden (e.g. CC+DM shows
  // only the cadence card).
  const _ccic = (mode === 'connect_and_introduce');
  const _colLeft = document.getElementById('intro-config-col-left');
  const _colRight = document.getElementById('intro-config-col-right');
  if (_colLeft) _colLeft.style.display = _ccic ? '' : 'none';
  if (_colRight) _colRight.style.gridColumn = _ccic ? '' : '1 / -1';
  const cadenceBlock = document.getElementById('check-cadence-block');
  // Cadence applies to every monitoring mode (CC+IC + CC+DM). Same predicate
  // drives the launch payload read so visibility and persistence stay in lockstep.
  if (cadenceBlock) cadenceBlock.style.display = usesMonitoringCadence(mode) ? '' : 'none';
  // #7: Primary check timing — lives inside primary-person-block; block visibility
  // already handles show/hide via _ccic above, so no separate hidden toggle needed.
  // v2.62: hide the 2-up row wrapper too when neither child is visible —
  // otherwise its grid gap + top margin shows as an empty band. CC+DM has
  // no primary-person block (no intro) but DOES use the cadence block, so
  // the row stays visible for CC+DM too — the empty primary slot will be
  // hidden by primaryBlock's own display:none.
  const introRow = document.getElementById('intro-config-row');
  if (introRow) introRow.style.display = usesMonitoringCadence(mode) ? '' : 'none';
  const introTitleBlock = document.getElementById('intro-title-block');
  if (introTitleBlock) introTitleBlock.style.display = (mode === 'connect_and_introduce' || mode === 'introduce_back') ? '' : 'none';
  // v2.62: CC+DM post-acceptance body — its own template section.
  const ccDmSection = document.getElementById('tpl-cc-dm-section');
  if (ccDmSection) ccDmSection.style.display = (mode === 'connect_and_message') ? '' : 'none';
  if (tplMgmt) tplMgmt.style.display = (mode === 'check_status') ? 'none' : '';

  // v2.14.x: variable chips are mode-aware (CC+IC hides {intro X},
  // IB hides {primary X}). Refresh on every mode change.
  try { updatePlaceholderTags(); } catch (_) {}

  // v2.58.x — IC-only sheet-mapping extras (sender column + "all connected"
  // toggle). Block lives inside the sheet preview, rendered by previewSheet.
  // Visibility is mode-gated here so it never appears for other campaigns.
  // v2.61: Direct Messages (message_only) shares the same extras block —
  // both modes need to pick a sender column (auto-routed per row).
  try {
    const icExtras = document.getElementById('ic-extras');
    if (icExtras) {
      const showExtras = (mode === 'introduce_back' || mode === 'message_only');
      icExtras.style.display = showExtras ? '' : 'none';
    }
    // v2.86.1 (port): Direct Messages shares #ic-extras for the sender-column
    // picker, but must NOT ask for an "Intro person" — that's an Introduction
    // Campaign concept. Hide just the intro-person card for everything except IC;
    // the sender column (rest of #ic-extras) stays for message_only.
    const introModeBlock = document.getElementById('intro-mode-block');
    if (introModeBlock) introModeBlock.style.display = (mode === 'introduce_back') ? '' : 'none';
  } catch (_) {}

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

  if (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message') {
    // v2.59: Yes/No toggle (templates-question) is hidden, so the
    // Connection Note section is always visible for connect modes.
    // Operator leaves the textarea empty if they don't want a note.
    connect.style.display = '';
  } else if (mode === 'message_only') {
    // Message Only: standalone follow-up DM, uses the Follow-up Message template.
    message.style.display = '';
  } else if (mode === 'introduce_back') {
    // v2.58.x — IC mirrors CC+IC's template UI: Group Conversation Title
    // first, Intro DM Body second (same `tpl-intro-section` / primary-intro-body
    // field that CC+IC uses). The Follow-up Message section stays hidden.
    // At submit time, primary-intro-body's value is routed to followUp1 so
    // the existing backend code path (templates.followUpMessage) is unchanged.
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
  const isConnectMode = (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message');
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
    // v2.57.7: only resets the section-5 Start button. The runbar's
    // Start button (#btn-start-rb) keeps its short label "Start" — it
    // lives in the tight grouped strip where "Start Campaign" wraps.
    const startMain = document.getElementById('btn-start');
    if (startMain) startMain.textContent = 'Start Campaign';
  }

  // Sales Nav Scrape — dispatched to the GKE engine, so it hides the entire
  // campaign apparatus (accounts, pace, templates, sheet, daily limit) and
  // shows its own self-contained panel wired to /api/scrape/*.
  const isScrape = (mode === 'sales_nav_scrape');
  const scrapePanel = document.getElementById('nav-scrape');
  const scrapeLaunch = document.getElementById('nav-scrape-launch');
  const navLaunch = document.getElementById('nav-launch');
  const runBar = document.getElementById('run-bar');
  if (scrapePanel) scrapePanel.style.display = isScrape ? '' : 'none';
  if (scrapeLaunch) scrapeLaunch.style.display = isScrape ? '' : 'none';
  if (isScrape) {
    // Scrape REUSES the standard multi-select account picker (section 3) — each
    // selected account scrapes one URL, in parallel. So keep nav-accounts
    // visible; hide only the campaign-loop apparatus.
    if (navAccounts) navAccounts.style.display = '';
    if (navPace) navPace.style.display = 'none';
    if (navTemplates) navTemplates.style.display = 'none';
    if (navSheet) navSheet.style.display = 'none';
    if (dailyKnob) dailyKnob.style.display = 'none';
    // A scrape isn't a campaign — hide the standard Launch block + run bar so
    // the dedicated Start Scrape controls are the only run path.
    if (navLaunch) navLaunch.style.display = 'none';
    if (runBar) runBar.style.display = 'none';
    // Live-refresh jobs + logs while viewing scrape mode.
    try { updateScrapePairing(); refreshScrapeConfigured(); startScrapePolling(); } catch (_) {}
    // First scrape view this session/draft: hide the engine's pre-existing jobs
    // (terminal ones) so a fresh draft starts clean. Re-armed by startNewCampaign.
    if (!_scrapeBaselineDone) { _scrapeBaselineDone = true; try { scrapeHidePriorJobs(true); } catch (_) {} }
  } else {
    if (navLaunch) navLaunch.style.display = '';
    if (runBar) runBar.style.display = '';
    try { stopScrapePolling(); } catch (_) {}
  }

  // Persist last-used mode
  try { localStorage.setItem('ortus-last-mode', mode); } catch (_) {}

  // Refresh labels + summary (swaps "connections" ↔ "messages" ↔ "checks")
  updateCampaignSummary();

  // Show message template when open profile toggle is checked
  updateOpenProfileVisibility();

  // Keep kinetic picker in sync
  renderModeSelector();

  // Mirror the new mode onto the launch pill so the operator sees their
  // selection without waiting for the autosave debounce.
  if (typeof window.updateEditingBanner === 'function') {
    try { window.updateEditingBanner(); } catch (_) {}
  }

  // v2.112 (#5): re-evaluate guardrail alert when mode changes (passover
  // channel is mode-dependent).
  renderGuardrailAlert();

  // #8: refresh store-sourced primary status when switching to/from CC+IC
  // so the picker rows update without requiring a full profile reload.
  // v2.112.19: account-tile states are mode-dependent (each mode reads its own
  // credit column), so the picker MUST re-render on every mode change. Do it now
  // — synchronously, and via filterProfiles() so the operator's active search /
  // filter is preserved (the old code re-rendered the FULL list, dropping it).
  // Re-run after the primary-status fetch resolves too (refreshes primary badges),
  // but don't depend on it: a slow/failed fetch must not leave stale tiles.
  const _reRenderPicker = () => {
    if (!Array.isArray(allProfilesData) || allProfilesData.length === 0) return;
    if (typeof filterProfiles === 'function') { try { filterProfiles(); return; } catch (_) { /* fall through */ } }
    renderProfiles(allProfilesData);
  };
  _reRenderPicker();
  loadPrimaryStatusForPicker().then(_reRenderPicker).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// Sales Nav Scrape — control panel for the GKE scraper engine.
// Dispatches jobs to /api/scrape/* (which proxy to the engine) and polls
// /api/scrape/jobs for live progress. No local browser, no campaign loop.
// ═══════════════════════════════════════════════════════════════════════════
let _scrapePollTimer = null;

// Sales-Nav status for a profile from the SoO, normalized to a CSS class.
// Scrape uses the SAME multi-select account picker as campaigns (section 3).
// The selected GoLogin accounts come from selectedProfileIds; we exclude the
// Local Browser (the engine drives GoLogin profiles only).
function scrapeSelectedAccounts() {
  return (selectedProfileIds || []).filter((id) => id && id !== 'local-browser');
}

function setScrapeStatus(msg) {
  const el = document.getElementById('scrape-status');
  if (el) el.textContent = msg;
}

// ── Dual input: type URLs, or load them from a pasted Google Sheet ──
// In 'sheet' mode the app reads the sheet and extracts the Sales Nav search
// URLs, then dispatches them as the SAME `searchUrls` — the engine is unchanged.
let scrapeInputMode = 'type';
// Sheet mode: [{ row, url }] for every sheet row that holds a Sales Nav search,
// plus the operator's row-range pick (e.g. "2-10, 13"). Blank pick = all rows.
let scrapeSheetItems = [];
let scrapeRowSpec = '';

// Parse a row spec like "2-10, 13, 15-17" into an ordered, de-duped list of row
// numbers, intersected with the rows we actually found (so junk/out-of-range
// numbers are ignored). Blank spec → every available row.
function parseScrapeRowSpec(spec, availableRows) {
  const available = new Set(availableRows);
  const s = (spec || '').trim();
  if (!s) return availableRows.slice();
  const picked = new Set();
  for (const tokenRaw of s.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const m = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let r = a; r <= b; r++) if (available.has(r)) picked.add(r);
    } else if (/^\d+$/.test(token)) {
      const r = parseInt(token, 10);
      if (available.has(r)) picked.add(r);
    }
  }
  // Preserve found order.
  return availableRows.filter((r) => picked.has(r));
}

// The rows currently selected by the spec (sheet mode).
function selectedScrapeRows() {
  return parseScrapeRowSpec(scrapeRowSpec, scrapeSheetItems.map((i) => i.row));
}

function getScrapeInputUrls() {
  if (scrapeInputMode === 'sheet') {
    const rows = new Set(selectedScrapeRows());
    return scrapeSheetItems.filter((i) => rows.has(i.row)).map((i) => i.url);
  }
  return (document.getElementById('scrape-urls')?.value || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

function setScrapeInputMode(mode) {
  scrapeInputMode = (mode === 'sheet') ? 'sheet' : 'type';
  const typeBox = document.getElementById('scrape-input-type');
  const sheetBox = document.getElementById('scrape-input-sheet');
  if (typeBox) typeBox.style.display = scrapeInputMode === 'type' ? '' : 'none';
  if (sheetBox) sheetBox.style.display = scrapeInputMode === 'sheet' ? '' : 'none';
  const tBtn = document.getElementById('scrape-seg-type');
  const sBtn = document.getElementById('scrape-seg-sheet');
  if (tBtn) tBtn.classList.toggle('is-active', scrapeInputMode === 'type');
  if (sBtn) sBtn.classList.toggle('is-active', scrapeInputMode === 'sheet');
  try { updateScrapePairing(); } catch (_) {}
}

async function loadScrapeUrlsFromSheet() {
  const sheetUrl = (document.getElementById('scrape-src-sheet')?.value || '').trim();
  const status = document.getElementById('scrape-src-status');
  const pick = document.getElementById('scrape-row-pick');
  const rowsInput = document.getElementById('scrape-rows');
  const setS = (m) => { if (status) status.textContent = m; };
  const hidePicker = () => { if (pick) pick.style.display = 'none'; };
  if (!sheetUrl) { setS('Paste a Google Sheet URL above, then click Load URLs.'); hidePicker(); return; }
  setS('Reading sheet…');
  try {
    const r = await fetch('/api/scrape/extract-urls?sheetUrl=' + encodeURIComponent(sheetUrl));
    const res = await r.json();
    if (res && res.error) { scrapeSheetItems = []; setS('Could not read sheet — ' + res.error); hidePicker(); }
    else {
      scrapeSheetItems = Array.isArray(res.items)
        ? res.items.filter((i) => i && i.row && i.url)
        : (Array.isArray(res.urls) ? res.urls.map((u, idx) => ({ row: idx + 2, url: u })) : []);
      if (!scrapeSheetItems.length) {
        setS('No Sales Nav search URLs found (looking for linkedin.com/sales/search/… in any cell).');
        hidePicker();
      } else {
        const rowNums = scrapeSheetItems.map((i) => i.row);
        const lo = Math.min(...rowNums), hi = Math.max(...rowNums);
        const span = lo === hi ? `row ${lo}` : `rows ${lo}–${hi}`;
        setS(`✓ Found ${scrapeSheetItems.length} Sales Nav search${scrapeSheetItems.length === 1 ? '' : 'es'} in ${span}.`);
        // Reveal the row-range picker, pre-filled with the full span (explicit,
        // editable — we don't silently assume all). Operator trims as needed.
        scrapeRowSpec = lo === hi ? String(lo) : `${lo}-${hi}`;
        if (rowsInput) rowsInput.value = scrapeRowSpec;
        if (pick) pick.style.display = '';
        onScrapeRowSpecChange();
      }
    }
  } catch (e) {
    scrapeSheetItems = [];
    setS('Could not read sheet — ' + e.message);
    hidePicker();
  }
  try { updateScrapePairing(); } catch (_) {}
}

// Operator edited the "which rows" field — recompute selection + summary.
function onScrapeRowSpecChange() {
  scrapeRowSpec = (document.getElementById('scrape-rows')?.value || '').trim();
  const summary = document.getElementById('scrape-row-summary');
  if (summary) {
    const sel = selectedScrapeRows().length;
    const total = scrapeSheetItems.length;
    summary.textContent = total
      ? `Scraping ${sel} of ${total} search${total === 1 ? '' : 'es'}${sel === 0 ? ' — no rows match; nothing will run.' : ''}`
      : '';
  }
  try { updateScrapePairing(); } catch (_) {}
}

// Live "N URLs × M accounts → N jobs" summary. Each URL is scraped by one
// account; when counts differ, accounts are assigned round-robin.
function updateScrapePairing() {
  const el = document.getElementById('scrape-pairing');
  const urls = getScrapeInputUrls();
  const accts = scrapeSelectedAccounts();
  const n = urls.length, m = accts.length;
  // Short word for the launch-card caption: sequential (1 account), parallel
  // (≥1 account each), or parallel + queue (more URLs than accounts).
  const mode = m <= 1 ? 'sequential' : (n <= m ? 'parallel' : 'parallel + queue');
  // Mirror the count into the launch card's big number + caption.
  const numEl = document.getElementById('scrape-launch-number');
  const capEl = document.getElementById('scrape-launch-caption');
  if (numEl) numEl.textContent = String(n || 0);
  if (capEl) capEl.textContent = `${n} URL${n === 1 ? '' : 's'} · ${m} account${m === 1 ? '' : 's'} · ${mode}`;
  // Variant B stat header — live URLs / Accounts / Jobs.
  const setStat = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = String(v); };
  setStat('scrape-stat-urls', n);
  setStat('scrape-stat-accounts', m);
  setStat('scrape-stat-jobs', n);
  const urlsSub = document.getElementById('scrape-stat-urls-sub');
  if (urlsSub) urlsSub.textContent = scrapeInputMode === 'sheet' ? 'from a sheet' : 'typed in';
  const jobsSub = document.getElementById('scrape-stat-jobs-sub');
  if (jobsSub) jobsSub.textContent = (n && m) ? mode : 'one job per URL';
  if (!el) return;
  if (!n && !m) {
    el.textContent = 'Add Sales Nav URL(s) above, then select GoLogin accounts in section 3 below — one account per URL runs them in parallel.';
    return;
  }
  if (!m) {
    el.textContent = `${n} URL${n === 1 ? '' : 's'} · now select GoLogin accounts in section 3 below (one account per URL to run them in parallel).`;
    return;
  }
  if (!n) {
    el.textContent = `${m} account${m === 1 ? '' : 's'} selected · add Sales Nav URL(s) above.`;
    return;
  }
  // Accurate run description based on the URL : account ratio.
  let desc;
  if (m === 1) {
    desc = `${n} URL${n === 1 ? '' : 's'} → ${n} job${n === 1 ? '' : 's'} on 1 account, run back-to-back (sequential).`;
  } else if (n <= m) {
    desc = `${n} URL${n === 1 ? '' : 's'} × ${m} accounts → ${n} job${n === 1 ? '' : 's'}, run in parallel (1 account each).`;
  } else {
    desc = `${n} URLs × ${m} accounts → ${n} jobs: ${m} run in parallel, the rest queue back-to-back per account.`;
  }
  el.textContent = desc;
}

let _scrapeEngineUrl = '';

async function refreshScrapeConfigured() {
  try {
    const r = await fetch('/api/health');
    const h = await r.json();
    const ok = !!h.scraperConfigured;
    _scrapeEngineUrl = (h.scraperEngineUrl || '').replace(/\/+$/, '');
    const note = document.getElementById('scrape-unconfigured');
    const startBtn = document.getElementById('btn-scrape-start');
    if (note) note.style.display = ok ? 'none' : '';
    if (startBtn) startBtn.disabled = !ok;
  } catch (_) { /* leave as-is */ }
}

// Per-job live View — opens a modal whose <img> points straight at
// /api/scrape/view/:jobId, an MJPEG (multipart/x-mixed-replace) screencast the
// engine streams via CDP. The browser renders it as live video natively — no
// polling, no frame handling here. The request rides the dashboard's own
// session (no token in the URL). Closing the modal clears src, which aborts the
// stream (the engine then stops the screencast). One viewer open at a time.
function openScrapeJobView(jobId, label) {
  closeScrapeJobView();
  const overlay = document.createElement('div');
  overlay.id = 'scrape-job-viewer';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px';
  const safeLabel = (label || jobId).replace(/</g, '&lt;');
  overlay.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;width:100%;max-width:1280px;margin-bottom:10px">' +
      '<span style="color:#fff;font-size:14px">👁 Live · ' + safeLabel + '</span>' +
      '<span id="scrape-jv-status" style="color:#9aa;font-size:12px">connecting…</span>' +
      '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="closeScrapeJobView()">✕ Close</button>' +
    '</div>' +
    '<div style="max-width:1280px;width:100%;background:#000;border:1px solid #333;border-radius:8px;overflow:hidden;min-height:200px;display:flex;align-items:center;justify-content:center">' +
      '<img id="scrape-jv-img" alt="live page" style="max-width:100%;max-height:78vh;display:block" />' +
    '</div>';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeScrapeJobView(); });
  document.body.appendChild(overlay);

  const img = document.getElementById('scrape-jv-img');
  const status = document.getElementById('scrape-jv-status');
  img.onload = () => { if (status) status.textContent = ''; };
  img.onerror = () => { if (status) status.textContent = 'stream ended — the job may have finished.'; };
  img.src = `/api/scrape/view/${encodeURIComponent(jobId)}`;
}
function closeScrapeJobView() {
  const img = document.getElementById('scrape-jv-img');
  if (img) img.src = ''; // aborts the MJPEG connection → engine stops the screencast
  const el = document.getElementById('scrape-job-viewer');
  if (el) el.remove();
}

async function startScrapeJob() {
  const sheetEl = document.getElementById('scrape-sheet');
  const urls = getScrapeInputUrls();
  const sheetUrl = (sheetEl?.value || '').trim();
  const accts = scrapeSelectedAccounts();
  const baseTab = (document.getElementById('scrape-tab')?.value || 'Results').trim();
  const slowMode = !!document.getElementById('scrape-slow')?.checked;
  // Diagnostic — shows in the in-app CONSOLE so we can see exactly what's missing.
  console.log('[scrape] Start clicked →', { mode: scrapeInputMode, urls: urls.length, hasSheet: !!sheetUrl, accounts: accts.length, sheetFieldFound: !!sheetEl });
  const toast = (m) => { try { showCampaignToast(m, 4000); } catch (_) { try { alert(m); } catch (_) {} } };
  if (!urls.length) {
    const msg = scrapeInputMode === 'sheet'
      ? 'Load a Google Sheet with Sales Nav search URLs (click Load URLs in section 2b).'
      : 'Paste at least one Sales Nav search URL.';
    setScrapeStatus(msg); toast('Scrape: ' + msg); return;
  }
  if (!sheetUrl) { setScrapeStatus('Enter a destination Google Sheet URL.'); toast('Scrape: enter a destination Google Sheet URL in section 2b.'); return; }
  if (!accts.length) {
    setScrapeStatus('⚠ No GoLogin accounts selected. Pick at least one in section 3 below — each URL is scraped by one account.');
    toast('Scrape: select at least one GoLogin account in section 3.');
    // Make the requirement impossible to miss: expand + scroll to the picker.
    const acc = document.getElementById('nav-accounts');
    if (acc) {
      acc.classList.remove('collapsed');
      acc.style.display = '';
      acc.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  // Fresh run — clear the previous run's logs and hide ALL prior jobs (every
  // state) so the card reflects ONLY this campaign.
  scrapeLogLines = [];
  scrapeLogSince = Date.now();
  try { renderScrapeLogPanel(); } catch (_) {}
  _scrapeBaselineDone = true;
  await scrapeHidePriorJobs(false);
  const _jel = document.getElementById('scrape-jobs');
  if (_jel) _jel.innerHTML = '<div class="scrape-job-empty">Starting…</div>';

  setScrapeStatus(`Starting ${urls.length} scrape job${urls.length === 1 ? '' : 's'}…`);
  toast(`Scrape: starting ${urls.length} job${urls.length === 1 ? '' : 's'} on ${accts.length} account${accts.length === 1 ? '' : 's'}…`);

  // Pair each URL with an account (round-robin when counts differ); each pair
  // is its own single-URL job so the engine runs them concurrently — one
  // browser per profile.
  let started = 0;
  const errors = [];
  for (let i = 0; i < urls.length; i++) {
    const profileId = accts[i % accts.length];
    const tabName = urls.length > 1 ? `${baseTab} ${i + 1}` : baseTab;
    try {
      const r = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchUrls: [urls[i]], sheetUrl, tabName, profileId, slowMode }),
      });
      const res = await r.json();
      if (res && res.error) errors.push(`URL ${i + 1}: ${res.error}`);
      else started++;
    } catch (e) {
      errors.push(`URL ${i + 1}: ${e.message}`);
    }
  }
  setScrapeStatus(errors.length
    ? `Started ${started}/${urls.length}. First error — ${errors[0]}`
    : `Started ${started} scrape job${started === 1 ? '' : 's'} on the engine.`);
  startScrapePolling();
}

async function pauseScrapeJob() { await _scrapeControlAll('/api/scrape/pause'); }

async function stopScrapeJob() {
  await _scrapeControlAll('/api/scrape/stop');
  stopScrapePolling();
}

// Apply a control action to every selected account's job (each is keyed by
// profileId on the engine).
async function _scrapeControlAll(path) {
  const accts = scrapeSelectedAccounts();
  if (!accts.length) return;
  for (const profileId of accts) {
    try {
      await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      });
    } catch (_) { /* best-effort across accounts */ }
  }
}

function startScrapePolling() {
  stopScrapePolling();
  pollScrapeJobs();
  pollScrapeLogs();
  _scrapePollTimer = setInterval(() => { pollScrapeJobs(); pollScrapeLogs(); }, 4000);
}

function stopScrapePolling() {
  if (_scrapePollTimer) { clearInterval(_scrapePollTimer); _scrapePollTimer = null; }
}

// ── Jobs / Logs tabs ───────────────────────────────────────────────────────
let scrapeLogLines = [];
let scrapeLogSince = 0;
// IDs of engine jobs that existed BEFORE the current run started — snapshotted at
// Start and hidden from the jobs list so a new run shows only ITS jobs (the
// engine's /api/jobs accumulates across runs). Only jobs with a stable engine id
// are blacklisted; id-less jobs are always shown so current work is never hidden.
let scrapeBaselineJobIds = new Set();
let _scrapeBaselineDone = false; // hide prior jobs once per fresh scrape view
function _scrapeJobKey(j) {
  if (!j) return null;
  if (j.id != null && j.id !== '') return 'id:' + String(j.id);
  const t = j.tabName || '', u = j.searchUrl || '';
  return (t || u) ? `tu:${t}|${u}` : null;
}
// Hide jobs the engine already has — its /api/jobs is a GLOBAL accumulating list
// with no per-draft scoping, so a fresh draft / new run would otherwise show
// prior runs' jobs. terminalOnly=true (fresh-view) keeps a genuinely-running
// scrape visible after an app reload; false (on Start) hides everything before
// this run. App-side only; the engine is untouched.
async function scrapeHidePriorJobs(terminalOnly) {
  const TERMINAL = new Set(['done', 'cancelled', 'canceled', 'error', 'failed', 'stopped']);
  try {
    const r = await fetch('/api/scrape/jobs');
    const res = await r.json();
    const jobs = Array.isArray(res) ? res : (res.jobs || []);
    for (const j of jobs) {
      const k = _scrapeJobKey(j);
      if (!k) continue;
      if (!terminalOnly || TERMINAL.has(String(j.state || '').toLowerCase())) scrapeBaselineJobIds.add(k);
    }
  } catch (_) { /* best-effort */ }
  const el = document.getElementById('scrape-jobs');
  if (el) el.innerHTML = '<div class="scrape-job-empty">No scrape jobs yet.</div>';
  _setScrapeFoot(0, 0, 0);
  try { pollScrapeJobs(); } catch (_) {}
}

function setScrapeTab(tab) {
  document.querySelectorAll('#nav-scrape-launch .scrape-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.stab === tab);
  });
  const jobsEl = document.getElementById('scrape-tab-jobs');
  const logsEl = document.getElementById('scrape-tab-logs');
  if (jobsEl) jobsEl.style.display = tab === 'jobs' ? '' : 'none';
  if (logsEl) logsEl.style.display = tab === 'logs' ? '' : 'none';
  if (tab === 'logs') pollScrapeLogs();
}

function clearScrapeLog() {
  scrapeLogLines = [];
  scrapeLogSince = Date.now(); // don't re-pull already-shown lines next poll
  renderScrapeLogPanel();
}

// Copy the full activity log to the clipboard — for pasting into a bug report.
async function copyScrapeLog() {
  const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString(); } catch (_) { return ''; } };
  const text = scrapeLogLines
    .map((l) => `[${fmt(l.ts)}] ${l.tabName ? l.tabName + ' — ' : ''}${l.message || ''}`)
    .join('\n');
  const ok = () => setScrapeStatus(`Copied ${scrapeLogLines.length} log line${scrapeLogLines.length === 1 ? '' : 's'} to clipboard.`);
  try {
    await navigator.clipboard.writeText(text || '(log empty)');
    ok();
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      ok();
    } catch (e) { setScrapeStatus('Could not copy log: ' + (e.message || e)); }
  }
}

function renderScrapeLogPanel() {
  const el = document.getElementById('scrape-log');
  if (!el) return;
  if (!scrapeLogLines.length) { el.innerHTML = '<span class="scrape-log-empty">No activity yet.</span>'; return; }
  const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString(); } catch (_) { return ''; } };
  const cls = (m) => /error|✗|fail|closed/i.test(m) ? 'err' : (/done|✓|success|complete/i.test(m) ? 'ok' : '');
  el.innerHTML = scrapeLogLines.map((l) => {
    const label = l.tabName ? `${l.tabName} — ` : '';
    return `<div><span class="t">[${fmt(l.ts)}]</span> <span class="${cls(l.message)}">${escHtml(label + l.message)}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function pollScrapeLogs() {
  try {
    const r = await fetch(`/api/scrape/logs${scrapeLogSince ? `?since=${scrapeLogSince}` : ''}`);
    const res = await r.json();
    if (res && res.error) return;
    const lines = Array.isArray(res) ? res : (res.logs || []);
    if (lines.length) {
      scrapeLogLines.push(...lines);
      if (scrapeLogLines.length > 800) scrapeLogLines.splice(0, scrapeLogLines.length - 800);
      scrapeLogSince = lines[lines.length - 1].ts;
      renderScrapeLogPanel();
    } else if (res && res.now && !scrapeLogSince) {
      scrapeLogSince = res.now;
    }
  } catch (_) { /* keep last render */ }
}

async function pollScrapeJobs() {
  const el = document.getElementById('scrape-jobs');
  if (!el) return;
  try {
    const r = await fetch('/api/scrape/jobs');
    const res = await r.json();
    if (res && res.error) {
      el.innerHTML = `<div style="color:var(--gray);font-size:12px;padding:10px 0;">${escHtml(res.error)}</div>`;
      return;
    }
    let jobs = Array.isArray(res) ? res : (res.jobs || []);
    // Hide jobs from a previous run (snapshotted at Start) so the card shows
    // only the current campaign.
    if (scrapeBaselineJobIds.size) {
      jobs = jobs.filter((j) => { const k = _scrapeJobKey(j); return !(k && scrapeBaselineJobIds.has(k)); });
    }
    if (!jobs.length) {
      el.innerHTML = '<div class="scrape-job-empty">No scrape jobs yet.</div>';
      _setScrapeFoot(0, 0, 0);
      return;
    }
    const statClass = (s) => (s === 'error' || s === 'cancelled') ? 'err'
      : (s === 'done' ? 'done' : (s === 'running' ? 'running' : ''));
    el.innerHTML = jobs.map((j) => {
      const leads = j.profiles || 0;
      const leadsHtml = leads > 0 ? `<span class="leads">${leads} lead${leads === 1 ? '' : 's'}</span>` : `${leads} leads`;
      const label = (j.tabName || j.searchUrl || j.id || 'job');
      const jLabel = String(label).replace(/'/g, '&#39;');
      // Per-job live View — only while running (no live page otherwise).
      const viewBtn = j.state === 'running'
        ? `<button class="btn btn-ghost btn-sm scrape-job-view" onclick="openScrapeJobView('${escHtml(j.id)}','${jLabel}')" title="Watch this account's browser live">👁 View</button>`
        : '';
      return `<div class="scrape-job-row">
          <span class="scrape-job-name">${escHtml(label)}</span>
          <span class="scrape-job-stat ${statClass(j.state)}">${escHtml(j.state || '')} · ${j.pages || 0}p · ${leadsHtml}</span>
          ${viewBtn}
        </div>${j.error ? `<div class="scrape-job-err">${escHtml(j.error)}</div>` : ''}`;
    }).join('');
    const totalLeads = jobs.reduce((a, j) => a + (j.profiles || 0), 0);
    const doneCount = jobs.filter((j) => j.state === 'done').length;
    _setScrapeFoot(totalLeads, doneCount, jobs.length);
  } catch (_) { /* keep last render */ }
}

// Footer summary on the scrape live-status card: total leads + done / total.
function _setScrapeFoot(leads, done, total) {
  const b = document.getElementById('scrape-foot-leads');
  const c = document.getElementById('scrape-foot-cap');
  if (b) b.textContent = String(leads);
  if (c) c.textContent = total ? `leads scraped · ${done} of ${total} done` : 'leads scraped';
}

// app.js is loaded as a <script type="module">, so these are module-scoped and
// invisible to inline onclick/oninput attributes unless exported to window —
// same pattern as window.onModeChange etc. Without this, the Start/Pause/Stop
// scrape buttons silently do nothing.
window.startScrapeJob = startScrapeJob;
window.pauseScrapeJob = pauseScrapeJob;
window.stopScrapeJob = stopScrapeJob;
window.updateScrapePairing = updateScrapePairing;
window.setScrapeInputMode = setScrapeInputMode;
window.loadScrapeUrlsFromSheet = loadScrapeUrlsFromSheet;
window.onScrapeRowSpecChange = onScrapeRowSpecChange;
window.setScrapeTab = setScrapeTab;
window.clearScrapeLog = clearScrapeLog;
window.copyScrapeLog = copyScrapeLog;
window.openScrapeJobView = openScrapeJobView;
window.closeScrapeJobView = closeScrapeJobView;

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
// v2.59: top three (Connect Only, Introduction Campaign, Connect +
// Introduce Back) are the active modes. Everything else is parked as
// Coming Soon per operator request. Card markup + the existing comingSoon
// flag + setModeByIndex's toast handle the grey-out + click-to-toast flow.
const MODE_LIST = [
  {
    value: 'connect_only',
    name: 'Connect Only',
    // v2.102.0: un-parked — the pre-send identity gate now makes a wrong-person
    // connect structurally impossible, so this mode is safe to run again.
    bullets: [
      'Send connection requests to new profiles',
      'Optional personalised note',
      'Safest, highest-volume top-of-funnel mode',
    ],
  },
  {
    value: 'introduce_back',
    name: 'Introduction Campaign',
    bullets: [
      '3-way group DM',
      'Adds your intro person automatically',
      'Runs on a sheet of already-connected leads',
    ],
  },
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
    value: 'connect_and_message',
    name: 'Connect + DM',
    // v2.102.0: un-parked — gated by the pre-send identity check (force_connect
    // hint), so wrong-person sends are prevented; safe to run again.
    bullets: [
      'Send connection requests to new profiles',
      'Once accepted, auto-DM the lead directly (no intro person)',
      'End-to-end cold-lead → direct outreach pipeline',
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
    // v2.61: Renamed display "Message Only" → "Direct Messages" and
    // refactored to mirror introduce_back semantics (workflow A — full
    // IC symmetry). Internal value stays 'message_only' so existing
    // saved drafts/schedules/history rows keep working.
    value: 'message_only',
    name: 'Direct Messages',
    // Parked per operator request — greyed + non-clickable like Post Amplification.
    disabled: true,
    disabledReason: 'Direct Messages is unavailable.',
    // v2.86.1 (port): re-enabled for operator testing. (Was greyed in v2.72 when
    // folded into Message Campaign.)
    bullets: [
      '1:1 direct messages to your connections',
      'Adds no intro person — sender messages the lead directly',
      'Runs on a sheet of already-connected leads',
    ],
  },
  {
    value: 'inmail_only',
    name: 'InMail Only',
    // Parked per operator request — greyed + non-clickable like Post Amplification.
    disabled: true,
    disabledReason: 'InMail Only is unavailable.',
    // v2.86.1 (port): re-enabled for operator testing. (Was greyed in v2.72.)
    bullets: [
      'Premium InMail to non-connected targets',
      'Consumes InMail credits per send',
      'Experimental — limited automated test coverage',
    ],
  },
  {
    value: 'open_profile_only',
    name: 'Message Campaign',
    // v2.85 parked this per operator request; v2.86.1 (port) re-enables it for
    // operator testing. NOTE: the OP-channel send path (Sales Nav ↔ LinkedIn
    // fallback) is the one with limited real-world proof — test deliberately.
    bullets: [
      'Messages leads via LinkedIn or Sales Navigator',
      'Free for Open Profile members — optional InMail fallback',
      'Resolves plain profile links automatically',
    ],
  },
  {
    value: 'sales_nav_scrape',
    name: 'Sales Nav Scrape',
    bullets: [
      'Scrape a Sales Navigator search into a Google Sheet',
      'Runs in the cloud — close your laptop, it keeps going',
      'Live page / profile progress',
    ],
  },
  {
    value: 'check_dms',
    name: 'Check DMs',
    // Parked per operator request — greyed + non-clickable like Post Amplification.
    disabled: true,
    disabledReason: 'Check DMs is unavailable.',
    bullets: [
      'Scan LinkedIn inboxes for new replies',
      'Append new messages to the Replies tab',
      'Bump lead Stage to "Replied" on inbound',
    ],
  },
  {
    value: 'post_amplification',
    name: 'Post Amplification',
    comingSoon: true,
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
  // v2.100.2: never leave the active selection on a disabled/coming-soon mode
  // (connect_only is the select's default and is now under maintenance). Fall
  // through to the first available mode and sync the hidden select.
  if (MODE_LIST[activeIdx] && (MODE_LIST[activeIdx].disabled || MODE_LIST[activeIdx].comingSoon)) {
    const firstOk = MODE_LIST.findIndex((m) => !m.disabled && !m.comingSoon);
    if (firstOk >= 0) {
      activeIdx = firstOk;
      if (select.value !== MODE_LIST[firstOk].value) {
        select.value = MODE_LIST[firstOk].value;
        if (typeof onModeChange === 'function') onModeChange();
      }
    }
  }

  // Per-mode label overrides via the generic "Edit labels" flow.
  const saved = loadEditsFromStorage();
  const nameFor = (m) => saved[`mode-name-${m.value}`] || m.name;

  grid.innerHTML = MODE_LIST.map((m, i) => {
    const bullets = m.bullets
      .map((b) => `<li>${escHtml(b)}</li>`)
      .join('');
    const isActive = i === activeIdx && !m.comingSoon && !m.disabled;
    const stateClass = (m.comingSoon || m.disabled) ? 'is-coming-soon' : (isActive ? 'active' : '');
    const badge = m.comingSoon ? '<span class="mode-card-badge">Coming soon</span>'
      : (m.disabled ? `<span class="mode-card-badge">${m.maintenance ? 'Under maintenance' : 'Unavailable'}</span>` : '');
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
  if (mode.disabled) {
    showCampaignToast(mode.disabledReason || `${mode.name} is unavailable.`, 3500);
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

  // v2.58.x — IC mode now mirrors CC+IC's chip layout: show {primary ...}
  // chips, hide {intro ...} chips. Both intro flows present the same
  // template variables so operators don't have to learn two vocabularies.
  // outreach.js's IC fast-path maps templates.introName into both intro-*
  // AND primary-* substitution keys, so existing presets that still use
  // {intro X} keep working — the chip UI is what changed.
  const isIntroFlow = isCcIc || isIb;
  const extras = [
    ...senderChips,
    ...(isIntroFlow ? [] : introChips),
    ...(isIntroFlow ? primaryChips : (isIb ? [] : primaryChips)),
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

// "Open Sheet" buttons — pop the campaign Google Sheet in the operator's
// default browser (Electron's setWindowOpenHandler routes window.open
// http* calls through shell.openExternal). Two callsites:
//   - Setup section, next to Preview Sheet — reads #sheet-url
//   - Cockpit row, next to Bulk check connections — reads __cockpit.sheetUrl,
//     auto-disabled when no URL is available
function _isValidHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}
function openSheetInBrowser() {
  const url = (document.getElementById('sheet-url')?.value || '').trim();
  if (!url) { alert('Enter a Google Sheet URL first.'); return; }
  if (!_isValidHttpUrl(url)) { alert("That doesn't look like a valid URL."); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
}
function openRunningSheet() {
  // Prefer the running campaign's actual sheetUrl so the cockpit button
  // always opens the live sheet even if the operator has since edited
  // the setup input. Fall back to the setup input so the button is
  // usable BEFORE a campaign has started.
  const running = ((__cockpit && __cockpit.sheetUrl) || '').trim();
  const setup = (document.getElementById('sheet-url')?.value || '').trim();
  const url = running || setup;
  if (!url) { alert('Enter a Google Sheet URL first.'); return; }
  if (!_isValidHttpUrl(url)) { alert("That doesn't look like a valid URL."); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
}
function _refreshOpenSheetButtons() {
  const btn = document.getElementById('btn-open-sheet-cockpit');
  if (!btn) return;
  const running = _isValidHttpUrl((__cockpit && __cockpit.sheetUrl) || '');
  const setup = _isValidHttpUrl((document.getElementById('sheet-url')?.value || '').trim());
  const has = running || setup;
  btn.disabled = !has;
  btn.title = running
    ? 'Open the running campaign sheet in your browser'
    : (setup ? 'Open the sheet you entered above' : 'Enter a sheet URL first');
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 6: multi-tab lead-source guard
// ─────────────────────────────────────────────────────────────────────────────

// System tab names that should never be used as a lead source.
const SYSTEM_TAB_NAMES = new Set([
  'recent connections', 'recent messages', 'savedsearch/batches',
  'savedsearch', 'batches', 'soo', 'linkedin accounts',
  'ops log', 'events', 'config',
]);

function _isSystemTabName(name) {
  return SYSTEM_TAB_NAMES.has((name || '').trim().toLowerCase());
}

// Decide if header array + preview rows look like a lead tab.
// Requires: a "First Name" column AND a LinkedIn-URL-ish column.
function _looksLikeLeadHeader(headers) {
  if (!headers || headers.length === 0) return false;
  const lh = headers.map(h => (h || '').toString().trim().toLowerCase());
  const hasFirstName = lh.some(h => /^first[\s_]?name$/.test(h));
  const hasLinkedIn  = lh.some(h => /linkedin|profile\s*url|slug/i.test(h) || h === 'url');
  return hasFirstName && hasLinkedIn;
}

let _tabPickDebounceTimer = null;

// Called on #sheet-url input/blur — fetches tabs, shows picker if multi-tab.
async function refreshSheetTabPicker() {
  const urlEl = document.getElementById('sheet-url');
  const picker = document.getElementById('sheet-tab-picker');
  const select = document.getElementById('sheet-tab-select');
  const label  = document.getElementById('sheet-tab-picker-label');
  if (!urlEl || !picker || !select) return;

  const url = urlEl.value.trim();
  if (!url || !url.includes('docs.google.com/spreadsheets')) {
    picker.style.display = 'none';
    window._tabsData = [];
    window._tabPickerMulti = false;
    window._chosenSheetGid = '';
    window._tabLeadOk = true;
    return;
  }

  let tabs;
  try {
    const res = await fetch('/api/sheet/tabs?sheetUrl=' + encodeURIComponent(url));
    const data = await res.json();
    if (!res.ok || !data.tabs) { picker.style.display = 'none'; return; }
    tabs = data.tabs;
  } catch { picker.style.display = 'none'; return; }

  window._tabsData = tabs;
  window._tabPickerMulti = tabs.length > 1;

  if (tabs.length <= 1) {
    // Single-tab: auto-select, store gid, hide picker
    if (tabs.length === 1) {
      window._chosenSheetGid = String(tabs[0].gid || '');
      window._tabLeadOk = !_isSystemTabName(tabs[0].name) && _looksLikeLeadHeader(tabs[0].header || []);
    }
    picker.style.display = 'none';
    return;
  }

  // Multi-tab: show picker
  if (label) label.textContent = `This workbook has ${tabs.length} tabs — choose the campaign's lead list`;

  // Pre-select tab whose gid matches what's already in the URL
  const urlGid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '';

  select.innerHTML = tabs.map(tab => {
    const isSys = _isSystemTabName(tab.name);
    const tabLabel = isSys ? `${tab.name} — not leads` : tab.name;
    const detail = `· ${tab.rowCount} rows`;
    const selected = (urlGid && String(tab.gid) === urlGid) ? ' selected' : '';
    return `<option value="${tab.gid}"${selected} data-sys="${isSys}" data-name="${escHtml(tab.name)}">${escHtml(tabLabel)} ${detail}</option>`;
  }).join('');

  picker.style.display = '';
  // Trigger preview for the currently selected option
  onSheetTabChange();
}

function _debounceTabPicker() {
  clearTimeout(_tabPickDebounceTimer);
  _tabPickDebounceTimer = setTimeout(refreshSheetTabPicker, 500);
}

// Called on <select> change — preview the chosen tab.
async function onSheetTabChange() {
  const select   = document.getElementById('sheet-tab-select');
  const previewEl = document.getElementById('sheet-tab-preview');
  const blockEl  = document.getElementById('sheet-tab-leadblock');
  const blockBody = document.getElementById('sheet-tab-leadblock-body');
  if (!select) return;

  const gid = select.value;
  window._chosenSheetGid = gid;

  const opt = select.options[select.selectedIndex];
  const isSys = opt?.dataset?.sys === 'true';
  const tabName = opt?.dataset?.name || gid;

  if (!gid) {
    if (previewEl) previewEl.style.display = 'none';
    if (blockEl) blockEl.style.display = 'none';
    window._tabLeadOk = false;
    return;
  }

  // Find tab header from cached data
  const tabInfo = (window._tabsData || []).find(t => String(t.gid) === String(gid));
  const header = tabInfo ? (tabInfo.header || []) : [];

  if (isSys || !_looksLikeLeadHeader(header)) {
    // Show block
    window._tabLeadOk = false;
    if (previewEl) previewEl.style.display = 'none';
    if (blockEl) {
      blockEl.style.display = '';
      if (blockBody) {
        if (isSys) {
          blockBody.innerHTML = `The selected tab <code>${escHtml(tabName)}</code> is a system tab (LinkedIn data log), not your leads. Pick the campaign's lead tab — the one with <b>First Name</b> + a <b>LinkedIn URL</b> column.`;
        } else {
          blockBody.innerHTML = `The selected tab <code>${escHtml(tabName)}</code> doesn't look like a lead list — it's missing a <b>First Name</b> column and/or a <b>LinkedIn URL</b> column. Pick the right tab.`;
        }
      }
    }
    return;
  }

  // Looks like leads — show preview
  window._tabLeadOk = true;
  if (blockEl) blockEl.style.display = 'none';

  // Build 3-row preview from header + up to 3 rows if available
  if (previewEl) {
    const topCols = header.slice(0, 5); // first 5 cols
    const colPills = topCols.map(h => {
      const isKey = /^first[\s_]?name$/i.test(h) || /linkedin|profile\s*url/i.test(h);
      return isKey ? `<b>${escHtml(h)} ✓</b>` : escHtml(h);
    }).join(' · ');

    let html = `<div class="tabpick-cols">Detected columns: ${colPills}</div>`;

    // Try to fetch a small preview via the existing /api/sheet/preview endpoint with the gid
    try {
      const urlEl = document.getElementById('sheet-url');
      const baseUrl = (urlEl?.value || '').trim();
      // Build url with this gid
      const previewUrl = baseUrl.replace(/[#&?]gid=\d+/g, '').replace(/#$/, '') + '#gid=' + gid;
      const res = await fetch('/api/sheet/preview?url=' + encodeURIComponent(previewUrl));
      const data = await res.json();
      if (!data.error && data.preview && data.preview.length > 0) {
        const cols = data.columns.slice(0, 5);
        html += '<table class="mini"><thead><tr>';
        cols.forEach(c => { html += `<th>${escHtml(c)}</th>`; });
        html += '</tr></thead><tbody>';
        data.preview.slice(0, 3).forEach(row => {
          html += '<tr>';
          cols.forEach(c => { html += `<td>${escHtml(String(row[c] || ''))}</td>`; });
          html += '</tr>';
        });
        html += '</tbody></table>';
      }
    } catch { /* preview fetch failed — still show col pills */ }

    html += `<div class="tabpick-ok">✓ Looks like a lead list — ready to launch.</div>`;
    previewEl.innerHTML = html;
    previewEl.style.display = '';
  }
}

// Show the rerun tab-change confirm modal.
// Resolves true (proceed) or false (cancel).
function _showTabChangeModal(fromLabel, toLabel) {
  return new Promise(resolve => {
    const scrim = document.getElementById('tab-change-modal');
    const bodyEl = document.getElementById('tab-change-modal-body');
    const confirmBtn = document.getElementById('tab-change-confirm');
    const cancelBtn  = document.getElementById('tab-change-cancel');
    if (!scrim) { resolve(true); return; }

    if (bodyEl) {
      bodyEl.innerHTML = `This rerun will pull leads from a <b>different tab</b> than last time:<br><br>from <span class="from">"${escHtml(fromLabel)}"</span><br>to <span class="to">"${escHtml(toLabel)}"</span>`;
    }
    scrim.classList.add('open');

    function cleanup() { scrim.classList.remove('open'); confirmBtn.onclick = null; cancelBtn.onclick = null; }
    confirmBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick  = () => { cleanup(); resolve(false); };
  });
}

window.onSheetTabChange = onSheetTabChange;
window.refreshSheetTabPicker = refreshSheetTabPicker;

// True if any sample row's value for `col` looks like a LinkedIn profile URL
// (contains linkedin.com) or a generic http(s) URL. Used to guard the
// LinkedIn-URL column picker against a wrong (non-URL) column choice.
function _looksLikeUrlColumn(col, rows) {
  for (const row of (rows || [])) {
    const v = String((row && row[col]) || '').toLowerCase();
    if (v.includes('linkedin.com') || /^https?:\/\//.test(v)) return true;
  }
  return false;
}

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
    // v2.62: count becomes data-count so the CSS in .sheet-hero-preview can
    // render it as the big hero stat via ::before. Plain text fallback also
    // reads sensibly outside the hero context.
    let html = `<p data-count="${data.totalRows}">rows pulled · just now</p>`;
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
    // Column selector — auto-detect by scanning sample rows for linkedin.com.
    // v2.59: restyled to use the ic-row layout (label-block on left, select
    // on right) so it matches the '1st Connection Column' picker below.
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
    let _urlOpts = '';
    data.columns.forEach((col) => {
      const sel = (autoDetectCol && col === autoDetectCol) ? 'selected' : '';
      _urlOpts += `<option value="${escHtml(col)}" ${sel}>${escHtml(col)}</option>`;
    });
    html += `<div class="tabpick" id="linkedin-col-pick" style="margin-top:12px; border:1px solid var(--card-border); border-radius:12px;">
      <div class="tabpick-head"><span class="dot"></span> Which column holds the LinkedIn profile URL?</div>
      <select id="linkedin-col-select">${_urlOpts}</select>
      <div id="linkedin-col-autodetect" style="font-family:var(--mono); font-size:0.78rem; color:var(--green); margin-top:8px; ${autoDetectCol ? '' : 'display:none'}">✓ Auto-detected${autoDetectCol ? ` from “${escHtml(autoDetectCol)}”` : ''} — values look like linkedin.com/in/… profiles.</div>
      <div id="linkedin-col-guard" class="leadblock" style="display:none; margin-top:10px;">
        <div class="lb-title">⛔ That doesn't look like a URL column</div>
        <div class="lb-body">This column's cells aren't <code>linkedin.com/in/…</code> links. Pick the column whose values are LinkedIn profile URLs, or the app can't open the right person.</div>
      </div>
    </div>`;
    // v2.59: the duplicated 'Which column contains the LinkedIn 1st
    // connections?' dropdown previously added here was removed — the IC
    // extras section below already exposes the same picker (#ic-sender-col-select)
    // with a richer label-block layout, and surfacing it twice was confusing.

    // v2.58.x — IC-only extras: sender-column picker + "all leads already
    // connected" checkbox. Rendered inline next to the URL picker so it
    // sits in the same visual block. Visibility is toggled by
    // updateIcExtrasVisibility(), wired into onModeChange(). Block is
    // hidden in non-IC modes so other campaigns are unaffected.
    //
    // Auto-detect for the sender column:
    //   1. Header match (case-insensitive): prefer headers commonly used by
    //      Ortus operators — 'Sender', 'LinkedIn 1st Connections', 'Account',
    //      'Account Used', 'Owner'.
    //   2. Value match: first column whose sample rows contain '@' (email-
    //      style values, e.g. alecx@ortus.solutions).
    //   3. Fallback: no preselection — operator picks manually.
    let autoSenderCol = null;
    const SENDER_HEADER_PRIORITY = [
      'sender', 'linkedin 1st connections', 'linkedin 1st connection',
      'account used', 'account', 'owner',
    ];
    for (const wanted of SENDER_HEADER_PRIORITY) {
      const found = data.columns.find((c) => (c || '').toString().trim().toLowerCase() === wanted);
      if (found && found !== autoDetectCol) { autoSenderCol = found; break; }
    }
    if (!autoSenderCol && data.preview && data.preview.length > 0) {
      for (const col of data.columns) {
        if (col === autoDetectCol) continue;
        for (const row of data.preview) {
          const val = (row[col] || '').toString();
          if (val.includes('@')) { autoSenderCol = col; break; }
        }
        if (autoSenderCol) break;
      }
    }

    preview.innerHTML = html;

    // Wire the LinkedIn-URL column guard. The auto-detected column passes the
    // initial check (green ✓ line stays); picking a non-URL column (e.g. a bio
    // text column) swaps in the red leadblock warning.
    const _urlSel = document.getElementById('linkedin-col-select');
    if (_urlSel) {
      const _rows = data.preview || [];
      const _validateUrlCol = () => {
        const ok = _looksLikeUrlColumn(_urlSel.value, _rows);
        const guard = document.getElementById('linkedin-col-guard');
        const auto = document.getElementById('linkedin-col-autodetect');
        if (guard) guard.style.display = ok ? 'none' : 'block';
        if (auto) auto.style.display = ok ? '' : 'none';
      };
      _urlSel.addEventListener('change', _validateUrlCol);
      _validateUrlCol(); // initial check (auto-detected col should pass)
    }

    sheetColumns = data.columns;
    window.sheetTotalRows = typeof data.totalRows === 'number' ? data.totalRows : null;
    try { window.__sheetPreviewCache = { count: (typeof data.totalRows === 'number' ? data.totalRows : 0), at: Date.now() }; } catch (_) {}
    try { if (typeof updateSectionSummaries === 'function') updateSectionSummaries(); } catch (_) {}
    updatePlaceholderTags();
    updateCampaignSummary();

    // v2.58.x — IC sheet mapping (Variant C — progressive disclosure).
    // Flip the empty state hidden, show the filled form, populate dropdown
    // options. Auto-detect badge appears only if the operator hasn't already
    // manually picked a column (tracked via data-manual-pick).
    try {
      const empty = document.getElementById('ic-extras-empty');
      const filled = document.getElementById('ic-extras-filled');
      const sel = document.getElementById('ic-sender-col-select');
      const badge = document.getElementById('ic-auto-detected-badge');
      if (empty) empty.classList.add('hidden');
      if (filled) filled.classList.remove('hidden');
      if (sel) {
        const isManual = sel.dataset.manualPick === '1';
        const cur = sel.value;
        const keepCur = isManual && cur && data.columns.includes(cur);
        const chosen = keepCur ? cur : (autoSenderCol || '');
        const opts = [`<option value="">— Use "Sender" column —</option>`];
        data.columns.forEach((col) => {
          const selected = (col === chosen) ? 'selected' : '';
          opts.push(`<option value="${escHtml(col)}" ${selected}>${escHtml(col)}</option>`);
        });
        sel.innerHTML = opts.join('');
        // Badge shows only when we did the auto-detect, not when the
        // operator manually picked. Manual pick state survives across
        // preview re-runs (operator's choice is sticky).
        const showBadge = !isManual && !!autoSenderCol && chosen === autoSenderCol;
        sel.classList.toggle('is-detected', showBadge);
        if (badge) badge.classList.toggle('hidden', !showBadge);
      }
    } catch (_) {}
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
// v2.60.x: oninput-safe sync. The previous version auto-rewrote an empty
// or sub-1 field back to 50 on EVERY keystroke, which made it impossible
// to backspace the existing value to type a new one (delete last digit →
// field empty → handler refills with 50 → can't ever go blank). Now:
//  - empty / in-progress input is allowed during typing (no rewrite)
//  - upper bound (500) is clamped live so "9999" can't sneak through
//  - lower bound + default fallback runs on blur via alphaBlurDailyLimit
function alphaSyncDailyLimit() {
  const visEl = document.getElementById('daily-limit-input');
  const hidEl = document.getElementById('daily-limit');
  if (!visEl || !hidEl) return;
  const raw = visEl.value;
  if (raw === '' || raw === '-') {
    updateCampaignSummary();
    return;
  }
  let v = parseInt(raw, 10);
  if (!Number.isFinite(v)) {
    updateCampaignSummary();
    return;
  }
  if (v > 500) {
    visEl.value = '500';
    v = 500;
  }
  hidEl.value = String(v);
  updateCampaignSummary();
}

// Blur-time clamp + fallback. Restores 50 when the field is empty/invalid
// so we never submit a blank or below-min value to the backend.
function alphaBlurDailyLimit() {
  const visEl = document.getElementById('daily-limit-input');
  const hidEl = document.getElementById('daily-limit');
  if (!visEl || !hidEl) return;
  let v = parseInt(visEl.value, 10);
  if (!Number.isFinite(v) || v < 1) v = 50;
  v = Math.max(1, Math.min(500, v));
  visEl.value = String(v);
  hidEl.value = String(v);
  updateCampaignSummary();
}
window.alphaBlurDailyLimit = alphaBlurDailyLimit;

function alphaStepDaily(delta) {
  const visEl = document.getElementById('daily-limit-input');
  if (!visEl) return;
  const cur = parseInt(visEl.value, 10) || 50;
  visEl.value = String(Math.max(1, Math.min(500, cur + delta)));
  alphaSyncDailyLimit();
}

// v2.61: Concurrency stepper. Mirrors alphaStepDaily — adjusts the
// concurrency-count input and triggers a forecast refresh. Bounded by the
// input's own min/max (2–5).
function alphaStepConcurrency(delta) {
  const el = document.getElementById('concurrency-count');
  if (!el || el.disabled) return;
  const cur = parseInt(el.value, 10) || 2;
  const min = parseInt(el.min, 10) || 2;
  const max = parseInt(el.max, 10) || 5;
  el.value = String(Math.max(min, Math.min(max, cur + delta)));
  updateCampaignSummary();
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

// Task 4 (2026-06-19): B1 delay-danger disclaimer — show when #within-batch-min < 30.
function checkDelayDanger() {
  const min = parseInt(document.getElementById('within-batch-min')?.value || '30', 10);
  const block = document.getElementById('delay-danger-block');
  if (block) block.classList.toggle('show', min < 30);
}

// Task 4 (2026-06-19): B2 pause-on-throttle help text update.
function syncPauseOnThrottleHelp() {
  const tog = document.getElementById('pause-on-throttle');
  const help = document.getElementById('pause-on-throttle-help');
  if (!tog || !help) return;
  help.innerHTML = tog.checked
    ? '<b>On:</b> the account stops sending and backs off when throttled, then resumes slower — protects it from restriction. Other accounts keep running.'
    : '<b>Off:</b> the account keeps sending through throttling. Faster, but risks more skips and pushes the account toward restriction. Not recommended.';
}

function alphaRecalc() {
  // v2.11.0: simpler model. Total max invites this run = N accounts × campaign limit.
  // v2.61 redesign removed the alpha-total-leads/acct-count/per-acct/eq-total
  // hero elements from index.html. The OLD `if (!totalEl) return` guard then
  // short-circuited this whole function — so the concurrency-unlock block below
  // (the ONLY place that adds .is-unlocked) never ran, leaving "Parallel
  // accounts" permanently locked in EVERY mode no matter how many accounts were
  // selected. Don't gate on those removed elements; every write below is
  // individually null-guarded, so the function safely no-ops when they're absent.
  const totalEl = document.getElementById('alpha-total-leads');
  const acctCountEl = document.getElementById('alpha-acct-count');
  const perAcctEl = document.getElementById('alpha-per-acct');
  const eqTotalEl = document.getElementById('alpha-eq-total');

  const numAccounts = Array.isArray(selectedProfileIds) ? selectedProfileIds.length : 0;
  const dailyLimit = parseInt(document.getElementById('daily-limit')?.value, 10) || 50;
  const total = dailyLimit * numAccounts;

  if (totalEl) totalEl.textContent = total > 0 ? String(total) : '—';
  if (acctCountEl) acctCountEl.textContent = String(numAccounts);
  if (perAcctEl)   perAcctEl.textContent   = String(dailyLimit);
  if (eqTotalEl)   eqTotalEl.textContent   = String(total);

  // Concurrency toggle unlocked at ≥5 accounts. The server only honors
  // concurrency>1 when ≥5 accounts are selected (server.js buildCampaignConfig),
  // so the UI threshold MUST match — otherwise the toggle is enabled but a
  // silent no-op for 2-4 accounts (the bug this restores the fix for).
  // v2.61 briefly lowered this to ≥2 to match a then-incorrect assumption;
  // reverted to ≥5 to stay honest with the backend gate.
  // Row is always rendered; the .is-unlocked class controls whether the
  // controls are interactive or dimmed (CSS handles the visual state and
  // shows the "available with 5+ accounts" pill when locked).
  const concurrencyRow = document.getElementById('alpha-concurrency-row');
  const concurrencyToggle = document.getElementById('concurrency-toggle');
  const concurrencyCount = document.getElementById('concurrency-count');
  if (concurrencyRow) {
    const unlocked = numAccounts >= 5;
    concurrencyRow.classList.toggle('is-unlocked', unlocked);
    if (!unlocked) {
      // Auto-disable + uncheck when locked so the math falls back to 1
      if (concurrencyToggle) concurrencyToggle.checked = false;
      if (concurrencyCount) concurrencyCount.disabled = true;
    } else if (concurrencyCount) {
      // When unlocked, count is enabled iff the toggle is on
      concurrencyCount.disabled = !concurrencyToggle?.checked;
    }
  }
}

function updateCampaignSummary() {
  // Phase 2.8.14: alpha throughput panel recalculates whenever this fires
  // (account toggle, rate/pause edit). Safe to call before alpha is ready —
  // it null-guards every element lookup.
  alphaRecalc();
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';

  // Keep the Sales Nav Scrape pairing summary live as accounts are toggled.
  if (mode === 'sales_nav_scrape') { try { updateScrapePairing(); } catch (_) {} }

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
  // Gate matches alphaRecalc visual gate AND the server gate (≥5 accounts).
  // Below 5 accounts the server forces concurrency=1, so the forecast must
  // not promise a parallel multiplier it won't deliver.
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
async function addToQueueCampaign() { return startCampaign({ queueOnly: true }); }
async function startCampaign(opts = {}) {
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

  // One-at-a-time: a campaign in the monitoring phase occupies the single
  // campaign slot. Launching a new one resets that state (campaign.js
  // startCampaign), silently ending the acceptance watch. Warn first.
  try {
    if (typeof __cockpit !== 'undefined' && __cockpit && __cockpit.state === 'monitoring') {
      const ok = confirm('A campaign is currently monitoring for acceptances. Starting a new campaign will end that monitoring. Continue?');
      if (!ok) return;
    }
  } catch { /* if __cockpit is unavailable, don't block the launch */ }

  // 2.8.29 / 2.8.31: check_status and message_only auto-derive profiles from
  // the sheet's Account Used column. UI selection ignored — skip validation.
  // v2.58.x: introduce_back (Introduction Campaign) is also auto-routed from
  // the chosen Sender column — the profile picker is hidden for this mode
  // (see onModeChange at line ~1459), so requiring a manual pick was a
  // pre-existing gate bug that surfaced once IC ran on a no-Stage sheet.
  const _modeForValidation = _modeEarly;
  const _autoRoutedModes = new Set(['check_status', 'message_only', 'introduce_back']);
  if (!_autoRoutedModes.has(_modeForValidation) && selectedProfileIds.length === 0) {
    alert('Select at least one GoLogin profile.'); return;
  }
  // v2.112.26 (#1): the "Before you start…" assigned/in-use confirm dialog was
  // removed as obsolete — the persistent banner in the accounts picker already
  // surfaces this, so Start no longer interrupts with a popup. (The banner stays;
  // only the blocking dialog is gone.)
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
  // v2.62: CC+DM validation — the post-acceptance body is required.
  // Without it, every accepted invite would silently skip the DM
  // (auto-dm.js logs a warning but the operator never sees it).
  if (_mode === 'connect_and_message') {
    const _ccDmBody = (document.getElementById('tpl-cc-dm-body')?.value || '').trim();
    if (!_ccDmBody) {
      alert(
        "Connect + DM can't start without the post-acceptance DM body.\n\n" +
        'Missing:\n• Post-acceptance DM\n\n' +
        "Without it, accepted invites can't be auto-messaged. " +
        'Fill in the field and try again.'
      );
      const el = document.getElementById('tpl-cc-dm-body');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => el.focus(), 400);
      }
      return;
    }
  }

  // v2.58.x — IC validation: intro-name (the primary person) + Intro DM Body
  // (primary-intro-body) must both be filled. Same gate as CC+IC's primary
  // checks above but scoped to IC's actual fields.
  if (_mode === 'introduce_back') {
    const _icName = (document.getElementById('intro-name')?.value || '').trim();
    const _icBody = (document.getElementById('primary-intro-body')?.value || '').trim();
    if (!_icName || !_icBody) {
      const missing = [];
      if (!_icName) missing.push('• Intro person — full LinkedIn name');
      if (!_icBody) missing.push('• Intro DM Body');
      alert(
        "Introduction Campaign can't start without these fields.\n\n" +
        'Missing:\n' + missing.join('\n') + '\n\n' +
        'Fill in the missing field(s) and try again.'
      );
      const firstEmpty = !_icName ? 'intro-name' : 'primary-intro-body';
      const el = document.getElementById(firstEmpty);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => el.focus(), 400);
      }
      return;
    }
  }

  // v2.112: primary URL is REQUIRED to launch the intro modes — it's the identity
  // the connected-to-primary check + auto-accept + the persistent store all key on.
  // (Structural check only, no network lookup, so it can block without false-flagging.)
  if (_mode === 'connect_and_introduce' || _mode === 'introduce_back') {
    const _pUrlEl = document.getElementById('primary-person-url');
    const _pUrlVal = (_pUrlEl?.value || '').trim();
    if (!_pUrlVal) {
      const _msg = 'Primary person URL is required for this mode.';
      showPrimaryUrlError(_msg);
      alert(_msg + '\n\nAdd the Primary Person · LinkedIn profile URL and try again.');
      if (_pUrlEl) {
        _pUrlEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => _pUrlEl.focus(), 400);
      }
      return;
    }
    const _v = validatePrimaryUrl(_pUrlVal);
    if (!_v.ok) {
      showPrimaryUrlError(_v.reason);
      alert(
        "That doesn't look like the Primary person's LinkedIn profile URL.\n\n" +
        _v.reason + '\n\n' +
        'Fix the Primary Person · LinkedIn profile URL and try again.'
      );
      if (_pUrlEl) {
        _pUrlEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => _pUrlEl.focus(), 400);
      }
      return;
    }
    clearPrimaryUrlError();
  }

  // Task 6: tab picker lock — block launch when multi-tab workbook has no
  // valid lead tab chosen.
  if (window._tabPickerMulti) {
    if (!window._chosenSheetGid) {
      const _pickerEl = document.getElementById('sheet-tab-picker');
      if (_pickerEl) _pickerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('This workbook has multiple tabs — pick the lead tab before launching.');
      return;
    }
    if (!window._tabLeadOk) {
      const _select = document.getElementById('sheet-tab-select');
      const _tabName = _select?.options[_select.selectedIndex]?.dataset?.name || window._chosenSheetGid;
      const _blockEl = document.getElementById('sheet-tab-leadblock');
      if (_blockEl) _blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert(`Can't launch — the selected tab "${_tabName}" isn't a lead list. Pick the correct lead tab.`);
      return;
    }
  }

  // Resolve sender first names per profile (SoO column D, or local-browser input).
  // Resolver runs silently — the operator-facing preview popup was dropped
  // in favour of the post-launch tips card. Sheet-snapshot disclaimer lives
  // there now too.
  const senderFirstNames = {};
  for (const id of selectedProfileIds) {
    const pName = selectedProfileNames[id] || id;
    senderFirstNames[id] = resolveSenderFirstName(id, pName);
  }

  const mode = document.getElementById('campaign-mode').value;
  // v2.13.x — Group conversation title + primary-person / Intro DM Body fields
  // belong ONLY to the two intro flows (CC+IC connect_and_introduce, IC
  // introduce_back). Switching CC+IC → CC+DM only hides those inputs, it
  // doesn't clear them, so a leftover CC+IC config would otherwise leak into
  // the campaign config and the post-campaign sweep (which fires a real group
  // intro on primaryName+primaryIntroBody). Gate them at the source. Mirrors
  // gatherCampaignFormState's preview gating; backed by the sweep's mode gate
  // (post-campaign-bulk-check.js shouldFirePostCampaignIntro) as defense-in-depth.
  const _isIntroFlow = (mode === 'connect_and_introduce' || mode === 'introduce_back');

  // Phase 11.2 (D-02, D-07): within-batch gap comes from explicit steppers for
  // non-message modes. Message mode keeps the #message-gap stepper because
  // messaging existing connections has different cadence semantics.
  let delayMin, delayMax;
  if (mode === 'message_only') {
    const gap = parseInt(document.getElementById('message-gap')?.value, 10) || 60;
    delayMin = Math.max(5, Math.round(gap * 0.8));
    delayMax = Math.max(delayMin + 5, Math.round(gap * 1.3));
  } else {
    delayMin = parseInt(document.getElementById('within-batch-min')?.value, 10) || 30;
    delayMax = parseInt(document.getElementById('within-batch-max')?.value, 10) || 60;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMin, delayMin + 5];
  }

  // v2.11.0: batchesPerHour removed. Backend hardcodes a 6-min per-account
  // turn floor and lets the queue rotation pace the rest.

  // If the user answered "No" to the "add a note while connecting?" question,
  // drop the connection note regardless of what's in the textarea.
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';
  // v2.58.x — IC routes its body through primary-intro-body (CC+IC's body
  // field) so the wizard shows the SAME Intro DM Body section as CC+IC.
  // Backend still reads templates.followUpMessage (via the followUp1 alias
  // in campaign.js:1187), so we map the value here. Other modes unchanged.
  const _icBody = (mode === 'introduce_back')
    ? (document.getElementById('primary-intro-body')?.value || document.getElementById('tpl-followup').value || '')
    : document.getElementById('tpl-followup').value;
  const templates = {
    // v2.59: drop addNoteOn gate — textarea value IS the note.
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: _icBody,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
    // 2.8.50: Introduction Messages sub-mode (active only when mode is message_only)
    // v2.11.13: in-memory state instead of localStorage (storage may be blocked).
    introMode: mode === 'introduce_back',
    introName: document.getElementById('intro-name')?.value?.trim() || '',
    // Intro-flows-only — blank for CC+DM / connect_only / message_only / InMail /
    // Open Profile so a leftover CC+IC config can't leak into the campaign
    // config or the post-campaign sweep.
    introTitle: _isIntroFlow
      ? (document.getElementById('intro-title')?.value || 'Introduction: {first name} <> {intro name}')
      : '',
    // Connect + Introduce Back: primary person + intro DM body. Backend
    // stores these on the campaign config; auto-send-after-acceptance is
    // the next chunk of work. Gated to intro flows for the same reason.
    primaryName: _isIntroFlow ? (document.getElementById('primary-person-name')?.value?.trim() || '') : '',
    primaryUrl:  _isIntroFlow ? (document.getElementById('primary-person-url')?.value?.trim() || '') : '',
    primaryIntroBody: _isIntroFlow ? (document.getElementById('primary-intro-body')?.value || '') : '',
    // v2.91: CC+IC auto-accept + automated first follow-up. DOM-read at launch,
    // gated to intro flows. Backend normalizeTemplates passes these through.
    autoAcceptPrimary: _isIntroFlow ? !!document.getElementById('auto-accept-toggle')?.checked : false,
    autoAcceptAllPending: _isIntroFlow ? !!document.getElementById('auto-accept-all-toggle')?.checked : false,
    followUpEnabled: _isIntroFlow ? !!document.getElementById('follow-up-toggle')?.checked : false,
    followUpBody: _isIntroFlow ? (document.getElementById('follow-up-body')?.value || '') : '',
    followUpDelayMinutes: _isIntroFlow ? (Number(document.getElementById('follow-up-delay')?.value) || 10) : 10,
    primarySource: _isIntroFlow ? readPrimarySource() : 'local-browser',
    // v2.62: CC+DM post-acceptance body — read at launch time too
    ccDmBody: document.getElementById('tpl-cc-dm-body')?.value || '',
  };

  // v2.94.x: if either primary-side action is on and the primary is set to a
  // GoLogin profile, a profile must be chosen — else there's no browser to use.
  if (_isIntroFlow) {
    const _aaOn = !!document.getElementById('auto-accept-toggle')?.checked;
    const _fuOn = !!document.getElementById('follow-up-toggle')?.checked;
    const _src = document.querySelector('input[name="primary-source"]:checked')?.value;
    if ((_aaOn || _fuOn) && _src === 'gologin' && !(document.getElementById('primary-source-profile-id')?.value || '')) {
      if (typeof showCampaignToast === 'function') {
        showCampaignToast('Pick which GoLogin profile your primary uses, or switch to your local browser.');
      }
      return;
    }
  }

  // Show account queue
  renderAccountQueue(selectedProfileIds.map(id => selectedProfileNames[id] || id), null);

  const body = {
    profileIds: selectedProfileIds,
    // v2.78: accounts to start benched (out of the rotation).
    benchedProfileIds: [...benchedProfileIds].filter((id) => selectedProfileIds.includes(id)),
    sheetUrl,
    sheetGid: window._chosenSheetGid || '',
    multiTab: !!window._tabPickerMulti,
    templates,
    dailyLimit,
    mode,
    primaryName: templates.primaryName,
    messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked,
    delayMin,
    delayMax,
    linkedinColumn: document.getElementById('linkedin-col-select')?.value || '',
    // v2.58.x — Introduction Campaign (introduce_back) optional overrides.
    // v2.61: Extended to Direct Messages (message_only) — same wizard
    // extras block (#ic-extras) is shared so both modes pick a sender
    // column and can toggle "all leads connected". Server coerces to
    // empty/false for other modes (server.js:635-636).
    senderColumn: (mode === 'introduce_back' || mode === 'message_only')
      ? (document.getElementById('ic-sender-col-select')?.value || '')
      : '',
    allLeadsConnected: (mode === 'introduce_back' || mode === 'message_only')
      ? !!document.getElementById('ic-all-connected-toggle')?.checked
      : false,
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
    // introduce_back). v2.57.7 — IC toggle (preflight-check-toggle-ib)
    // reinstated; read whichever toggle matches the current mode. Server
    // ignores the field for any other mode.
    preflightCheckStatus: (() => {
      if (mode === 'message_only')   return !!document.getElementById('preflight-check-toggle-mo')?.checked;
      if (mode === 'introduce_back') return !!document.getElementById('preflight-check-toggle-ib')?.checked;
      return false;
    })(),
    // Operator-chosen cadence for the monitoring auto-trigger. Honoured for
    // EVERY mode that monitors for acceptance (CC+IC and CC+DM) — gated on the
    // same usesMonitoringCadence() predicate that shows the dropdown, so the
    // two can never drift. (Previously this read only fired for CC+IC, so the
    // CC+DM dropdown was shown but its value silently dropped → default 60.)
    // Server clamps to [60, 720] (shared clampCadenceMinutes) and ignores the field for other modes.
    checkIntervalMinutes: (() => {
      if (!usesMonitoringCadence(mode)) return undefined;
      const v = parseInt(document.getElementById('check-cadence-select')?.value, 10);
      return Number.isFinite(v) ? v : 60;
    })(),
    // v2.112: operator can launch with the after-sending automatic checks OFF
    // (default on). Only meaningful for monitoring modes; gated like cadence so
    // the two never drift. Backend defaults absent → enabled.
    autoChecksEnabled: usesMonitoringCadence(mode)
      ? (document.getElementById('auto-checks-toggle')?.checked !== false)
      : undefined,
    // #7: when the primary connect/check happens. Only meaningful for CC+IC;
    // omitted otherwise so the server keeps its default.
    primaryCheckTiming: (mode === 'connect_and_introduce')
      ? (document.getElementById('primary-timing-select')?.value || 'immediately')
      : undefined,
    // Task 4 (2026-06-19): pause the account when LinkedIn returns 429.
    // Default true (ON) — operator can disable in Advanced section.
    pauseOnThrottle: document.getElementById('pause-on-throttle')?.checked !== false,
  };

  // v2.58.x — IC preflight: catch "no sender column" / "no matching profile"
  // cases BEFORE the campaign starts, so the operator gets a targeted popup
  // instead of finding the failure in the post-start log rail.
  if (body.mode === 'introduce_back') {
    const ok = await _runIcPreflight(body.sheetUrl, body.senderColumn);
    if (!ok) return; // modal shown by _runIcPreflight; operator must fix
  }

  // v2.59 resume: if the operator stopped a campaign from this wizard and
  // is now pressing Start without leaving the page, treat it as a resume
  // of that campaign — name match required so editing the name then
  // starting becomes a fresh run (operator's explicit intent). The flag
  // is cleared after the start either way.
  try {
    const raw = localStorage.getItem('wizardStoppedFromContext');
    if (raw) {
      const ctx = JSON.parse(raw);
      if (ctx && ctx.name && ctx.name === (body.name || '').trim()) {
        body.resumeContext = { totalProcessed: Number(ctx.totalProcessed) || 0 };
      }
    }
  } catch {}

  // Task 6: rerun tab-change confirm — when the campaign has a saved sheetGid
  // and the operator chose a different tab, show the confirm modal.
  // Fold in the window-level savedSheetGid set by rerunPastCampaign() so the
  // modal fires even when startCampaign is called with opts={} from a button click.
  if (!opts.savedSheetGid && window._savedSheetGid) {
    opts = { ...opts, savedSheetGid: window._savedSheetGid };
  }
  if (!opts.skipTabChangeConfirm) {
    try {
      const _savedGid = String(opts.savedSheetGid || '');
      const _chosenGid = String(window._chosenSheetGid || '');
      if (_savedGid && _chosenGid && _savedGid !== _chosenGid) {
        // Find display names
        const _fromTab = (window._tabsData || []).find(t => String(t.gid) === _savedGid);
        const _toTab   = (window._tabsData || []).find(t => String(t.gid) === _chosenGid);
        const _fromLabel = (_fromTab?.name || `gid ${_savedGid}`);
        const _toLabel   = (_toTab?.name   || `gid ${_chosenGid}`);
        const _proceed = await _showTabChangeModal(_fromLabel, _toLabel);
        if (!_proceed) return;
      }
    } catch { /* non-blocking — proceed */ }
  }
  // Rerun context consumed — clear so a subsequent fresh launch isn't treated as a rerun.
  window._savedSheetGid = '';

  await submitStartCampaign(body, opts);
}

async function _runIcPreflight(sheetUrl, senderColumn) {
  try {
    const res = await fetch('/api/campaign/preflight-ic-senders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl, senderColumn: senderColumn || '' }),
    });
    const data = await res.json();
    if (data.error) {
      alert(`Could not validate sender column:\n\n${data.error}`);
      return false;
    }
    if (data.ok) return true;
    _showIcPreflightModal(data);
    return false;
  } catch (err) {
    alert(`Preflight check failed: ${err.message}`);
    return false;
  }
}

function _showIcPreflightModal(data) {
  const modal = document.getElementById('ic-preflight-modal');
  const title = document.getElementById('ic-preflight-title');
  const bodyEl = document.getElementById('ic-preflight-body');
  const primary = document.getElementById('ic-preflight-primary');
  const secondary = document.getElementById('ic-preflight-secondary');
  if (!modal || !title || !bodyEl || !primary || !secondary) return;

  modal.dataset.reason = data.reason || '';

  if (data.reason === 'no_column') {
    title.textContent = 'No sender column selected';
    bodyEl.innerHTML =
      `<p>All ${data.totalRows} rows in your sheet have a blank sender value.</p>` +
      `<p style="color: var(--gray); font-size: 0.85rem; margin-top: 10px;">` +
      `Pick the column that contains the LinkedIn 1st connections in Section 2, then try again.</p>`;
    primary.textContent = 'Take me to the column picker';
    secondary.classList.add('hidden');
  } else {
    // no_match
    const list = (data.unmatched || []).map(u =>
      `<li><code>${escHtml(u.name)}</code> &mdash; ${u.count} row${u.count === 1 ? '' : 's'}</li>`
    ).join('');
    const extra = (data.unmatched || []).length === 5 ? ' (top 5 shown)' : '';
    title.textContent = 'No matching GoLogin profile';
    bodyEl.innerHTML =
      `<p>Your sheet has sender values, but none match a GoLogin profile in this workspace.</p>` +
      (list ? `<ul style="margin: 12px 0 0; padding-left: 20px; font-size: 0.85rem; color: var(--ink);">${list}</ul>` : '') +
      `<p style="color: var(--gray); font-size: 0.8rem; margin-top: 10px;">` +
      `${data.totalRows} total row${data.totalRows === 1 ? '' : 's'}${extra}. Check that the Sender column values exactly match your GoLogin profile display names (case-sensitive).</p>`;
    primary.textContent = 'Open sheet to fix';
    secondary.classList.remove('hidden');
  }

  modal.classList.remove('hidden');
}

function closeIcPreflightModal() {
  const modal = document.getElementById('ic-preflight-modal');
  if (modal) modal.classList.add('hidden');
}

function _icPreflightPrimary() {
  const modal = document.getElementById('ic-preflight-modal');
  const reason = modal?.dataset?.reason || '';
  closeIcPreflightModal();
  if (reason === 'no_match') {
    // Open the sheet so the operator can fix the Sender column values
    if (typeof openSheetInBrowser === 'function') openSheetInBrowser();
  } else {
    // no_column → scroll + focus the IC column dropdown
    _icPreflightScrollToColumnPicker();
  }
}

function _icPreflightSecondary() {
  closeIcPreflightModal();
  _icPreflightScrollToColumnPicker();
}

// v2.58.x — Called from the IC sender-column dropdown's onchange. Marks
// the picker as "manually chosen" so subsequent previewSheet() runs don't
// stomp on the operator's pick, and hides the gold "Auto-detected" badge.
function _icSenderColManualPick() {
  const sel = document.getElementById('ic-sender-col-select');
  const badge = document.getElementById('ic-auto-detected-badge');
  if (sel) {
    sel.dataset.manualPick = '1';
    sel.classList.remove('is-detected');
  }
  if (badge) badge.classList.add('hidden');
}

function _icPreflightScrollToColumnPicker() {
  const sel = document.getElementById('ic-sender-col-select');
  if (!sel) {
    // The IC extras block is rendered by previewSheet(); if not present,
    // scroll to the sheet section so the operator can press Preview first.
    document.getElementById('nav-sheet')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => sel.focus(), 350);
}

async function submitStartCampaign(body, opts = {}) {
  // v2.59.x — Add to Queue routes to /api/campaign/queue-only, which always
  // queues and never auto-drains. The regular Start path is unchanged: it
  // hits /api/campaign/start which fires immediately if idle, queues if a
  // campaign is already running.
  const url = opts.queueOnly ? '/api/campaign/queue-only' : '/api/campaign/start';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      // v2.106.0 — mandatory operator-identity gate. Server 409s with this code
      // when this machine's operator email isn't set; show the modal, not a raw alert.
      if (res.status === 409 && txt.includes('OPERATOR_EMAIL_REQUIRED')) {
        openOperatorEmailModal({ mandatory: true });
        return;
      }
      alert(`Could not ${opts.queueOnly ? 'queue' : 'start'} campaign:\n\n${txt}`);
      return;
    }

    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || `Could not ${opts.queueOnly ? 'queue' : 'start'} campaign.`); return; }

    // Whether the campaign starts now or gets queued, the draft has been
    // consumed. Drop it from the Drafts list and clear the active id.
    // Also clear the new-campaign flag — once Start is pressed, the live
    // status / log gates should stop blanking and show the running data.
    try {
      const draftId = getActiveDraftId();
      if (draftId) {
        await fetch('/api/drafts/' + encodeURIComponent(draftId), { method: 'DELETE' }).catch(() => {});
      }
      clearActiveDraft();
      localStorage.removeItem('wizardStoppedFromContext');
      // v2.71: if we entered via Edit pencil on a stopped past row, that
      // source row is now superseded by the freshly-launched resume — drop
      // it from history so the dashboard doesn't accumulate duplicates.
      // Matches resumeWithSameSettings's same-FIFO behaviour.
      try {
        const srcRaw = localStorage.getItem('editResumeSourceIdx');
        const srcIdx = srcRaw != null ? parseInt(srcRaw, 10) : NaN;
        if (Number.isInteger(srcIdx) && srcIdx >= 0) {
          await fetch('/api/history/delete-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ indexes: [srcIdx] }),
          }).catch(() => {});
        }
        localStorage.removeItem('editResumeSourceIdx');
      } catch {}
      // Hide the edit-resume banner now that the resume has launched.
      const banner = document.getElementById('wizard-resume-banner');
      if (banner) banner.style.display = 'none';
    } catch {}
    wizardDirty = false;
    _runningEditWarningShown = false;

    // Server queued the campaign — either explicit queue-only, or because
    // another campaign was already running on the regular start path.
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

// ── v2.106.0 — Mandatory per-machine operator identity ──────────────────
// Every operator's app logs in with the SAME shared dashboard credential, so
// the login can't say who's actually operating. This email is the authoritative
// reserver stamped into the SoO 'CC User App' column, and is REQUIRED before any
// campaign can start (the server gates start/queue; this UI mirrors that).
let _operatorEmailMandatory = false;

async function initOperatorIdentity() {
  try {
    const r = await fetch('/api/operator-identity');
    const d = await r.json();
    _setOperatorChip(d && d.email);
    if (!d || !d.set) openOperatorEmailModal({ mandatory: true });
  } catch { /* offline — the server-side start gate still protects it */ }
}

function _setOperatorChip(email) {
  const el = document.getElementById('operator-chip-email');
  if (el) el.textContent = email || 'not set — click to set';
  const chip = document.getElementById('operator-chip');
  if (chip) chip.classList.toggle('operator-chip--unset', !email);
}

function openOperatorEmailModal(opts = {}) {
  _operatorEmailMandatory = !!opts.mandatory;
  const modal = document.getElementById('operator-email-modal');
  if (!modal) return;
  const cancel = document.getElementById('operator-email-cancel');
  if (cancel) cancel.style.display = _operatorEmailMandatory ? 'none' : '';
  const err = document.getElementById('operator-email-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  const input = document.getElementById('operator-email-input');
  // Pre-fill with the current value when editing (non-mandatory re-open).
  if (input && !_operatorEmailMandatory) {
    const cur = document.getElementById('operator-chip-email');
    const v = cur ? cur.textContent.trim() : '';
    input.value = /@/.test(v) ? v : '';
  }
  modal.classList.remove('hidden');
  if (input) setTimeout(() => input.focus(), 50);
}

function closeOperatorEmailModal() {
  if (_operatorEmailMandatory) return; // can't dismiss the mandatory gate
  const modal = document.getElementById('operator-email-modal');
  if (modal) modal.classList.add('hidden');
}

async function saveOperatorEmail() {
  const input = document.getElementById('operator-email-input');
  const err = document.getElementById('operator-email-error');
  const email = ((input && input.value) || '').trim();
  const showErr = (m) => { if (err) { err.textContent = m; err.hidden = false; } };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('Enter a valid email address.'); return; }
  try {
    const r = await fetch('/api/operator-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { showErr((d && d.error) || 'Could not save — try again.'); return; }
    _setOperatorChip(d.email);
    _operatorEmailMandatory = false;
    const modal = document.getElementById('operator-email-modal');
    if (modal) modal.classList.add('hidden');
  } catch {
    showErr('Network error — try again.');
  }
}

document.addEventListener('DOMContentLoaded', initOperatorIdentity);
window.openOperatorEmailModal = openOperatorEmailModal;
window.closeOperatorEmailModal = closeOperatorEmailModal;
window.saveOperatorEmail = saveOperatorEmail;

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
    delayMin: body?.delayMin ?? 30,
    delayMax: body?.delayMax ?? 60,
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
    delayMin: 30,
    delayMax: 60,
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
  // v2.59 resume: snapshot the running campaign's identity + totals BEFORE
  // sending the stop so the wizard's next Start can route as a resume
  // instead of spawning a fresh run. Stored by name (since stable ids
  // don't exist yet); wizard Start matches by name comparison.
  try {
    if (typeof __cockpit !== 'undefined' && __cockpit && (__cockpit.running || __cockpit.paused)) {
      const ctx = {
        name: (__cockpit.name || '').trim(),
        totalProcessed: Number(__cockpit.totalProcessed) || 0,
        savedAt: Date.now(),
      };
      if (ctx.name) localStorage.setItem('wizardStoppedFromContext', JSON.stringify(ctx));
    }
  } catch {}
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
  // CC+IC and CC+DM both run a phase-2 monitoring loop after the
  // connection phase. Give the operator the choice between halting
  // everything vs. just stopping new sends and letting acceptances
  // continue to flow through auto-intro / auto-DM dispatch.
  if (__cockpit && (__cockpit.mode === 'connect_and_introduce' || __cockpit.mode === 'connect_and_message')) {
    const modal = document.getElementById('stop-choice-modal');
    if (modal) {
      const isDm = __cockpit.mode === 'connect_and_message';
      const eyebrow = modal.querySelector('.stop-choice-eyebrow');
      const monitorSub = modal.querySelector('.stop-choice-pill.is-monitor .stop-choice-pill-sub');
      if (eyebrow) {
        eyebrow.textContent = isDm
          ? 'Stop campaign · Connect + DM'
          : 'Stop campaign · Connect + Introduce Back';
      }
      if (monitorSub) {
        monitorSub.textContent = isDm
          ? 'Bulk-check fires now, then every 6 h for 7 days. Auto-DMs still fire on accept.'
          : 'Bulk-check fires now, then every 6 h for 7 days. Auto-intro DMs still fire on accept.';
      }
      modal.classList.remove('hidden');
    }
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
      // v2.52.0: optimistic state flip. Server confirms state='done' on
      // any ok=true response — push it into __cockpit immediately so the
      // cockpit panel stops rendering MONITORING / WATCHING FOR ACCEPTANCES
      // without waiting up to 2s for the next pollStatus tick. Then force
      // a poll so monitoringUntil/nextCheckAt clear too. The overlay fires
      // from updateCockpit's monitoring→done transition detector.
      if (typeof __cockpit !== 'undefined') {
        __cockpit.state = 'done';
        __cockpit.monitoringCheckInProgress = false;
        if (typeof renderCockpit === 'function') renderCockpit();
      }
      if (typeof pollStatus === 'function') pollStatus().catch(() => {});

      // alreadyStopped → operator double-clicked; first call already did the work.
      const msg = res.alreadyStopped
        ? 'Monitoring already ended.'
        : 'Monitoring ended. Still-pending leads kept as "Connection Request Sent".';
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
// Issue #5 Part B — Edit-while-paused panel.
// Backend (Part A) accepts edits via three POST routes, but ONLY while the
// campaign is running AND fully paused (__cockpit.paused === true). This
// panel surfaces those three knobs (daily limit, check cadence, and the one
// mode-relevant message body) and posts them on "Apply changes".
//
// Pre-fill happens once on the hidden→shown transition (so the 250ms render
// tick never stomps the operator's typing). The message-body source is
// /api/campaign/active-settings (status doesn't carry templates); daily
// limit + cadence come straight from __cockpit.
// ─────────────────────────────────────────────────────────────────────────
let _peFilled = false;   // true while pre-filled & shown — gate re-fill per pause
let _peWired = false;    // guard so the Apply handler binds exactly once

// Decide which template body field this campaign's mode edits.
// Returns { field, label }. Mirrors the wizard's field spellings so the
// backend's normalizeTemplates understands the payload.
function _pePickBodyField(mode) {
  if (mode === 'connect_and_introduce') return { field: 'primaryIntroBody', label: 'Introduction message' };
  if (mode === 'connect_and_message')   return { field: 'ccDmBody',         label: 'DM message' };
  return { field: 'connectionNote', label: 'Connection note' };
}

// Read the mode-appropriate body out of a templates object, tolerating the
// connectionNote/note alias the wizard uses interchangeably.
function _peReadBody(templates, field) {
  const t = templates || {};
  if (field === 'connectionNote') return t.connectionNote || t.note || '';
  return t[field] || '';
}

function renderPauseEditPanel() {
  const panel = document.getElementById('pause-edit-panel');
  if (!panel) return;

  // Not (fully) paused → hide and reset the pre-fill gate so the next pause
  // re-fills fresh from the live values.
  if (!__cockpit || __cockpit.paused !== true) {
    panel.hidden = true;
    panel.style.display = 'none';
    _peFilled = false;
    // Also hide the account-add section sibling. Both hidden AND display:none are needed —
    // .cockpit-panel is display:flex, which overrides [hidden] (same pattern as the panels above).
    const aas = document.getElementById('acct-add-section');
    if (aas) { aas.hidden = true; aas.style.display = 'none'; }
    return;
  }

  // Wire the Apply button once (idempotent across ticks).
  if (!_peWired) {
    const applyBtn = document.getElementById('pe-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', _peApplyChanges);
      _peWired = true;
    }
  }

  // First tick of this pause: pre-fill once, then unhide.
  if (!_peFilled) {
    _peFilled = true;
    _pePrefillFields();
    panel.hidden = false;
    panel.style.display = 'flex';
    // v2.112 (#2b): populate the Add account control on first pause tick.
    if (typeof renderPauseAccountAdd === 'function') renderPauseAccountAdd();
    return;
  }

  // Already filled + shown — ensure it's visible (no re-fill: don't stomp typing).
  if (panel.hidden) {
    panel.hidden = false;
    panel.style.display = 'flex';
  }
}

function _pePrefillFields() {
  const { field, label } = _pePickBodyField(__cockpit.mode);

  // Label reflects the mode-relevant body.
  const labelEl = document.getElementById('pe-template-label');
  if (labelEl) labelEl.textContent = label;

  // Daily limit — from the live status mirror; min 1.
  const dlEl = document.getElementById('pe-daily-limit');
  if (dlEl) {
    const dl = Number(__cockpit.dailyLimit);
    dlEl.value = Number.isFinite(dl) && dl > 0 ? String(dl) : '';
  }

  // Cadence — match the live value to one of the select options.
  const cadEl = document.getElementById('pe-cadence');
  if (cadEl) {
    const cad = Number(__cockpit.checkIntervalMinutes);
    cadEl.value = [60, 120, 240, 360, 720].includes(cad) ? String(cad) : '60';
  }

  // Message body — prefer the live templates snapshot already on __cockpit;
  // otherwise fetch the active-settings snapshot (best-effort, async). Guard
  // the async fill so it doesn't overwrite the operator if they've started
  // typing or the pause already ended by the time the fetch resolves.
  const bodyEl = document.getElementById('pe-template-body');
  if (bodyEl) {
    const fromCockpit = _peReadBody(__cockpit.templates, field);
    bodyEl.value = fromCockpit;
    if (!fromCockpit) {
      fetch('/api/campaign/active-settings')
        .then(r => r.json())
        .then(data => {
          if (!data || !data.ok || !data.settings) return;
          // Only apply if we're still mid pre-fill and the operator hasn't typed.
          if (!_peFilled || __cockpit.paused !== true) return;
          if (bodyEl.value) return;
          bodyEl.value = _peReadBody(data.settings.templates, field);
        })
        .catch(() => { /* best-effort — operator can type the body */ });
    }
  }
}

async function _peApplyChanges() {
  if (!__cockpit || __cockpit.paused !== true) {
    showCampaignToast('Pause the campaign first — edits only apply while paused.', 4000);
    return;
  }

  const { field } = _pePickBodyField(__cockpit.mode);
  const dlEl = document.getElementById('pe-daily-limit');
  const cadEl = document.getElementById('pe-cadence');
  const bodyEl = document.getElementById('pe-template-body');

  const calls = [];   // [{ url, body, name }]

  // Daily limit — send only when it's a valid number that differs from live.
  const dl = parseInt(dlEl ? dlEl.value : '', 10);
  if (Number.isFinite(dl) && dl >= 1 && dl <= 1000 && dl !== Number(__cockpit.dailyLimit)) {
    calls.push({ url: '/api/campaign/live/daily-limit', body: { dailyLimit: dl }, name: 'Daily limit' });
  }

  // Cadence — send only when changed.
  const cad = parseInt(cadEl ? cadEl.value : '', 10);
  if (Number.isFinite(cad) && cad !== Number(__cockpit.checkIntervalMinutes)) {
    calls.push({ url: '/api/campaign/live/cadence', body: { checkIntervalMinutes: cad }, name: 'Cadence' });
  }

  // Message body — send the full templates object with the one edited field
  // overwritten, so the backend's normalizeTemplates sees the same shape the
  // wizard sends. Only send when non-empty and actually changed.
  const newBody = bodyEl ? bodyEl.value : '';
  const liveBody = _peReadBody(__cockpit.templates, field);
  if (newBody.trim() && newBody !== liveBody) {
    const templates = { ...(__cockpit.templates || {}) };
    templates[field] = newBody;
    // Keep the connectionNote/note alias consistent for the connect_only path.
    if (field === 'connectionNote') templates.note = newBody;
    calls.push({ url: '/api/campaign/live/templates', body: { templates }, name: 'Message' });
  }

  if (calls.length === 0) {
    showCampaignToast('No changes to apply.', 2500);
    return;
  }

  const applied = [];
  const failed = [];
  for (const c of calls) {
    try {
      const r = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      let data = {};
      try { data = await r.json(); } catch { /* non-JSON → treat as failure below */ }
      if (data && data.ok) {
        applied.push(c.name);
        // Mirror the accepted value back onto __cockpit so the "changed?"
        // checks above don't re-fire it on the next Apply.
        if (c.url.endsWith('/daily-limit')) __cockpit.dailyLimit = c.body.dailyLimit;
        else if (c.url.endsWith('/cadence')) __cockpit.checkIntervalMinutes = c.body.checkIntervalMinutes;
        else if (c.url.endsWith('/templates')) __cockpit.templates = c.body.templates;
      } else {
        failed.push(`${c.name}: ${(data && data.reason) || 'failed'}`);
      }
    } catch (err) {
      failed.push(`${c.name}: ${err.message}`);
    }
  }

  if (failed.length) {
    showCampaignToast(`Couldn't apply — ${failed.join('; ')}`, 6000);
  } else {
    showCampaignToast(`Saved ${applied.join(' + ')} — applies on Resume.`, 4000);
  }
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
  sheetUrl: '',
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
      + '<p style="margin:0 0 22px;color:#444;font-size:0.95rem;line-height:1.45;">Still-pending invitations remain <i>Connection Request Sent</i> — they may still accept later. Returning to the dashboard…</p>'
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
  // v2.58.x — runbar mirror reads __cockpit.name to populate the identity
  // slot. Without this assignment the runbar permanently showed
  // "Untitled · CC+IB" even when /api/campaign/status returned a real
  // campaign name (the dashboard active row was rendering correctly
  // because it reads from the fetch response directly).
  __cockpit.name = s.name || '';
  // v2.59 — mirror totalProcessed too. The wizard Stop→Start resume
  // path (stopCampaign at L3219, wizardStoppedFromContext.totalProcessed)
  // snapshots this off __cockpit, then ships it server-side as
  // resumeContext so campaign.js can seed the counter. Before this
  // mirror the snapshot was always 0 — counter-continuation silently
  // broke from the wizard path (the past-row RESUME chip path worked
  // because it reads from history, not __cockpit).
  __cockpit.totalProcessed = Number(s.totalProcessed) || 0;
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
  __cockpit.skippedProfiles = s.skippedProfiles || [];
  __cockpit.sheetUrl = s.sheetUrl || '';
  // Issue #5 Part B: mirror the live-editable settings so renderPauseEditPanel
  // can pre-fill the daily-limit + cadence fields. (templates aren't on the
  // status payload — the pause panel fetches /api/campaign/active-settings for
  // the message body instead.)
  if (s.dailyLimit != null) __cockpit.dailyLimit = s.dailyLimit;
  if (s.checkIntervalMinutes != null) __cockpit.checkIntervalMinutes = s.checkIntervalMinutes;
  // v2.72: track the "finished" state so the wizard keeps the Live Status card
  // (log + Run reply check) visible after a campaign ends, not just while it runs.
  __cockpit.endNotice = s.endNotice || null;
  __cockpit.hasLogs = Array.isArray(s.logs) && s.logs.length > 0;
  _refreshOpenSheetButtons();
  renderCockpit();
  // Issue #5 Part B: keep the edit-while-paused panel in sync with paused state.
  if (typeof renderPauseEditPanel === 'function') renderPauseEditPanel();
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

  // Blank the entire Live Status cockpit when the operator is composing a
  // new, unstarted campaign — that tab represents zero activity regardless
  // of what's running globally. Full per-campaign scoping comes with the
  // isolation refactor.
  if (typeof isOnNewCampaignView === 'function' && isOnNewCampaignView()) {
    ring.classList.remove('indeterminate', 'paused', 'monitoring');
    ringFg.style.strokeDashoffset = COCKPIT_RING_CIRCUMFERENCE;
    num.textContent = '—';
    unit.textContent = 'idle';
    if (footer) footer.textContent = '';
    tag.textContent = 'IDLE';
    dot.classList.remove('live', 'paused-dot', 'monitoring');
    action.textContent = 'No activity for this campaign';
    if (lead) lead.textContent = '—';
    if (account) account.textContent = '—';
    if (modeEl) modeEl.textContent = '—';
    const _leadLabel = document.querySelector('.cockpit-meta-label[data-cockpit-row="lead"]') || lead?.previousElementSibling;
    if (_leadLabel) _leadLabel.textContent = 'Lead';
    const _accountLabel = document.querySelector('.cockpit-meta-label[data-cockpit-row="account"]') || account?.previousElementSibling;
    if (_accountLabel) _accountLabel.textContent = 'Account';
    const stToday = document.getElementById('st-today');
    const stTotal = document.getElementById('st-total');
    const stErrors = document.getElementById('st-errors');
    const stBar = document.getElementById('st-bar');
    if (stToday) stToday.textContent = '0';
    if (stTotal) stTotal.textContent = '0';
    if (stErrors) stErrors.textContent = '0';
    if (stBar) stBar.style.width = '0%';
    const acctQueue = document.getElementById('account-queue');
    if (acctQueue) { acctQueue.classList.add('hidden'); acctQueue.innerHTML = ''; }
    const bcl = document.querySelector('.bulk-check-live');
    if (bcl) bcl.hidden = true;
    return;
  }

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
  // v2.57.7: added connect_and_introduce + introduce_back so the runbar
  // doesn't leak raw enums into the UI (was rendering as
  // "CONNECT_AND_INTRODUCE" — uppercased + wrapping the action strip).
  const map = {
    connect_only: 'Connect',
    connect_and_introduce: 'CC+IB',
    connect_and_message: 'CC+DM',
    introduce_back: 'IC',
    message_only: 'Message',
    inmail_only: 'InMail',
    open_profile_only: 'Open Profile',
    check_status: 'Check Status',
    check_dms: 'Check DMs',
    post_amplification: 'Post amp',
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

// v2.59.x — Swap the gold class between Start and Add to Queue based on
// whether a campaign is currently running. Idle: Start is gold, Queue is
// outlined. Running: Start is dimmed/outlined, Queue is gold. Called from
// setCampaignButtons (status-driven) and updateWizardQueueState (wizard
// entry, before polling kicks in).
function _applyLaunchButtonClasses(running) {
  const startBtn = document.getElementById('btn-start');
  const queueBtn = document.getElementById('btn-queue');
  if (!startBtn || !queueBtn) return;
  if (running) {
    startBtn.classList.remove('btn-start');
    startBtn.classList.add('btn-secondary');
    queueBtn.classList.remove('btn-secondary');
    queueBtn.classList.add('btn-start');
  } else {
    startBtn.classList.remove('btn-secondary');
    startBtn.classList.add('btn-start');
    queueBtn.classList.remove('btn-start');
    queueBtn.classList.add('btn-secondary');
  }
}

function setCampaignButtons(running, paused = false, pauseRequested = false) {
  // v2.59.x — Side-by-side Start + Add to Queue pills (Variant A). Start
  // is always present and shows the campaign-can-fire intent (gold when
  // idle, dimmed when one is already running). btn-queue is always enabled
  // — the operator can stage a queued campaign regardless of state — and
  // takes the gold treatment while something is running, so it's the
  // visually-active action in that moment. _applyLaunchButtonClasses
  // handles the gold class swap so the wizard-poller and the status-poller
  // both stay in sync.
  ['btn-start', 'btn-start-rb'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = running;
  });
  const queueBtn = document.getElementById('btn-queue');
  if (queueBtn) queueBtn.disabled = false;
  _applyLaunchButtonClasses(running);
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
  // Bug 15: keep the editor's launch rail in sync with live campaign state every
  // poll — swaps "+ Launch options" for the Pause/Stop/Save control bar while a
  // campaign runs/monitors, and back once it's fully stopped.
  if (typeof window.updateEditingBanner === 'function') {
    try { window.updateEditingBanner(); } catch (_) {}
  }
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

    // v0.3 dashboard renderers — paint the Active + Monitoring cards from the
    // same status snapshot. Guard with typeof check so the call is a no-op
    // until the renderers are defined (and survives partial reloads).
    if (typeof window.renderActiveCard === 'function') window.renderActiveCard(s);
    if (typeof window.renderMonitoringCard === 'function') window.renderMonitoringCard(s);
    if (typeof maybeShowCampaignDoneModal === 'function') maybeShowCampaignDoneModal(s);
    if (typeof maybeShowLoginModal === 'function') maybeShowLoginModal(s);

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
      // On the new-campaign view, force the button state to idle — the
      // running campaign is somebody else's, not this draft. Start should
      // be live so the operator can launch (or queue) this draft;
      // Pause/Stop/Force-restart should be disabled because they'd act on
      // the other campaign, not this one. The actual one-at-a-time backend
      // constraint is enforced server-side (queue-or-409); UI just reflects
      // the per-tab story.
      const _isNewView = typeof isOnNewCampaignView === 'function' && isOnNewCampaignView();
      if (_isNewView) setCampaignButtons(false);
      else setCampaignButtons(true, !!s.paused, !!s.pauseRequested);
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
      // v2.72: keep polling while the operator is on the wizard so the finished
      // Live Status card (log + Run reply check) stays rendered there. Stop only
      // when they're off the wizard (the dashboard has its own poll).
      const _onWizardRoute = (typeof document !== 'undefined' && document.body.classList.contains('route-wizard'))
        || (typeof location !== 'undefined' && location.hash === '#/new');
      if (s.logs?.length > 0 && !s.running && s.state !== 'monitoring' && !_onWizardRoute) stopPolling();
    }

    const profEl = document.getElementById('st-profile');
    if (profEl) profEl.textContent = s.currentProfile || '—';
    const modeEl = document.getElementById('st-mode');
    if (modeEl) {
      const modeLabels = {
        connect_only: 'Connect Only',
        message_only: 'Direct Messages', inmail_only: 'InMail Only', check_status: 'Check Status',
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

    // Update account queue if we have profile names. Suppress on the
    // new-campaign view so the running campaign's queue doesn't flash in
    // between renderCockpit's blanking ticks. renderCockpit already hides
    // #account-queue; this stops the repaint from undoing that.
    const _isNewView = typeof isOnNewCampaignView === 'function' && isOnNewCampaignView();
    if (!_isNewView && s.profileNames && s.profileNames.length > 0) {
      renderAccountQueue(s.profileNames, s.currentProfile, s, s.profileIds);
    }

    // Blank the main log on new-campaign view so a globally-running
    // campaign's lines don't bleed into a freshly-opened wizard tab.
    if (typeof isOnNewCampaignView === 'function' && isOnNewCampaignView()) {
      const panel = document.getElementById('log-panel');
      if (panel) panel.innerHTML = '<div class="entry info">No activity for this campaign.</div>';
    } else if (s.logs?.length > 0) {
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

    // Floating live console — runs on every poll tick. Idempotent; only
    // writes DOM when values change (see _lcWriteCache).
    try { renderLiveConsole(s); } catch (err) { console.warn('[live-console] render failed:', err.message); }

    // v2.61: Live Status section visibility — only renders when we're on
    // the wizard view of the currently-running campaign. Hidden for
    // drafts/queue/schedule views so the Launch section becomes the last
    // visible section (no blank space underneath).
    try { syncLiveStatusVisibility(); } catch (err) { console.warn('[live-status] sync failed:', err.message); }
  } catch { /* */ }
}

// v2.61: Live Status section visibility. The section (#nav-status) and its
// sidebar nav item are display:none unless:
//   - we're on the wizard view (#/new)
//   - AND a campaign is currently running (__cockpit.running) OR monitoring
//     (__cockpit.state === 'monitoring')
//   - AND we are NOT editing a draft (isOnNewCampaignView() === false)
// v2.59.16: the monitoring clause was missing — during the post-send
// monitoring phase __cockpit.running is false, so the Live Status section
// (and its log) AND the "Open log" / "Live Status" nav buttons were hidden.
// That's why the log "disappeared" in monitoring and "Open log" did nothing
// (it scrolled to a display:none element). Monitoring is a live phase too.
// The "editing a draft" check leverages the existing heuristic: clicking
// "View running" from the dashboard clears activeDraftId, so navigating
// into a running campaign satisfies the third condition.
// v2.86.1 (port): set true when the operator clicks the sidebar "Open log" so
// the Live Status section is revealed even when idle (no campaign ran this
// session). Without it, "Open log" was a no-op when nothing was running — it
// scrolled to a display:none element. Reset on leaving the wizard (applyRoute).
let liveStatusForcedOpen = false;
function syncLiveStatusVisibility() {
  const sec = document.getElementById('nav-status');
  if (!sec) return;
  const onNew = typeof location !== 'undefined' && location.hash === '#/new';
  const editingDraft = (typeof isOnNewCampaignView === 'function') && isOnNewCampaignView();
  const running = !!(typeof __cockpit !== 'undefined' && __cockpit && __cockpit.running);
  const monitoring = !!(typeof __cockpit !== 'undefined' && __cockpit && __cockpit.state === 'monitoring');
  // v2.72: also keep the section visible once a campaign has FINISHED (not
  // running, not monitoring, but it ran this session — endNotice/logs present)
  // so the operator can still read the log and hit "Run reply check now".
  const finished = !!(typeof __cockpit !== 'undefined' && __cockpit && !__cockpit.running
    && __cockpit.state !== 'monitoring' && (__cockpit.endNotice || __cockpit.hasLogs));
  // Running/monitoring are hidden while editing an unrelated draft; a FINISHED
  // campaign's log is shown regardless (the wizard resets to a fresh draft on
  // finish, so editingDraft is true — but the operator still wants the log).
  const show = onNew && (liveStatusForcedOpen || ((running || monitoring) && !editingDraft) || finished);
  sec.style.display = show ? '' : 'none';
  const navBtn = document.querySelector('[data-nav="nav-status"]');
  if (navBtn) navBtn.style.display = show ? '' : 'none';
  // v2.59.22: relocate the live card into / out of the wizard slot.
  try { placeLiveCard(); } catch (_) { /* */ }
}
if (typeof window !== 'undefined') window.syncLiveStatusVisibility = syncLiveStatusVisibility;

// v2.59.22: move the single #active-card between its dashboard home and the
// wizard Live Status slot so both routes show the IDENTICAL card (zero drift —
// renderActiveCard drives the same element wherever it lives). In the wizard
// it gets full width + a taller, always-open log via .in-wizard.
let _activeCardHome = null;
function placeLiveCard() {
  const card = document.getElementById('active-card');
  const slot = document.getElementById('wiz-live-slot');
  const sec = document.getElementById('nav-status');
  if (!card) return;
  // Capture the dashboard home (parent + next sibling) once, before any move.
  if (!_activeCardHome && card.parentElement && card.parentElement.id !== 'wiz-live-slot') {
    _activeCardHome = { parent: card.parentElement, next: card.nextElementSibling };
  }
  const onWizard = document.body.classList.contains('route-wizard');
  const liveVisible = !!sec && sec.style.display !== 'none';
  // v2.86.1 (port): follow the section's visibility even when the card is empty.
  // When "Open log" forces the section open while idle, the dashboard card's
  // "No campaign running" empty state is exactly what should show — instead of
  // falling back to the legacy cockpit panel. (Was: && !is-empty.)
  const wantWizard = onWizard && liveVisible;
  if (wantWizard && slot) {
    if (card.parentElement !== slot) {
      slot.appendChild(card);
      // Expand the section once on first placement so the card is visible —
      // not every poll, so a manual collapse afterwards still sticks.
      if (sec) sec.classList.remove('collapsed');
    }
    card.classList.add('in-wizard', 'is-detailed');
    if (sec) sec.classList.add('is-card-live');
  } else {
    if (card.classList.contains('in-wizard')) {
      card.classList.remove('in-wizard');
      if (_activeCardHome && _activeCardHome.parent) {
        _activeCardHome.parent.insertBefore(card, _activeCardHome.next || null);
      }
    }
    if (sec) sec.classList.remove('is-card-live');
  }
}
if (typeof window !== 'undefined') window.placeLiveCard = placeLiveCard;

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
    // v2.72: restore Open Profile send channel + InMail fallback
    const opChannel = document.getElementById('tpl-op-channel');
    if (opChannel) opChannel.value = tpl.opChannel || 'sn_first';
    const opSpendInMail = document.getElementById('tpl-op-spend-inmail');
    if (opSpendInMail) opSpendInMail.checked = !!tpl.opSpendInMail;
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
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
    primaryIntroBody: document.getElementById('primary-intro-body')?.value || '',
    ccDmBody: document.getElementById('tpl-cc-dm-body')?.value || '',
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
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
    primaryIntroBody: document.getElementById('primary-intro-body')?.value || '',
    ccDmBody: document.getElementById('tpl-cc-dm-body')?.value || '',
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
      message_only: 'Direct Messages', inmail_only: 'InMail Only', check_status: 'Check Status',
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
  // v2.61: Launch section's Now/Schedule toggle was replaced by 4 inline
  // buttons (Start / Queue / Schedule / Save as draft). The toggle and its
  // two panels no longer exist in the DOM, so each getElementById can
  // legitimately return null. Guard each access so any stale caller
  // (autosave restore, preset load) becomes a no-op instead of a throw.
  const isSchedule = mode === 'schedule';
  const tabNow = document.getElementById('launch-mode-now');
  const tabSched = document.getElementById('launch-mode-schedule');
  if (tabNow) tabNow.classList.toggle('active', !isSchedule);
  if (tabSched) tabSched.classList.toggle('active', isSchedule);
  const now = document.getElementById('launch-now-panel');
  const sched = document.getElementById('launch-schedule-panel');
  if (now) {
    now.classList.toggle('panel-active', !isSchedule);
    now.classList.toggle('panel-inactive', isSchedule);
  }
  if (sched) {
    sched.classList.toggle('panel-active', isSchedule);
    sched.classList.toggle('panel-inactive', !isSchedule);
  }
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
    delayMin = parseInt(document.getElementById('within-batch-min')?.value, 10) || 30;
    delayMax = parseInt(document.getElementById('within-batch-max')?.value, 10) || 60;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMin, delayMin + 5];
  }

  // v2.11.0: batchesPerHour removed from schedules too — pacing is now the
  // 6-min turn floor + queue rotation, no per-schedule throughput knob.

  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';
  const templates = {
    // v2.59: drop addNoteOn gate — textarea value IS the note.
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
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
  // v2.57.7: optimistic removal so the row disappears immediately from
  // both the Schedules panel and the ALL-tab clone.
  document.querySelectorAll(`.campaign-row[data-campaign-id="${CSS.escape(id)}"]`)
    .forEach((el) => el.remove());
  try {
    const res = await fetch('/api/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json();
    if (data.deleted) {
      if (typeof fetchSchedules === 'function') await fetchSchedules();
      if (typeof refreshDashboardSchedules === 'function') await refreshDashboardSchedules();
      if (typeof renderDashboardAll === 'function') renderDashboardAll();
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
  // Dashboard v0.3 CSS uses .theme-dark as its override convention; keep it
  // in sync so v0.3 follows the same theme button as the rest of the app.
  document.body.classList.toggle('theme-dark', !isLight);
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
  // v2.57.7: top line of the two-line status stack — shows the running
  // campaign's name. Empty in idle state (CSS hides empty via :empty).
  const nameEl = document.getElementById('run-bar-name');
  const statusSection = document.getElementById('nav-status');
  if (!bar || !txt) return;
  let wasRunning = false;
  const sync = () => {
    // Force idle state for the bottom runbar when composing a new campaign
    // — the global running campaign's identity/stats shouldn't leak in.
    const newView = (typeof isOnNewCampaignView === 'function') && isOnNewCampaignView();
    const running = !newView && !!__cockpit.running;
    const monitoring = !newView && !running && __cockpit.state === 'monitoring';
    bar.classList.toggle('running', running);
    bar.classList.toggle('monitoring', monitoring);
    const mode = formatMode(__cockpit.mode);
    const today = document.getElementById('st-today')?.textContent || '0';
    const total = document.getElementById('st-total')?.textContent || '0';
    const cName = (__cockpit.name || '').trim();
    // v2.57.7: when no campaign name is set, fold the mode into the
    // identity slot ("Untitled · CC+IB") and drop it from the status
    // text. Avoids duplication and gives a hint of what kind of campaign
    // is live even when it's nameless.
    const identity = cName || `Untitled · ${mode}`;
    if (running) {
      const label = __cockpit.paused ? 'Paused' : (__cockpit.pauseRequested ? 'Pausing…' : 'Running');
      if (nameEl) nameEl.textContent = identity;
      // Status text strips the profile name (was too long, wrapped the
      // action strip) and only shows mode when a real name is set —
      // otherwise the mode already sits in the identity slot.
      const modePart = cName ? `${mode} · ` : '';
      txt.innerHTML = `<strong>${label}</strong> · ${modePart}${today}/${total}`;
    } else if (monitoring) {
      // v2.13.14 — surface monitoring countdown in the sticky toolbar.
      // v2.14.x — when a bulk-check is mid-fire, swap to "checking now…".
      // v2.57.7 — also surface the campaign name on the top line so the
      // operator sees which campaign is being monitored.
      if (nameEl) nameEl.textContent = identity;
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
      // v2.57.7 — idle: clear the name line so the status stack collapses
      // to the single "Idle · no campaign" row.
      if (nameEl) nameEl.textContent = '';
      txt.textContent = 'Idle · no campaign';
    }

    // Right-pane status mirror
    const rpDot = document.getElementById('rp-dot');
    const rpStatusText = document.getElementById('rp-status-text');
    const rpStatusSub = document.getElementById('rp-status-sub');
    // When the operator is composing a brand-new campaign, the right-pane
    // should look idle regardless of what other campaigns are doing — that
    // tab represents an unstarted campaign. Full per-campaign live scoping
    // comes with the isolation refactor.
    const onNewCampaignView = (typeof isOnNewCampaignView === 'function') && isOnNewCampaignView();
    if (rpDot) {
      rpDot.classList.toggle('running', !onNewCampaignView && running);
      rpDot.classList.toggle('monitoring', !onNewCampaignView && monitoring);
    }
    if (rpStatusText) rpStatusText.textContent = onNewCampaignView ? 'Idle' : (running ? 'Running' : (monitoring ? 'Monitoring' : 'Idle'));
    if (rpStatusSub) {
      if (onNewCampaignView) {
        rpStatusSub.textContent = 'No activity for this campaign';
      } else if (running) {
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
  if (typeof isOnNewCampaignView === 'function' && isOnNewCampaignView()) {
    feed.innerHTML = '<div class="rp-feed-item"><span class="rp-feed-time">—</span><span class="rp-feed-text">No activity for this campaign</span></div>';
    return;
  }
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
    const rcb = document.getElementById('notif-pref-reply-alerts');
    if (rcb) rcb.checked = !!prefs.replyAlerts;
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

// ── v2.58.x — Per-operator timezone ────────────────────────────────────
// Confirms on first launch after this update lands (skippable; re-prompts
// next launch). Saving stores the choice via /api/operator-prefs and the
// bot then sends `tz` on every Apps Script write so timestamps land in
// the launcher's local time.

function _detectLocalTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
  catch { return ''; }
}

// Featured zones surfaced at the top of the dropdown so the three operator
// locations are one click away. Label is the city name the operator thinks
// in; value is the canonical IANA zone (Kosovo has no Europe/Pristina —
// Europe/Belgrade is the IANA-blessed zone for the region).
const _FEATURED_TZS = [
  { label: 'Rome',     value: 'Europe/Rome' },
  { label: 'Pristina', value: 'Europe/Belgrade' },
  { label: 'Manila',   value: 'Asia/Manila' },
];

// Sidebar label resolver: friendly city name for featured zones, raw IANA
// for everything else. Keeps the "Pristina" label consistent across modal
// and sidebar even though the persisted value is Europe/Belgrade.
function _tzDisplayLabel(tz) {
  if (!tz) return '—';
  const hit = _FEATURED_TZS.find(t => t.value === tz);
  return hit ? hit.label : tz;
}

function _populateTzSelect(selectedTz) {
  const sel = document.getElementById('op-tz-select');
  if (!sel) return;
  let zones = [];
  try {
    // Intl.supportedValuesOf — available in Chromium 111+. Electron 33
    // ships Chromium 130 so this is safe per package.json.
    zones = Intl.supportedValuesOf('timeZone') || [];
  } catch { zones = []; }
  if (!zones.length) zones = [selectedTz || 'UTC'];
  // Defensive: include the saved value even if the runtime doesn't list it.
  if (selectedTz && !zones.includes(selectedTz)) zones.push(selectedTz);

  const featuredValues = new Set(_FEATURED_TZS.map(t => t.value));
  const others = zones.filter(z => !featuredValues.has(z)).sort();

  const featuredHtml = _FEATURED_TZS.map(t =>
    `<option value="${t.value}"${t.value === selectedTz ? ' selected' : ''}>${t.label}</option>`
  ).join('');
  const otherHtml = others.map(tz =>
    `<option value="${tz}"${tz === selectedTz ? ' selected' : ''}>${tz}</option>`
  ).join('');

  sel.innerHTML =
    `<optgroup label="Operator locations">${featuredHtml}</optgroup>` +
    `<optgroup label="Other">${otherHtml}</optgroup>`;
}

function openOpTzModal() {
  const modal = document.getElementById('op-tz-modal');
  if (!modal) return;
  // Read the stored IANA value off the sidebar's data attribute (set by
  // loadOperatorPrefs / saveOpTzFromModal). textContent holds the friendly
  // label which isn't an IANA name for the featured zones.
  const stored = document.getElementById('op-tz-current')?.dataset?.tz || '';
  const preselected = stored || _detectLocalTz();
  _populateTzSelect(preselected);
  modal.classList.remove('hidden');
}
function closeOpTzModal() {
  document.getElementById('op-tz-modal')?.classList.add('hidden');
}
async function saveOpTzFromModal() {
  const sel = document.getElementById('op-tz-select');
  const tz = sel?.value || '';
  if (!tz) { closeOpTzModal(); return; }
  try {
    const res = await fetch('/api/operator-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tz }),
    });
    if (res.ok) {
      const data = await res.json();
      const stored = data?.prefs?.tz || tz;
      const cur = document.getElementById('op-tz-current');
      if (cur) {
        cur.textContent = _tzDisplayLabel(stored);
        cur.dataset.tz = stored;
      }
    }
  } catch (err) {
    console.warn('[op-tz] save failed:', err?.message || err);
  }
  closeOpTzModal();
}

async function loadOperatorPrefs() {
  try {
    const res = await fetch('/api/operator-prefs');
    if (!res.ok) return;
    const data = await res.json();
    const tz = data?.prefs?.tz || '';
    const cur = document.getElementById('op-tz-current');
    if (cur) {
      cur.textContent = _tzDisplayLabel(tz);
      cur.dataset.tz = tz;
    }
    // First-launch behavior: blank stored tz → show modal pre-filled with
    // the detected OS zone. Skip-link in the modal just dismisses; nothing
    // gets persisted, so the modal re-fires on next launch (user's choice).
    if (!tz) {
      _populateTzSelect(_detectLocalTz());
      document.getElementById('op-tz-modal')?.classList.remove('hidden');
    }
  } catch { /* silent — feature stays unconfigured until next launch */ }
}

window.openOpTzModal = openOpTzModal;
window.closeOpTzModal = closeOpTzModal;
window.saveOpTzFromModal = saveOpTzFromModal;

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
loadOperatorPrefs();

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

// v2.59.x — Chip click was silently failing when the operator switched
// modes: _lastFocusedField cached the previously-focused INPUT/TEXTAREA,
// which may now live in a hidden .tpl-section. We'd write the chip text
// into the invisible element and the operator saw nothing happen. Now we
// only honor the cached field if it's still rendered AND visible, else
// fall through to data-target.
function _isElementVisible(el) {
  if (!el || !el.isConnected) return false;
  // offsetParent is null for elements with display:none (or any ancestor
  // hidden the same way). Cheap visibility test that catches the .tpl-
  // section mode-swap case.
  return el.offsetParent !== null;
}
document.addEventListener('click', (e) => {
  const tag = e.target.closest('.placeholder-tags .tag');
  if (!tag) return;
  const container = tag.closest('.placeholder-tags');
  const section = container?.closest('.section');
  const targetId = container?.dataset.target;
  const fallback = targetId ? document.getElementById(targetId) : null;
  const cached = section ? _lastFocusedField.get(section) : null;
  const field = _isElementVisible(cached) ? cached : fallback;
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
    delayMin: getN('within-batch-min', 30),
    delayMax: getN('within-batch-max', 60),
    pauseOnThrottle: document.getElementById('pause-on-throttle')?.checked !== false,
    messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked,
    addNote: localStorage.getItem('ortus-add-note') === '1',
    linkedinColumn: getV('linkedin-col-select'),
    // v2.58.x — IC-only sheet-mapping overrides (saved & restored across runs).
    senderColumn: getV('ic-sender-col-select'),
    allLeadsConnected: !!document.getElementById('ic-all-connected-toggle')?.checked,
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
  setV('within-batch-min', config.delayMin ?? 30);
  setV('within-batch-max', config.delayMax ?? 60);
  // Task 4 (2026-06-19): restore pause-on-throttle toggle; default ON when absent.
  {
    const _pot = document.getElementById('pause-on-throttle');
    if (_pot) _pot.checked = config.pauseOnThrottle !== false;
  }
  if (typeof checkDelayDanger === 'function') checkDelayDanger();
  // Render the sheet preview, THEN restore the column mapping. previewSheet()
  // is the only thing that fetches the sheet HTML and builds the column-select
  // dropdowns (#linkedin-col-select / #ic-sender-col-select) — without it the
  // table is blank and the saved column picks land on elements that don't exist
  // yet (the old requestAnimationFrame defer raced the dropdowns and lost). The
  // sheet-url field was set by setV above, so previewSheet reads the right URL.
  if (config.sheetUrl && typeof previewSheet === 'function') {
    Promise.resolve(previewSheet()).then(() => {
      if (config.linkedinColumn) {
        const sel = document.getElementById('linkedin-col-select');
        if (sel) sel.value = config.linkedinColumn;
      }
      if (config.senderColumn) {
        const sel = document.getElementById('ic-sender-col-select');
        if (sel) sel.value = config.senderColumn;
      }
      if (config.allLeadsConnected) {
        const tog = document.getElementById('ic-all-connected-toggle');
        if (tog) tog.checked = true;
      }
      if (typeof updateCampaignSummary === 'function') updateCampaignSummary();
    }).catch(() => { /* preview failed (bad URL / offline) — fields stay as set */ });
  }

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

  // v2.91: restore CC+IC auto-accept + automated first follow-up. Without these
  // a Re-run / preset load drops the toggles back to defaults.
  if (document.getElementById('auto-accept-toggle')) document.getElementById('auto-accept-toggle').checked = !!t.autoAcceptPrimary;
  if (document.getElementById('auto-accept-all-toggle')) document.getElementById('auto-accept-all-toggle').checked = !!t.autoAcceptAllPending;
  if (document.getElementById('follow-up-toggle')) document.getElementById('follow-up-toggle').checked = !!t.followUpEnabled;
  setV('follow-up-body', t.followUpBody || '');
  if (t.followUpDelayMinutes) setV('follow-up-delay', t.followUpDelayMinutes);
  // v2.94.x: restore the shared primary source. A profileId → GoLogin source;
  // 'local-browser'/absent → local. refreshAutoAcceptGate() below re-renders.
  {
    const src = t.primarySource || 'local-browser';
    const isGo = !!src && src !== 'local-browser';
    const hidden = document.getElementById('primary-source-profile-id');
    if (hidden) hidden.value = isGo ? src : '';
    const localR = document.querySelector('input[name="primary-source"][value="local-browser"]');
    const goR = document.querySelector('input[name="primary-source"][value="gologin"]');
    if (localR) localR.checked = !isGo;
    if (goR) goR.checked = isGo;
    if (typeof togglePrimarySource === 'function') togglePrimarySource();
  }
  if (typeof toggleFollowUpFields === 'function') toggleFollowUpFields();
  if (typeof refreshAutoAcceptGate === 'function') refreshAutoAcceptGate();

  // v2.62: CC+DM post-acceptance body — symmetric with the primary-intro-body
  // restore above. Without it, Re-run dropped the DM body and relaunched a
  // CC+DM campaign with an empty ccDmBody → no auto-DMs ever fired. Persist to
  // localStorage too, since setV() doesn't trigger the field's oninput=
  // saveCcDmFields handler (so the value survives a reload / restoreCcDmState).
  setV('tpl-cc-dm-body', t.ccDmBody || '');
  try { if (typeof saveCcDmFields === 'function') saveCcDmFields(); } catch (_) {}

  // Restore the monitoring cadence on Re-run. The value is persisted to history
  // (settings.checkIntervalMinutes → spread onto config), but applyPresetConfig
  // never wrote it back into the dropdown, so re-runs silently reset to the
  // HTML default (60 = 1 hour) regardless of what the original run used. Applies
  // to every monitoring mode (CC+IC + CC+DM).
  if (config.checkIntervalMinutes) setV('check-cadence-select', String(config.checkIntervalMinutes));

  // v2.112: restore the automatic-checks toggle on Re-run (default on when absent).
  {
    const _ac = document.getElementById('auto-checks-toggle');
    if (_ac) _ac.checked = config.autoChecksEnabled !== false;
  }

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
  window.__viewingActiveCampaign = false;
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
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
  } catch (err) {
    alert(`Load failed: ${err.message}`);
  }
}

async function loadLastUsedPreset() {
  window.__viewingActiveCampaign = false;
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
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
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
window.openSheetInBrowser = openSheetInBrowser;
window.openRunningSheet = openRunningSheet;
window._refreshOpenSheetButtons = _refreshOpenSheetButtons;
window.closeIcPreflightModal = closeIcPreflightModal;
window._icPreflightPrimary = _icPreflightPrimary;
window._icPreflightSecondary = _icPreflightSecondary;
window._icSenderColManualPick = _icSenderColManualPick;
window.addToQueueCampaign = addToQueueCampaign;
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
window.alphaStepConcurrency = alphaStepConcurrency;
window.alphaSyncConcurrency = alphaSyncConcurrency;
window.checkDelayDanger = checkDelayDanger;
window.syncPauseOnThrottleHelp = syncPauseOnThrottleHelp;
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
// v2.73 — in-app update check. On load, /api/update-check compares the running
// version against the latest GitHub release. If behind, the sidebar update pill
// is revealed; clicking it downloads the matching DMG and opens it (the operator
// drags the new build into /Applications and relaunches). Unsigned builds can't
// self-update silently, so this is the safe, reliable path.
// ─────────────────────────────────────────────────────────────────────────────
let _updateInfo = null;
let _updateChecking = false;
const UPDATE_POLL_MS = 30 * 60 * 1000; // re-check every 30 min while app is open

// Render the pill as a gold "Update to vX" prompt (behind) or a muted
// "Check for updates" button (current / check failed).
function _renderUpdatePill() {
  const pill = document.getElementById('update-pill');
  if (!pill) return;
  if (_updateInfo && _updateInfo.ok && _updateInfo.behind) {
    pill.className = 'update-pill';
    pill.innerHTML = '<span class="update-pill-arrow">↑</span> Update to v' + _updateInfo.latest;
  } else {
    pill.className = 'update-pill update-pill-muted';
    pill.textContent = 'Check for updates';
  }
  pill.disabled = false;
  pill.classList.remove('hidden');
}

async function checkForUpdate(force) {
  try {
    const r = await fetch('/api/update-check' + (force ? '?force=1' : ''));
    _updateInfo = await r.json();
  } catch {
    _updateInfo = { ok: false };
  }
  _renderUpdatePill();
}

function _setUpdateStatus(pct, received, total) {
  const wrap = document.getElementById('update-status');
  const fill = document.getElementById('update-bar-fill');
  const text = document.getElementById('update-status-text');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  if (fill) fill.style.width = (pct || 0) + '%';
  if (text) {
    const mb = (n) => (n / 1048576).toFixed(0);
    text.textContent = total
      ? `Downloading… ${pct}%  ·  ${mb(received)} / ${mb(total)} MB`
      : `Downloading… ${mb(received)} MB`;
  }
}
function _showUpdateDetail(msg) {
  const wrap = document.getElementById('update-status');
  const text = document.getElementById('update-status-text');
  const detail = document.getElementById('update-detail');
  if (wrap) wrap.classList.remove('hidden');
  if (text) text.textContent = msg;
  if (detail) {
    detail.classList.remove('hidden');
    detail.innerHTML = '<button type="button" class="update-detail-btn" onclick="showUpdateLog()">Details ▾</button><pre id="update-log-pre" class="update-log-pre hidden"></pre>';
  }
}
async function showUpdateLog() {
  const pre = document.getElementById('update-log-pre');
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  try {
    const r = await (await fetch('/api/update-log')).json();
    pre.textContent = (r && r.exists && r.text)
      ? r.text
      : 'No install log on this machine yet — the failure was during download (see the message above), or the install helper has not run here.';
  } catch (e) {
    pre.textContent = 'Could not read the update log: ' + e.message;
  }
  pre.classList.remove('hidden');
}
window.showUpdateLog = showUpdateLog;
async function _checkLastUpdateAttempt() {
  try {
    const r = await (await fetch('/api/update-log')).json();
    if (!r || !r.exists || !r.text) return;
    const failed = /failed|no \.app|mount failed|copy failed|swap failed/i.test(r.text);
    const recent = (Date.now() - r.mtimeMs) < 24 * 3600 * 1000;
    if (failed && recent) {
      _showUpdateDetail('The last update attempt didn’t complete. Open Details for the log, or retry from the update button.');
    }
  } catch { /* */ }
}

// Poll the server's download progress until done/error.
function _pollDownloadProgress() {
  return new Promise((resolve) => {
    const tick = async () => {
      let s = null;
      try { s = await (await fetch('/api/update-progress')).json(); } catch { /* */ }
      if (s) {
        const pct = s.total ? Math.round((s.received / s.total) * 100) : 0;
        _setUpdateStatus(pct, s.received || 0, s.total || 0);
        if (s.done) return resolve({ done: true });
        if (s.error) return resolve({ error: s.error });
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function onUpdateClick(e) {
  if (e) e.preventDefault();
  const pill = document.getElementById('update-pill');
  if (!pill) return;

  // Behind → download + open, with a live progress bar under the button.
  if (_updateInfo && _updateInfo.ok && _updateInfo.behind) {
    pill.disabled = true;
    pill.innerHTML = '<span class="update-pill-arrow">↓</span> Downloading…';
    _setUpdateStatus(0, 0, 0);
    try {
      const r = await fetch('/api/update-download', { method: 'POST' });
      const d = await r.json();
      if (!d || !d.ok) throw new Error('start failed');
      const res = await _pollDownloadProgress();
      if (res.done) {
        const fill = document.getElementById('update-bar-fill');
        if (fill) fill.style.width = '100%';
        const text = document.getElementById('update-status-text');
        // Hand off to the installer: auto-swap + relaunch (packaged) or open
        // the DMG for a manual drag (dev/fallback).
        pill.innerHTML = '<span class="update-pill-arrow">⟳</span> Installing…';
        if (text) text.textContent = 'Installing the update…';
        let inst = {};
        try { inst = await (await fetch('/api/update-install', { method: 'POST' })).json(); }
        catch (e) { inst = { error: e.message }; }
        if (inst.relaunching) {
          pill.innerHTML = '<span class="update-pill-arrow">✓</span> Updating — the app will reopen…';
          if (text) text.textContent = 'The app will close and reopen on the new version.';
        } else {
          // Fallback: DMG opened for a manual drag, or install error.
          const msg = summarizeUpdateError({ installError: inst.error, fallback: inst.fallback });
          pill.innerHTML = '<span class="update-pill-arrow">✓</span> Installer opened — drag to Applications';
          if (text) text.textContent = msg || 'Download complete.';
          if (inst.error) _showUpdateDetail(msg);
        }
      } else {
        const msg = summarizeUpdateError({ downloadError: res.error });
        pill.innerHTML = '<span class="update-pill-arrow">!</span> Failed — retry';
        pill.disabled = false;
        _showUpdateDetail(msg || 'Update failed.');
      }
    } catch (err) {
      pill.innerHTML = '<span class="update-pill-arrow">!</span> Failed — retry';
      pill.disabled = false;
      _showUpdateDetail(summarizeUpdateError({ downloadError: err.message }) || ('Update failed: ' + err.message));
    }
    return;
  }

  // Current → manual "Check for updates": force a fresh check.
  if (_updateChecking) return;
  _updateChecking = true;
  pill.disabled = true;
  pill.textContent = 'Checking…';
  await checkForUpdate(true);
  _updateChecking = false;
  // If still current after a forced check, flash "Up to date" then revert.
  if (!(_updateInfo && _updateInfo.ok && _updateInfo.behind)) {
    pill.className = 'update-pill update-pill-muted';
    pill.textContent = 'Up to date ✓';
    setTimeout(() => {
      if (!(_updateInfo && _updateInfo.behind)) _renderUpdatePill();
    }, 2500);
  }
}

window.onUpdateClick = onUpdateClick;
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => checkForUpdate(false), 800);
  setTimeout(() => _checkLastUpdateAttempt(), 1200);
  // Auto re-check every 30 min so an already-open app notices a new release
  // without needing a restart.
  setInterval(() => checkForUpdate(false), UPDATE_POLL_MS);
});

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
    summary: '',
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
  // v2.91: typing the primary URL unlocks the auto-accept toggle live.
  try { if (typeof refreshAutoAcceptGate === 'function') refreshAutoAcceptGate(); } catch (_) {}
  // v2.104: live structural validation of the primary URL as the operator types.
  try { revalidatePrimaryUrlField(); } catch (_) {}
}

// v2.104: inline error UX for the Primary person URL field. The error banner
// + red border show whenever the pasted value is a non-blank, malformed URL,
// and clear the moment it's valid (or blanked). Shares validatePrimaryUrl with
// the start-gate hard-lock and the server, so what you see is exactly what
// blocks the launch.
function showPrimaryUrlError(msg) {
  const el = document.getElementById('primary-person-url-error');
  const input = document.getElementById('primary-person-url');
  if (el) { el.textContent = msg; el.hidden = false; }
  if (input) input.classList.add('intro-config-input--invalid');
}
function clearPrimaryUrlError() {
  const el = document.getElementById('primary-person-url-error');
  const input = document.getElementById('primary-person-url');
  if (el) { el.textContent = ''; el.hidden = true; }
  if (input) input.classList.remove('intro-config-input--invalid');
}
function revalidatePrimaryUrlField() {
  const input = document.getElementById('primary-person-url');
  if (!input) return;
  const v = validatePrimaryUrl((input.value || '').trim());
  if (v.ok) clearPrimaryUrlError();
  else showPrimaryUrlError(v.reason);
}
window.showPrimaryUrlError = showPrimaryUrlError;
window.clearPrimaryUrlError = clearPrimaryUrlError;
window.revalidatePrimaryUrlField = revalidatePrimaryUrlField;

// v2.91: Automated first follow-up — reveal the message/delay/sender fields
// only when the toggle is on.
function toggleFollowUpFields() {
  const on = !!document.getElementById('follow-up-toggle')?.checked;
  const box = document.getElementById('follow-up-fields');
  if (box) box.style.display = on ? '' : 'none';
  // The message editor lives in Section 5 and unlocks only while the toggle is
  // on AND we're in CC+IC mode.
  const mode = document.getElementById('campaign-mode')?.value;
  const sec = document.getElementById('tpl-followup-section');
  if (sec) sec.style.display = (on && mode === 'connect_and_introduce') ? '' : 'none';
}
window.toggleFollowUpFields = toggleFollowUpFields;

// v2.91: Lock auto-accept until a primary URL is present — without a profile
// URL there's nothing to accept from.
// v2.91/2.94.x: auto-accept toggle stays locked until a primary URL is present
// (auto-accept needs to know whose invitation to accept). The source selector
// itself lives in Primary Person and is NOT gated here.
function refreshAutoAcceptGate() {
  const url = (document.getElementById('primary-person-url')?.value || '').trim();
  const toggle = document.getElementById('auto-accept-toggle');
  const gate = document.getElementById('auto-accept-gate');
  const hasUrl = /linkedin\.com\/in\//i.test(url);
  if (toggle) {
    toggle.disabled = !hasUrl;
    if (!hasUrl) toggle.checked = false;
  }
  if (gate) gate.style.display = hasUrl ? 'none' : '';
  // v2.107: the accept-all sub-toggle is only meaningful while auto-accept is on
  // (the sweep runs inside the pre-flight handshake, which requires auto-accept).
  // Disable + clear it whenever auto-accept is off, so it can't silently apply.
  const allToggle = document.getElementById('auto-accept-all-toggle');
  const allRow = document.getElementById('auto-accept-all-row');
  const allHint = document.getElementById('auto-accept-all-hint');
  const aaOn = !!(toggle && toggle.checked && !toggle.disabled);
  if (allToggle) { allToggle.disabled = !aaOn; if (!aaOn) allToggle.checked = false; }
  if (allRow) allRow.style.opacity = aaOn ? '' : '0.45';
  if (allHint) allHint.style.opacity = aaOn ? '' : '0.45';
  refreshPrimarySourceLabels();
}
window.refreshAutoAcceptGate = refreshAutoAcceptGate;

// v2.94.x: show the GoLogin picker only when the GoLogin source is selected.
function togglePrimarySource() {
  const src = document.querySelector('input[name="primary-source"]:checked')?.value;
  const picker = document.getElementById('primary-source-picker');
  if (picker) picker.style.display = src === 'gologin' ? '' : 'none';
  if (src === 'gologin') renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
  refreshPrimarySourceLabels();
}
window.togglePrimarySource = togglePrimarySource;

// v2.94.x: single-select GoLogin profile picker for the primary's identity.
// Reuses allProfilesData + findSoOForProfile + renderSoOBadges. Selection is
// stored in the hidden #primary-source-profile-id input.
function renderPrimarySourcePicker(filter = '') {
  const grid = document.getElementById('primary-source-grid');
  if (!grid) return;
  const sel = document.getElementById('primary-source-profile-id')?.value || '';
  const q = (filter || '').trim().toLowerCase();
  const rows = (allProfilesData || []).filter(p =>
    !q || (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q));
  grid.innerHTML = '';
  if (rows.length === 0) {
    grid.innerHTML = '<div class="aa-acct-empty">No profiles match.</div>';
    return;
  }
  rows.forEach((p) => {
    const soo = findSoOForProfile(p.name);
    const isSel = p.id === sel;
    const row = document.createElement('div');
    row.className = 'aa-acct-row' + (isSel ? ' sel' : '');
    row.dataset.profileId = p.id;
    row.innerHTML = `
      <input type="radio" name="primary-source-profile" ${isSel ? 'checked' : ''}>
      <div class="body">
        <div class="name">${escHtml(p.name)}</div>
        ${!soo ? `<div class="id">${p.id.substring(0, 12)}…</div>` : ''}
        ${renderSoOBadges(soo)}
      </div>`;
    row.addEventListener('click', () => {
      const hidden = document.getElementById('primary-source-profile-id');
      if (hidden) hidden.value = p.id;
      renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
      refreshPrimarySourceLabels();
      savePrimaryPersonFields();
    });
    grid.appendChild(row);
  });
}
function filterPrimarySourcePicker() {
  renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
}
window.filterPrimarySourcePicker = filterPrimarySourcePicker;

// v2.94.x: SoO can be down when the picker opens (no credit badges). This
// re-pulls SoO and re-renders the picker + the main accounts grid + labels.
async function reloadPrimarySourceSoO() {
  const btn = document.getElementById('primary-source-soo-reload');
  const status = document.getElementById('primary-source-soo-status');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (status) { status.textContent = ''; status.classList.remove('err'); }
  try {
    await loadSoOStatus();
    if (allProfilesData && allProfilesData.length) renderProfiles(allProfilesData);
    renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
    refreshPrimarySourceLabels();
    if (status) {
      if (sooLoadState === 'ok') {
        status.textContent = `Loaded ${Object.keys(sooData).length} statuses`;
      } else {
        status.textContent = 'SoO unavailable — try again';
        status.classList.add('err');
      }
    }
  } catch (_) {
    if (status) { status.textContent = 'SoO unavailable — try again'; status.classList.add('err'); }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}
window.reloadPrimarySourceSoO = reloadPrimarySourceSoO;

// v2.94.x: resolve the primary's identity for the templates payload.
// '' when GoLogin is selected but no profile picked yet — the launch guard
// catches that; normalizeTemplates also degrades '' to 'local-browser'.
function readPrimarySource() {
  const src = document.querySelector('input[name="primary-source"]:checked')?.value;
  if (src === 'gologin') return document.getElementById('primary-source-profile-id')?.value || '';
  return 'local-browser';
}
window.readPrimarySource = readPrimarySource;

// v2.94.x: live-update the read-only "as your primary — [name]" lines on the
// auto-accept + follow-up cards from the shared selector.
function refreshPrimarySourceLabels() {
  const src = readPrimarySource();
  let name = 'your local browser';
  if (src && src !== 'local-browser') {
    const p = (allProfilesData || []).find(x => x.id === src);
    name = p ? p.name : 'a GoLogin profile';
  }
  const aaLabel = document.getElementById('auto-accept-primary-label');
  const aaLine = document.getElementById('auto-accept-primary-line');
  if (aaLabel) aaLabel.textContent = name;
  if (aaLine) aaLine.style.display = document.getElementById('auto-accept-toggle')?.checked ? '' : 'none';
  const fuLabel = document.getElementById('follow-up-primary-label');
  if (fuLabel) fuLabel.textContent = name;
}
window.refreshPrimarySourceLabels = refreshPrimarySourceLabels;
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

// v2.62: CC+DM (connect_and_message) post-acceptance body. Same persist
// pattern as savePrimaryPersonFields so the textarea repopulates after
// navigation. No primary person fields — CC+DM only needs the body.
function saveCcDmFields() {
  try {
    localStorage.setItem('ortus-cc-dm-body', document.getElementById('tpl-cc-dm-body')?.value || '');
  } catch { /* storage blocked */ }
}
function restoreCcDmState() {
  try {
    const bodyEl = document.getElementById('tpl-cc-dm-body');
    if (bodyEl) bodyEl.value = localStorage.getItem('ortus-cc-dm-body') || bodyEl.value;
  } catch { /* storage blocked — DOM defaults stand */ }
}
window.saveCcDmFields = saveCcDmFields;
document.addEventListener('DOMContentLoaded', restoreCcDmState);
if (document.readyState !== 'loading') restoreCcDmState();
// Task 4 (2026-06-19): evaluate delay-danger on load so a saved <30s config
// shows the warning immediately (before the operator touches anything).
document.addEventListener('DOMContentLoaded', checkDelayDanger);
if (document.readyState !== 'loading') checkDelayDanger();
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
  message_only: 'Direct Messages',
  inmail_only: 'InMail Only',
  open_profile_only: 'Open Profile Message',
  check_dms: 'Check DMs',
  connect_and_introduce: 'CC + IB',
  connect_and_message: 'CC + DM',
  introduce_back: 'IC',
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
  _dashboardPollTimer = setInterval(async () => {
    if (document.body.classList.contains('route-dashboard')) {
      refreshActiveCampaign();
      // v0.3 dashboard: don't rely on the indirect pollStatus chain to keep the
      // active card painted. When the previous campaign ends, pollStatus stops
      // itself; if a queued campaign drains in the background, the active card
      // would freeze on "No campaign running" until the operator navigated
      // away and back. Paint directly here every 5s so the tile reflects
      // reality even when pollStatus is dead.
      try {
        const s = await fetch('/api/campaign/status').then(r => r.json());
        if (typeof window.renderActiveCard === 'function') window.renderActiveCard(s);
        if (typeof window.renderMonitoringCard === 'function') window.renderMonitoringCard(s);
        maybeShowCampaignDoneModal(s);
        // v2.72: keep the floating Console (log) live on the dashboard too.
        try { renderLiveConsole(s); } catch (_) { /* */ }
      } catch { /* best-effort; refreshActiveCampaign covers the legacy path */ }
      if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
      if (typeof window.renderPastSection === 'function') window.renderPastSection();
      if (typeof window.renderCalendarGrid === 'function') window.renderCalendarGrid();
      if (typeof window.renderReplies === 'function') window.renderReplies();
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

// v2.72: Replies panel. Polls /api/replies (populated by the hourly
// reply-check) and renders the newest inbound messages with the account to
// log into, so the operator can reply to each person manually.
// v2.104.1: the dashboard Replies card is hidden while automatic reply-tracking
// is disabled (see REPLY_CHECK_ENABLED in src/post-campaign-reply-check.js).
// Force the card hidden and skip the /api/replies poll so stale entries can't
// resurrect a dead "checked automatically every hour" panel. Flip back to true
// together with REPLY_CHECK_ENABLED when reply tracking is restored.
const DASH_REPLIES_PANEL_ENABLED = false;
let _repliesInFlight = false;
async function renderReplies() {
  const card = document.getElementById('replies-card');
  // Force-hide via the attribute AND inline display (inline beats the
  // .vj-card{display:grid} rule that would otherwise override [hidden]).
  if (!DASH_REPLIES_PANEL_ENABLED) { if (card) { card.hidden = true; card.style.display = 'none'; } return; }
  const list = document.getElementById('replies-list');
  if (!card || !list || _repliesInFlight) return;
  _repliesInFlight = true;
  try {
    const data = await fetch('/api/replies').then(r => r.json());
    const replies = Array.isArray(data?.replies) ? data.replies : [];
    if (replies.length === 0) { card.hidden = true; return; }
    card.hidden = false;

    const badge = document.getElementById('replies-badge');
    const unseen = Number(data?.unseen || 0);
    if (badge) {
      if (unseen > 0) { badge.textContent = `${unseen} new`; badge.style.display = 'inline-block'; }
      else { badge.style.display = 'none'; }
    }

    list.innerHTML = replies.slice(0, 25).map((r) => {
      const who = escHtml(r.leadName || r.linkedinUrl || 'Lead');
      const acct = escHtml(r.profileName || r.profileId || '—');
      const when = r.recordedAt ? fmtRelTime(r.recordedAt) : '';
      const msg = escHtml(String(r.text || '').slice(0, 300));
      const url = r.linkedinUrl ? escHtml(r.linkedinUrl) : '';
      const nameEl = url
        ? `<a href="${url}" target="_blank" rel="noopener" style="text-decoration:underline;text-decoration-color:var(--hairline);text-underline-offset:3px">${who}</a>`
        : who;
      const suspected = !!r.suspected;
      const badge = suspected
        ? ' <span style="font-size:0.65em;background:#8b6d1a;color:#fff;border-radius:9999px;padding:1px 7px;vertical-align:middle">SUSPECTED · same name</span>'
        : '';
      const subline = suspected
        ? `Possible reply on <strong>${acct}</strong> — name matches more than one lead, verify manually.`
        : `Reply to this from <strong>${acct}</strong>.`;
      return `
        <div class="reply-item ${r.seen ? '' : 'reply-unseen'}" style="border:1px solid var(--hairline);border-radius:10px;padding:10px 12px;${suspected ? 'border-left:3px solid #8b6d1a;' : (r.seen ? '' : 'border-left:3px solid var(--gold,#caa24a);')}">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
            <strong>${nameEl}${badge}</strong>
            <span style="font-size:0.75em;color:#8b949e;white-space:nowrap">${when}</span>
          </div>
          <div style="font-size:0.8em;color:#8b949e;margin:2px 0 6px">${subline}</div>
          <div style="white-space:pre-wrap">${msg || '<em style="color:#8b949e">(no preview)</em>'}</div>
        </div>`;
    }).join('');
  } catch { /* best-effort */ }
  finally { _repliesInFlight = false; }
}
window.renderReplies = renderReplies;

async function dashMarkRepliesSeen() {
  try {
    await fetch('/api/replies/seen', { method: 'POST' });
    await renderReplies();
  } catch { /* */ }
}
window.dashMarkRepliesSeen = dashMarkRepliesSeen;

// Lightweight relative-time formatter for the replies panel.
function fmtRelTime(ms) {
  const diff = Date.now() - Number(ms || 0);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// v2.72: "No more rows to process" popup. The backend sets status.endNotice
// (with a unique ts) when a campaign ends naturally — we show the modal once
// per ts and remember the last-shown ts so it doesn't re-fire on every poll.
let _lastEndNoticeTs = (() => {
  try { return Number(localStorage.getItem('ortus-last-endnotice-ts') || 0); } catch { return 0; }
})();
function maybeShowCampaignDoneModal(status) {
  try {
    const n = status && status.endNotice;
    if (!n || !n.ts || status.running) return;
    if (status.state === 'monitoring') return;       // still watching — not "stopped"
    if (n.reason === 'operator_stopped') return;     // you stopped it on purpose — log stays, no nag popup
    if (n.ts <= _lastEndNoticeTs) return;            // already shown this one
    _lastEndNoticeTs = n.ts;
    try { localStorage.setItem('ortus-last-endnotice-ts', String(n.ts)); } catch { /* */ }
    showCampaignDoneModal(n);
  } catch { /* best-effort */ }
}
window.maybeShowCampaignDoneModal = maybeShowCampaignDoneModal;

// 2026-06-15 — Local-browser re-login recovery. Driven entirely by the 2s status
// poll: show the popup while status.awaitingLogin is set, auto-hide the moment it
// clears (run resumed on login, or parked on the 5-min ceiling).
function maybeShowLoginModal(status) {
  const modal = document.getElementById('login-recover-modal');
  if (!modal) return;
  const a = status && status.awaitingLogin;
  if (a) {
    const who = (a.pName || 'Your account');
    const body = document.getElementById('login-recover-body');
    if (body) {
      body.innerHTML = `<b>${who}</b>'s LinkedIn session expired. The browser window has ` +
        `opened on-screen — log into LinkedIn there, then click <b>Done</b>. ` +
        `(It also resumes automatically once you're logged back in.)`;
    }
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}
window.maybeShowLoginModal = maybeShowLoginModal;

async function confirmLoginDone() {
  try { await fetch('/api/campaign/login-done', { method: 'POST' }); } catch { /* */ }
  // Optimistic hide; if we weren't actually logged in, the next poll re-shows it.
  const modal = document.getElementById('login-recover-modal');
  if (modal) modal.classList.add('hidden');
}
window.confirmLoginDone = confirmLoginDone;

function showCampaignDoneModal(n) {
  const modal = document.getElementById('campaign-done-modal');
  const body = document.getElementById('campaign-done-body');
  const titleEl = document.getElementById('campaign-done-title');
  const pill = modal ? modal.querySelector('.ptm-pill') : null;
  if (!modal || !body) return;
  const processed = Number(n.processed || 0);
  const targets = Number(n.targets || 0);
  const nm = n.name ? `"${escHtml(n.name)}"` : 'The campaign';
  let title, pillText, html;
  switch (n.reason) {
    case 'error':
      title = 'Campaign stopped — error';
      pillText = 'ERROR';
      html = `<p>${nm} stopped because of an error.</p>
        <p style="color:#c0392b">${escHtml(n.detail || 'Unexpected error.')}</p>
        <p>Processed <strong>${processed}</strong> of <strong>${targets || '—'}</strong> row(s) before stopping. The log below has the details.</p>`;
      break;
    case 'all_parked':
      title = 'Campaign stopped — all accounts paused';
      pillText = 'ACCOUNTS PAUSED';
      html = `<p>${nm} stopped because every account was paused before the leads ran out.</p>
        ${n.detail ? `<p>${escHtml(n.detail)}</p>` : ''}
        <p>Processed <strong>${processed}</strong> of <strong>${targets}</strong> row(s). Fix the account(s) — log back in, wait for the weekly invite limit to reset, or top up credits — then resume.</p>`;
      break;
    case 'no_more_rows':
    default: {
      const lowYield = targets === 0 || processed === 0;
      title = 'No more rows to process';
      pillText = 'CAMPAIGN FINISHED';
      const counts = targets > 0
        ? `Processed <strong>${processed}</strong> of <strong>${targets}</strong> eligible row(s).`
        : `No eligible rows were found.`;
      const hint = lowYield
        ? `This usually means the wrong sheet tab is selected, or every row has already been processed. Double-check the selected tab and that your leads are in it.`
        : `This usually means the campaign has finished — every eligible row was processed. If you expected more, check the selected sheet tab.`;
      html = `<p>${nm} stopped because no more rows to process could be detected.</p>
        <p>${counts}</p>
        <p>${hint}</p>`;
      break;
    }
  }
  if (titleEl) titleEl.textContent = title;
  if (pill) pill.textContent = pillText;
  body.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeCampaignDoneModal() {
  const modal = document.getElementById('campaign-done-modal');
  if (modal) modal.classList.add('hidden');
}
window.closeCampaignDoneModal = closeCampaignDoneModal;

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

// When the operator opens the LIVE/monitoring campaign (dashboard "Open"), the
// wizard is a read-only view of what's running — hide the launch panel so they
// can't relaunch / queue / duplicate / save-as-draft the active campaign. Any
// other entry (+ New, Edit, preset) clears the flag, so staging a new campaign
// while one runs still shows the launch panel.
window.__viewingActiveCampaign = window.__viewingActiveCampaign || false;
function applyViewingActiveLock() {
  const panel = document.getElementById('launch-actions');
  if (panel) panel.style.display = window.__viewingActiveCampaign ? 'none' : '';
}
window.applyViewingActiveLock = applyViewingActiveLock;

function applyRoute() {
  const isWizard = (window.location.hash || '#/').startsWith('#/new');
  document.body.classList.toggle('route-wizard', isWizard);
  document.body.classList.toggle('route-dashboard', !isWizard);
  if (!isWizard) {
    // v2.86.1 (port): leaving the wizard clears the "Open log" override so the
    // next idle visit starts hidden again (auto-show still applies when live).
    liveStatusForcedOpen = false;
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
    // 2026-05-27 (drafts-isolation): refresh the editing banner whenever the
    // operator lands on the wizard — covers Cmd+R, back-button, and the
    // resume-pill click path.
    if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
    // v2.86.1 (port): render the "Editing a stopped campaign" banner as a pure
    // function of the edit-resume context (editResumeSourceIdx). Only
    // dashEditResumePast sets that key, so every other wizard entry ("+ New
    // campaign", draft, Open) lands here with it absent and the banner stays
    // hidden — instead of leaking in from a previous edit-resume session.
    try {
      const _rb = document.getElementById('wizard-resume-banner');
      if (_rb) {
        let _idx = null;
        try { _idx = localStorage.getItem('editResumeSourceIdx'); } catch {}
        _rb.style.display = (_idx != null && String(_idx).trim() !== '') ? '' : 'none';
      }
    } catch (_) { /* */ }
    startWizardPolling();
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
  }
  // v2.59.22: re-evaluate the Live Status card placement on every route change
  // (sync visibility first so placeLiveCard sees the right display state).
  try { if (typeof syncLiveStatusVisibility === 'function') syncLiveStatusVisibility(); } catch (_) { /* */ }
}

// Updates the wizard's banner + Start button label based on whether a
// campaign is currently running. When running, this build will be queued
// (server already enforces this) — say so out loud so the operator knows
// they're not editing the active campaign.
async function updateWizardQueueState() {
  // v2.59.x — Side-by-side Start + Add to Queue pills replaced the
  // relabel-on-running approach. This poller now just (a) shows the banner
  // explaining what queue mode does and (b) keeps the gold-class swap in
  // sync from the wizard side (setCampaignButtons covers the status-poll
  // side; both stay aligned).
  const banner = document.getElementById('wizard-queue-banner');
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
      detail.textContent = `${ref} is currently running — either button on this page will add this campaign to the queue.`;
    }
  }
  _applyLaunchButtonClasses(isRunning);
}
window.updateWizardQueueState = updateWizardQueueState;
function goCreateCampaign() { window.location.hash = '#/new'; }
function goDashboard()      { window.location.hash = '#/'; }

async function refreshDashboard() {
  await Promise.all([refreshActiveCampaign(), refreshDashboardQueue(), refreshDashboardSchedules(), refreshDashboardDrafts(), refreshPastCampaigns()]);
  // v0.3 dashboard renderers. Active + Monitoring will repaint on the next 2s
  // pollStatus tick, but kick a status fetch now so the cards aren't blank
  // for ~2s after route entry. Queue/Calendar/Past are wired via their own
  // renderers in later tasks; calls below are typeof-guarded for incremental
  // delivery.
  try {
    const s = await fetch('/api/campaign/status').then(r => r.json());
    if (typeof window.renderActiveCard === 'function') window.renderActiveCard(s);
    if (typeof window.renderMonitoringCard === 'function') window.renderMonitoringCard(s);
  } catch { /* best-effort */ }
  if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  if (typeof window.renderCalendarGrid === 'function') window.renderCalendarGrid();
  if (typeof window.renderPastSection === 'function') window.renderPastSection();
  // 2026-05-27 (drafts-isolation): paint the resume-draft pill on every
  // dashboard refresh. The renderer self-cleans stale ids server-side.
  if (typeof window.renderResumeDraftPill === 'function') window.renderResumeDraftPill();
}

// Dashboard's Drafts section. Multi-draft store backs this — operator can
// stage multiple campaigns in parallel, queue or delete any of them.
async function refreshDashboardDrafts() {
  const list = document.getElementById('drafts-campaign-list');
  if (!list) return;
  try {
    // v2.59: Drafts & Stops merge. Fetch BOTH drafts (multi-store + legacy
    // single-draft fallback) AND stopped history entries; render drafts on
    // top, stopped rows below.
    const [draftsData, historyData] = await Promise.all([
      fetch('/api/drafts').then((r) => r.json()).catch(() => null),
      fetch('/api/history').then((r) => r.json()).catch(() => null),
    ]);
    const drafts = Array.isArray(draftsData?.drafts) ? draftsData.drafts : [];

    // Render multi-store drafts
    let draftRowsHtml = '';
    if (drafts.length > 0) {
      drafts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      draftRowsHtml = drafts.map((d) => {
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
    } else {
      // Legacy single-draft fallback (until Phase 3.3 unifies storage).
      let legacyName = '';
      try {
        const r = await fetch('/api/draft-name');
        if (r.ok) legacyName = (await r.json())?.name || '';
      } catch {}
      if (legacyName) {
        draftRowsHtml = `
          <div class="campaign-row campaign-row--with-edit" data-campaign-id="draft" data-state="draft">
            <span class="campaign-row-name">${escHtml(legacyName)}</span>
            <span class="campaign-row-type">Draft</span>
            <span class="campaign-row-progress">Not started</span>
            <span class="campaign-row-status">Draft</span>
            <span class="campaign-row-actions">
              <button type="button" class="campaign-row-edit" onclick="goCreateCampaign()" title="Open in wizard">Edit</button>
              <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="clearDraftName()" title="Discard draft" aria-label="Discard draft">×</button>
            </span>
          </div>
        `;
      }
    }

    // Stopped rows from /api/history — same row layout as past, including
    // the click-to-resume STOPPED chip. Reuses buildPastRowHtml so visuals
    // + delete + resume wiring stay in sync with the Past tab.
    let stoppedRowsHtml = '';
    if (Array.isArray(historyData) && historyData.length > 0) {
      const indexed = historyData.map((c, idx) => ({ idx, c }));
      const stopped = indexed
        .filter(({ c }) => (c.endReason || 'completed') === 'stopped' && c.state !== 'monitoring')
        .sort((a, b) => {
          const ta = new Date(a.c.startedAt || a.c.date).getTime();
          const tb = new Date(b.c.startedAt || b.c.date).getTime();
          return tb - ta;
        });
      stoppedRowsHtml = stopped.map(buildPastRowHtml).join('');
      // Extend pastCampaignsCache so resumeWithSameSettings (which reads from
      // this cache) can find stopped entries by idx. Before this merge,
      // refreshPastCampaigns was the only writer of the cache and excluded
      // stopped rows — so clicking the STOPPED chip in Drafts & Stops did
      // nothing useful (entry not found → silent early-return).
      if (!Array.isArray(pastCampaignsCache)) pastCampaignsCache = [];
      const _cachedIdxs = new Set(pastCampaignsCache.map((e) => e.idx));
      for (const s of stopped) {
        if (!_cachedIdxs.has(s.idx)) pastCampaignsCache.push(s);
      }
    }

    const combined = draftRowsHtml + stoppedRowsHtml;
    if (!combined) {
      list.innerHTML = '<p class="empty-state">No drafts or stopped campaigns.</p>';
    } else {
      list.innerHTML = combined;
    }
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load drafts.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

async function deleteDraft(id) {
  if (!id) return;
  if (!confirm('Delete this draft?')) return;
  // v2.57.7: optimistic removal — drops the row from every visible
  // instance (source panel + ALL-tab clone) before the network call so
  // the operator sees instant feedback instead of a stale row.
  document.querySelectorAll(`.campaign-row[data-campaign-id="${CSS.escape(id)}"]`)
    .forEach((el) => el.remove());
  try {
    await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (err) {
    alert('Failed: ' + err.message);
    return;
  }
  // If the wizard is currently editing this draft, drop the reference.
  try {
    if (getActiveDraftId() === id) clearActiveDraft();
  } catch {}
  refreshDashboardDrafts();
  if (typeof renderDashboardAll === 'function') renderDashboardAll();
}
window.deleteDraft = deleteDraft;

// Open the wizard for the currently-running campaign — drops any draft id
// in localStorage so isOnNewCampaignView returns false and the live status
// / log / runbar / buttons all reflect the running campaign instead of
// the previously-edited draft. Used by the Active tab's Edit button.
async function viewRunningCampaign() {
  // 2026-05-27 (drafts-isolation, Task 6): flush before dropping the active
  // draft id so a half-saved draft doesn't lose its tail of typed input.
  if (typeof flushAutosaveImmediate === 'function') {
    try { await flushAutosaveImmediate(); } catch {}
  }
  clearActiveDraft();
  goCreateCampaign();
}
window.viewRunningCampaign = viewRunningCampaign;

async function editDraft(id) {
  window.__viewingActiveCampaign = false;
  if (!id) return;
  // 2026-05-27 (drafts-isolation, Task 6): flush any pending autosave for
  // the CURRENT active draft BEFORE switching the id. Otherwise the next
  // _flushAutosave fires under the new id and lands A's typed-but-unsaved
  // changes on B. Safe to call even when no draft is active.
  if (typeof flushAutosaveImmediate === 'function') {
    try { await flushAutosaveImmediate(); } catch (err) { console.warn('[drafts] flush before switch:', err); }
  }
  setActiveDraftId(id);
  try { localStorage.removeItem('wizardStoppedFromContext'); } catch {}
  wizardDirty = false;
  _runningEditWarningShown = false;
  // Pre-fill the wizard's name input from the draft so the user sees it
  // immediately (syncCampaignNameInput will pick up the active draft id on
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
  if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
}
window.editDraft = editDraft;

// Dashboard's Queued section. Lists campaigns waiting for the running
// one to finish so they can auto-launch in FIFO order. Cancel button
// removes an entry before its slot comes up.
async function refreshDashboardQueue() {
  const list = document.getElementById('queued-campaign-list');
  if (!list) return;
  try {
    const [queueData, statusData] = await Promise.all([
      fetch('/api/queue').then((r) => r.json()).catch(() => null),
      fetch('/api/campaign/status').then((r) => r.json()).catch(() => null),
    ]);
    const queue = Array.isArray(queueData?.queue) ? queueData.queue : [];
    const isRunning = !!(statusData && (statusData.running || statusData.paused));
    if (queue.length === 0) {
      list.innerHTML = '<p class="empty-state">No queued campaigns.</p>';
      return;
    }
    // v2.59.x — Header: drag-hint + Run next pill. Run next is visible only
    // when no campaign is running AND queue has items, so the operator can
    // explicitly drain the head from idle (otherwise the queue waits for
    // the next /api/campaign/start to drain it).
    const header = [];
    if (!isRunning && queue.length > 0) {
      header.push(`
        <div class="queue-tab-actions">
          <button type="button" class="queue-run-next" onclick="runNextQueuedCampaign()" title="Start the next queued campaign now">▶ Run next</button>
        </div>
      `);
    }
    header.push(`<div class="queue-hint">Drag rows by the ≡ handle to reorder. The top row runs next.</div>`);

    const rows = queue.map((q, idx) => {
      const name = q.name || '(unnamed)';
      const modeLabel = dashboardModeLabel(q.mode || '');
      const accountCount = (q.profileIds || []).length;
      const accountLabel = accountCount ? `${accountCount} account${accountCount === 1 ? '' : 's'}` : '';
      const positionLabel = idx === 0 ? 'Next up' : `Position ${idx + 1}`;
      const id = escHtml(q.id || '');
      return `
        <div class="campaign-row campaign-row--queue" data-campaign-id="${id}" data-state="queued"
             draggable="true"
             ondragstart="_queueDragStart(event)"
             ondragover="_queueDragOver(event)"
             ondragleave="_queueDragLeave(event)"
             ondrop="_queueDrop(event)"
             ondragend="_queueDragEnd(event)">
          <span class="qhandle" aria-hidden="true">≡</span>
          <span class="campaign-row-name">${escHtml(name)}</span>
          <span class="campaign-row-type">${escHtml(modeLabel)}${accountLabel ? ' · ' + accountLabel : ''}</span>
          <span class="campaign-row-progress">${escHtml(positionLabel)}</span>
          <span class="campaign-row-status">Queued</span>
          <span class="campaign-row-actions">
            <button type="button" class="campaign-row-edit" onclick="editQueuedCampaign('${id}')" title="Edit this queued campaign">Edit</button>
            <button type="button" class="campaign-row-edit campaign-row-edit--icon" onclick="cancelQueuedCampaign('${id}')" title="Remove from queue" aria-label="Remove from queue">×</button>
          </span>
        </div>
      `;
    }).join('');
    list.innerHTML = header.join('') + rows;
  } catch {
    list.innerHTML = '<p class="empty-state">Failed to load queue.</p>';
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}

// v2.59.x — Drag-to-reorder for the dashboard's Queued tab. The dragged
// row is visually moved between siblings as the operator drags; on drop
// the new full order is POSTed atomically to /api/queue/reorder. Server
// returns 409 on mismatch (concurrent pop/cancel between our fetch and
// drop) — we surface that with a refresh and a brief alert.
let _queueDragId = null;

function _queueDragStart(ev) {
  const row = ev.currentTarget;
  _queueDragId = row.getAttribute('data-campaign-id') || null;
  if (!_queueDragId) { ev.preventDefault(); return; }
  row.classList.add('is-dragging');
  ev.dataTransfer.effectAllowed = 'move';
  // Required for Firefox to treat this as a real drag.
  try { ev.dataTransfer.setData('text/plain', _queueDragId); } catch {}
}

function _queueDragOver(ev) {
  if (!_queueDragId) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const target = ev.currentTarget;
  if (target.getAttribute('data-campaign-id') === _queueDragId) return;
  const rect = target.getBoundingClientRect();
  const above = ev.clientY < rect.top + rect.height / 2;
  target.classList.toggle('is-drop-target-above', above);
  target.classList.toggle('is-drop-target-below', !above);
}

function _queueDragLeave(ev) {
  const target = ev.currentTarget;
  target.classList.remove('is-drop-target-above', 'is-drop-target-below');
}

async function _queueDrop(ev) {
  ev.preventDefault();
  if (!_queueDragId) return;
  const target = ev.currentTarget;
  target.classList.remove('is-drop-target-above', 'is-drop-target-below');
  if (target.getAttribute('data-campaign-id') === _queueDragId) {
    _queueDragId = null;
    return;
  }
  const container = target.parentElement;
  const draggedRow = container?.querySelector(`.campaign-row--queue[data-campaign-id="${CSS.escape(_queueDragId)}"]`);
  if (!draggedRow || !container) { _queueDragId = null; return; }
  const rect = target.getBoundingClientRect();
  const above = ev.clientY < rect.top + rect.height / 2;
  if (above) container.insertBefore(draggedRow, target);
  else container.insertBefore(draggedRow, target.nextSibling);

  // v2.59.x — POST the new order RIGHT HERE (in drop, not dragend). dragend
  // can fire on an orphaned element if the row was moved/replaced, and we
  // were losing the POST that way. drop is the commit moment — capture the
  // new order, persist it, and only after the server confirms refresh from
  // truth. Visible toast + console log so a failed reorder is obvious.
  const ids = Array.from(container.querySelectorAll('.campaign-row--queue[data-campaign-id]'))
    .map(r => r.getAttribute('data-campaign-id'))
    .filter(Boolean);
  console.log('[queue-reorder] new order:', ids);
  _queueDragId = null;
  if (ids.length === 0) { refreshDashboardQueue(); return; }
  try {
    const res = await fetch('/api/queue/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('[queue-reorder] failed:', res.status, data);
      if (data.reason === 'mismatch') {
        _showQueueToast('Queue changed — refreshed', 2500);
      } else {
        _showQueueToast(`Could not save order: ${data.error || res.statusText}`, 4000);
      }
    } else {
      console.log('[queue-reorder] saved');
      _showQueueToast('New order saved', 1800);
    }
  } catch (err) {
    console.warn('[queue-reorder] error:', err);
    _showQueueToast(`Reorder failed: ${err.message}`, 4000);
  }
  refreshDashboardQueue();
}

// dragend now only handles visual cleanup — the POST moved into drop.
function _queueDragEnd(ev) {
  const row = ev.currentTarget;
  row.classList.remove('is-dragging');
  const container = row.parentElement;
  if (container) {
    container.querySelectorAll('.is-drop-target-above, .is-drop-target-below').forEach(el => {
      el.classList.remove('is-drop-target-above', 'is-drop-target-below');
    });
  }
  _queueDragId = null;
}

// v2.59.x — Lightweight toast for queue-reorder feedback. Anchored above
// the Queued tab so it doesn't compete with the sticky run-bar at the
// bottom. Self-clears after `ms` ms.
function _showQueueToast(msg, ms = 2000) {
  let toast = document.getElementById('queue-reorder-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'queue-reorder-toast';
    toast.style.cssText = 'position:fixed;top:18px;right:18px;z-index:9999;background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:9999px;font-family:var(--mono);font-size:0.62rem;letter-spacing:0.16em;text-transform:uppercase;box-shadow:0 4px 18px rgba(0,0,0,0.18);opacity:0;transition:opacity 0.2s ease;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
  }, ms);
}

window._queueDragStart = _queueDragStart;
window._queueDragOver = _queueDragOver;
window._queueDragLeave = _queueDragLeave;
window._queueDrop = _queueDrop;
window._queueDragEnd = _queueDragEnd;

async function runNextQueuedCampaign() {
  try {
    const res = await fetch('/api/queue/run-next', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      alert(`Could not run next: ${data.error || res.statusText}`);
      return;
    }
    if (!data.ok && data.message) {
      alert(data.message);
    }
  } catch (err) {
    alert(`Run-next failed: ${err.message}`);
  }
  refreshDashboardQueue();
  if (typeof refreshActiveCampaign === 'function') refreshActiveCampaign();
}
window.runNextQueuedCampaign = runNextQueuedCampaign;

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
  if (draftId) setActiveDraftId(draftId);

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
    ? `Window ends in <b>${escHtml(_fmtRemaining(remainingMs))}</b> — monitoring stops; still-pending leads stay <i>Connection Request Sent</i>`
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
          <label class="mon-auto-toggle" title="When off, the timer won't run checks or fire intros/follow-ups automatically — use ⚡ Check now.">
            <input type="checkbox" id="mon-auto-checks" ${state.autoChecksEnabled !== false ? 'checked' : ''} onchange="setMonitoringAutoChecks(this.checked)">
            Automatic checks
          </label>
        </div>
        <div class="mon-auto-hint" id="mon-auto-hint" style="${state.autoChecksEnabled === false ? '' : 'display:none'}">Auto-checks are off — use ⚡ Check now to run a check (and fire any due intros/follow-ups).</div>
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

async function setMonitoringAutoChecks(enabled) {
  const hint = document.getElementById('mon-auto-hint');
  if (hint) hint.style.display = enabled ? 'none' : '';
  try {
    const r = await fetch('/api/monitoring/auto-checks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  } catch (err) {
    alert('Could not change automatic checks: ' + err.message);
    const cb = document.getElementById('mon-auto-checks');
    if (cb) cb.checked = !enabled;            // revert to reflect the failed change
    if (hint) hint.style.display = !enabled ? 'none' : '';
  }
}
window.setMonitoringAutoChecks = setMonitoringAutoChecks;

async function monitoringStop() {
  if (!confirm('End monitoring now? Still-pending leads stay "Connection Request Sent" — they may still accept later.')) return;
  try {
    const res = await fetch('/api/monitoring/stop', { method: 'POST' }).then((r) => r.json());
    if (res.ok) {
      alert('Monitoring ended. Still-pending leads kept as "Connection Request Sent".');
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
  // v0.3 dashboard doesn't have #active-campaign-list — the active state is
  // rendered by renderActiveCard from the 2s pollStatus loop. We still need
  // to fetch status here so the queued-campaign-drain restart of pollStatus
  // works on the v0.3 dashboard too (previously this returned early before
  // the fetch, leaving the v0.3 active tile frozen on "No campaign running"
  // until the operator manually re-entered the wizard).
  try {
    const status = await fetch('/api/campaign/status').then((r) => r.json());
    const isActive = status && (status.running || status.paused);
    // v2.59.x — When a queued campaign drains in the background, the prior
    // campaign's pollStatus already stopped polling (idle → stop). Restart
    // it here so setCampaignButtons fires and the run-bar's Stop pill
    // re-enables. startPolling is idempotent — no-op if already ticking.
    if (isActive && typeof startPolling === 'function') startPolling();
    // No legacy list element → v0.3 dashboard. The pollStatus restart above
    // handles updating the v0.3 active card; nothing more to paint here.
    if (!list) return;
    if (!isActive) {
      // Drafts belong in the Drafts tab, not Active. (refreshDashboardDrafts
      // surfaces the legacy /api/draft-name fallback so nothing is lost.)
      list.innerHTML = '<p class="empty-state">No active campaigns.</p>';
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
        <button type="button" class="campaign-row-edit" onclick="viewRunningCampaign()" title="Open the live cockpit for this campaign">Edit</button>
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
  // v2.57.7: also re-clone source rows into the ALL tab so the queued-
  // delete row disappears from there too (without this, operator has to
  // tab-switch and back to see it gone).
  if (typeof renderDashboardAll === 'function') renderDashboardAll();
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
  if (typeof renderDashboardAll === 'function') renderDashboardAll();
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
    if (typeof renderDashboardAll === 'function') renderDashboardAll();
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

  // Extract the saved tab gid: prefer s.sheetGid (persisted by Task 5's history
  // snapshot); fall back to extracting #gid= from the saved sheetUrl.
  const _rerunSavedGid = (() => {
    if (s.sheetGid) return String(s.sheetGid);
    const m = (s.sheetUrl || '').match(/[#&?]gid=(\d+)/);
    return m ? m[1] : '';
  })();
  // Store so startCampaign can compare against the operator's current tab choice.
  window._savedSheetGid = _rerunSavedGid;

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
    sheetGid: _rerunSavedGid,
    dailyLimit: s.dailyLimit ?? 50,
    delayMin: s.delayMin ?? 30,
    delayMax: s.delayMax ?? 60,
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
    // Restore the saved tab as the operator's default choice so the picker
    // reflects the prior run. applyPresetConfig → previewSheet does NOT rebuild
    // the tab picker (that only happens on real URL oninput), so we set the
    // select + _chosenSheetGid directly. The tab-change modal will still fire
    // if the operator then manually picks a different tab before launching.
    if (_rerunSavedGid) {
      window._chosenSheetGid = _rerunSavedGid;
      const _tabSel = document.getElementById('sheet-tab-select');
      if (_tabSel) {
        // If the picker is populated (e.g. operator had previously used this
        // workbook this session), select the saved option.
        for (let i = 0; i < _tabSel.options.length; i++) {
          if (String(_tabSel.options[i].value) === _rerunSavedGid) {
            _tabSel.selectedIndex = i;
            break;
          }
        }
      }
    }
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

// Module-scope row builder for history entries (past, monitoring, and the
// stopped subset now living in the Drafts & Stops tab). Was previously
// inline inside refreshPastCampaigns — extracted so refreshDashboardDrafts
// can render stopped rows in the same layout without duplicating markup.
// v2.76: modes that register post-campaign reply tracking (so a "turn on"
// affordance makes sense even when currently off). Mirrors _REPLY_MODES in
// campaign.js.
const PAST_REPLY_MODES = new Set(['open_profile_only', 'introduce_back', 'message_only', 'connect_and_introduce', 'connect_and_message']);

// v2.76: monitoring on/off chip for a Past row. Shows "● Monitoring · Nd"
// (background reply/accept checks running) with a click to turn it off, or
// "Monitoring off" → click to turn on (reply-capable modes only).
function monitoringChipHtml(idx, c) {
  const mon = c.monitoring || {};
  if (mon.active) {
    const daysLeft = mon.expiresAt ? Math.max(0, Math.ceil((mon.expiresAt - Date.now()) / 86400000)) : 0;
    const label = '● Monitoring' + (daysLeft ? ' · ' + daysLeft + (daysLeft === 1 ? ' day' : ' days') : '');
    return `<button type="button" class="mon-chip is-on" title="Background reply/accept checks are running for this campaign (reopens browsers periodically). Click to turn off." onclick="event.stopPropagation(); togglePastMonitoring(${idx}, false, this)">${label}</button>`;
  }
  if (PAST_REPLY_MODES.has(c.mode)) {
    return `<button type="button" class="mon-chip is-off" title="Background reply/accept checks are off. Click to turn on (runs for 7 days)." onclick="event.stopPropagation(); togglePastMonitoring(${idx}, true, this)">Monitoring off</button>`;
  }
  return '';
}

async function togglePastMonitoring(idx, on, btn) {
  if (btn) { btn.disabled = true; btn.textContent = on ? 'Starting…' : 'Stopping…'; }
  try {
    const r = await fetch(`/api/history/${idx}/monitoring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'failed');
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(on
        ? 'Monitoring turned on — reply/accept checks will run for 7 days.'
        : 'Monitoring stopped — browsers will no longer reopen for this campaign.', 4000);
    }
    if (typeof window.renderPastSection === 'function') window.renderPastSection();
    else if (typeof refreshPastCampaigns === 'function') refreshPastCampaigns();
  } catch (e) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Could not change monitoring: ' + e.message, 5000);
    if (btn) btn.disabled = false;
  }
}
window.togglePastMonitoring = togglePastMonitoring;

// v2.78: "Run a solo check" — a one-off connection check for a past campaign.
// Clicking opens a choice modal: this campaign's accounts, or every sender in
// the sheet's Sender column. Distinct from the monitoring chip (which is the
// recurring 7-day background tracking).
let _soloCheckIdx = null;
let _soloCheckRunning = false;
let _soloCheckRunningIdx = null;
function soloCheckChipHtml(idx, c) {
  if (!c.settings || !c.settings.sheetUrl) return '';
  // While this row's solo check runs, swap the button for a Stop control.
  if (_soloCheckRunning && _soloCheckRunningIdx === idx) {
    return `<button type="button" class="mon-chip is-stop-solo" title="Stop the running solo check." onclick="event.stopPropagation(); stopSoloCheck(this)">■ Stop solo check</button>`;
  }
  return `<button type="button" class="mon-chip is-solo" title="Run one connection check now — choose this campaign's accounts or all senders in the sheet." onclick="event.stopPropagation(); openSoloCheckModal(${idx})">Run a solo check</button>`;
}
// The scope-choice modal is shared: a handler is set when it's opened, and the
// two buttons dispatch the chosen mode ('campaign' | 'sheet') to it.
let _soloCheckHandler = null;
function _showSoloCheckModal() {
  const m = document.getElementById('solo-check-modal');
  if (m) m.classList.remove('hidden');
}
function openSoloCheckModal(idx) {            // Past-row "Run a solo check"
  _soloCheckIdx = idx;
  _soloCheckHandler = (mode) => _runSoloCheckPast(idx, mode);
  _showSoloCheckModal();
}
function openActiveBulkCheckModal() {          // active "Run check now"
  _soloCheckHandler = (mode) => _runActiveBulkCheck(mode);
  _showSoloCheckModal();
}
function closeSoloCheckModal() {
  const m = document.getElementById('solo-check-modal');
  if (m) m.classList.add('hidden');
}
function runSoloCheck(mode) {                   // modal buttons → dispatch
  closeSoloCheckModal();
  const h = _soloCheckHandler;
  _soloCheckHandler = null;
  if (typeof h === 'function') h(mode);
}

// Active running/monitoring campaign: bulk connection check, scoped to the
// campaign's accounts or all senders in the sheet (allSenders → server derives
// from the Sender column even mid-run).
async function _runActiveBulkCheck(mode) {
  let s = {};
  try { s = await (await fetch('/api/campaign/status')).json(); } catch { /* */ }
  if (!s.sheetUrl) { if (typeof showCampaignToast === 'function') showCampaignToast('No sheet URL'); return; }
  const body = { sheetUrl: s.sheetUrl, linkedinColumn: s.linkedinColumn };
  if (mode === 'sheet') body.allSenders = true;
  else body.profileIds = s.profileIds;
  // v2.98: offer to reconnect & retry previously-failed intros first. The server
  // falls back to the live campaign's templates when the status omits them.
  await _maybeConfirmReviveIntros(body, {
    primaryName: (s.templates && s.templates.primaryName) || '',
    primarySource: s.templates && s.templates.primarySource,
    autoAcceptPrimary: s.templates && s.templates.autoAcceptPrimary,
  });
  const willPause = !!(s.running && !s.paused);
  if (typeof showCampaignToast === 'function') {
    showCampaignToast(mode === 'sheet'
      ? (willPause ? 'Pausing + checking all senders in the sheet…' : 'Checking all senders in the sheet…')
      : (willPause ? 'Pausing campaign + running bulk check…' : 'Running bulk check…'));
  }
  try {
    const r = await fetch('/api/bulk-check-now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      const res = d.result || {};
      if (typeof showCampaignToast === 'function') showCampaignToast(`Bulk check done — ${res.matched || 0} newly accepted${d.autoPaused ? '. Campaign resumed.' : ''}.`);
    } else if (typeof showCampaignToast === 'function') {
      showCampaignToast('Bulk check failed: ' + (d.error || 'unknown'));
    }
  } catch (e) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Bulk check failed: ' + e.message);
  }
}

// v2.98 — before a solo check runs, pre-scan the sheet for terminal
// "Failed — Primary not in your connections" rows (scoped to the accounts this
// check will sweep). If any exist, ask the operator — naming the primary — and
// on OK set body.reviveFailedIntros so the server reconnects to the primary,
// auto-accepts, and retries those intros. Best-effort: any error just proceeds
// with a normal check. Mutates + returns body.
async function _maybeConfirmReviveIntros(body, opts) {
  opts = opts || {};
  try {
    const r = await fetch('/api/intro-failures/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheetUrl: body.sheetUrl,
        linkedinColumn: body.linkedinColumn || '',
        profileId: body.profileId,
        profileIds: body.profileIds,
        allSenders: body.allSenders,
        primaryName: opts.primaryName || '',
        primarySource: opts.primarySource,
        autoAcceptPrimary: opts.autoAcceptPrimary,
      }),
    });
    if (!r.ok) return body;
    const d = await r.json().catch(() => ({}));
    const count = (d && d.count) || 0;
    if (count > 0) {
      const who = ((d.primaryName || opts.primaryName || '').trim()) || 'the primary';
      // v2.100: open the custom modal (replaces native confirm) so the operator
      // can flip auto-accept ON inline and pick the primary's GoLogin profile
      // when it isn't already known. Returns the operator's choices.
      const choice = await _openReviveModal({
        count,
        who,
        autoAccept: !!d.autoAccept,
        acceptVia: d.acceptVia,
        acceptViaName: d.acceptViaName,
        // the known gologin id (if the campaign saved one); '' / 'local-browser' → not known
        knownSourceId: opts.primarySource,
      });
      if (choice && choice.ok) {
        body.reviveFailedIntros = true;
        body.autoAcceptPrimary = choice.autoAccept;
        // Only override primarySource when auto-accepting — the picked GoLogin
        // profile is the primary's own account that drains the accept queue.
        if (choice.autoAccept && choice.primarySource) {
          body.primarySource = choice.primarySource;
        }
      }
    }
  } catch { /* best-effort — proceed without revive */ }
  return body;
}

// v2.100 — Reconnect & retry modal plumbing. _openReviveModal resolves with
// {ok, autoAccept, primarySource}. The picker reuses allProfilesData +
// findSoOForProfile + renderSoOBadges (same machinery as the wizard's
// primary-source picker). Inline onclick handlers require window.* assignment
// because app.js is an ES module (module-scoped functions aren't global).
let _reviveModalResolve = null;
let _reviveWho = 'the primary';

// v2.100.1 — when the campaign didn't save the primary's GoLogin profile, guess
// it from the primary's name (team convention: profile name = SoO email, e.g.
// "Julia Isabelle Yabut" → julia.yabut@ortus.solutions). Picks a profile only
// when the surname uniquely identifies one, so we never auto-select the wrong
// account.
function _guessPrimaryProfileId(primaryName) {
  const name = String(primaryName || '').toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  if (!name) return '';
  const tokens = name.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return '';
  const profiles = allProfilesData || [];
  // 1) Unique surname (last token) match — the strongest signal.
  const last = tokens[tokens.length - 1];
  const surnameHits = profiles.filter((p) => (p.name || '').toLowerCase().includes(last));
  if (surnameHits.length === 1) return surnameHits[0].id;
  // 2) Otherwise the profile matching the most name tokens, if unambiguous (≥2).
  let best = '', bestScore = 0, tie = false;
  profiles.forEach((p) => {
    const hay = (p.name || '').toLowerCase();
    const score = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = p.id; tie = false; }
    else if (score === bestScore && score > 0) { tie = true; }
  });
  return (bestScore >= 2 && !tie) ? best : '';
}

async function _openReviveModal(cfg) {
  // Populate the profile list FIRST so pre-selection (saved or name-guessed)
  // works on open instead of after a manual search.
  if ((!allProfilesData || !allProfilesData.length) && typeof loadProfiles === 'function') {
    try { await loadProfiles(); } catch { /* picker shows empty until loaded */ }
  }
  return new Promise((resolve) => {
    _reviveModalResolve = resolve;
    _reviveWho = cfg.who || 'the primary';
    const bodyEl = document.getElementById('revive-intros-body');
    if (bodyEl) {
      bodyEl.innerHTML =
        `<p style="margin:0 0 10px;"><b>${cfg.count}</b> introduction(s) previously failed because ${escHtml(_reviveWho)} isn't a 1st-degree connection of the sending account(s).</p>` +
        `<p style="margin:0;">The affected account(s) will send ${escHtml(_reviveWho)} a connection request, then the introductions retry automatically on the next check.</p>`;
    }
    document.querySelectorAll('#revive-primary-name, #revive-source-who').forEach((el) => { el.textContent = _reviveWho; });
    // Pre-select the known GoLogin profile; local-browser / blank → fall back to
    // guessing it from the primary's name (team convention: profile = SoO email).
    let known = (cfg.knownSourceId && cfg.knownSourceId !== 'local-browser') ? cfg.knownSourceId : '';
    if (!known) known = _guessPrimaryProfileId(_reviveWho);
    const hid = document.getElementById('revive-source-profile-id'); if (hid) hid.value = known;
    const srch = document.getElementById('revive-source-search'); if (srch) srch.value = '';
    const cb = document.getElementById('revive-auto-accept'); if (cb) cb.checked = !!cfg.autoAccept;
    _onReviveAutoAcceptToggle();
    const m = document.getElementById('revive-intros-modal');
    if (m) m.classList.remove('hidden');
  });
}

function _onReviveAutoAcceptToggle() {
  const aa = !!document.getElementById('revive-auto-accept')?.checked;
  const picker = document.getElementById('revive-source-picker');
  const note = document.getElementById('revive-manual-note');
  if (picker) picker.style.display = aa ? '' : 'none';
  if (note) note.style.display = aa ? 'none' : '';
  if (aa) _renderReviveSourcePicker(document.getElementById('revive-source-search')?.value || '');
  _updateReviveOkState();
}
window._onReviveAutoAcceptToggle = _onReviveAutoAcceptToggle;

function _renderReviveSourcePicker(filter = '') {
  const grid = document.getElementById('revive-source-grid');
  if (!grid) return;
  const sel = document.getElementById('revive-source-profile-id')?.value || '';
  const q = (filter || '').trim().toLowerCase();
  const rows = (allProfilesData || []).filter((p) =>
    !q || (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q));
  grid.innerHTML = '';
  if (rows.length === 0) {
    grid.innerHTML = '<div class="aa-acct-empty">No profiles match.</div>';
    return;
  }
  rows.forEach((p) => {
    const soo = (typeof findSoOForProfile === 'function') ? findSoOForProfile(p.name) : null;
    const isSel = p.id === sel;
    const row = document.createElement('div');
    row.className = 'aa-acct-row' + (isSel ? ' sel' : '');
    row.dataset.profileId = p.id;
    row.innerHTML = `
      <input type="radio" name="revive-source-profile" ${isSel ? 'checked' : ''}>
      <div class="body">
        <div class="name">${escHtml(p.name)}</div>
        ${!soo ? `<div class="id">${p.id.substring(0, 12)}…</div>` : ''}
        ${typeof renderSoOBadges === 'function' ? renderSoOBadges(soo) : ''}
      </div>`;
    row.addEventListener('click', () => {
      const hidden = document.getElementById('revive-source-profile-id');
      if (hidden) hidden.value = p.id;
      _renderReviveSourcePicker(document.getElementById('revive-source-search')?.value || '');
      _updateReviveOkState();
    });
    grid.appendChild(row);
  });
}
window._renderReviveSourcePicker = _renderReviveSourcePicker;

function _updateReviveOkState() {
  const aa = !!document.getElementById('revive-auto-accept')?.checked;
  const sel = document.getElementById('revive-source-profile-id')?.value || '';
  const btn = document.getElementById('revive-ok-btn');
  const hint = document.getElementById('revive-source-hint');
  const needsPick = aa && !sel;
  if (btn) {
    btn.disabled = needsPick;
    btn.classList.toggle('is-disabled', needsPick);
  }
  if (hint) {
    if (needsPick) {
      hint.textContent = `Pick ${_reviveWho}'s GoLogin profile to auto-accept from.`;
      hint.classList.remove('err');
    } else if (aa && sel) {
      const p = (allProfilesData || []).find((x) => x.id === sel);
      hint.textContent = `Will auto-accept from "${p ? p.name : sel}".`;
      hint.classList.remove('err');
    } else {
      hint.textContent = '';
    }
  }
}

function _resolveReviveModal(ok) {
  const aa = !!document.getElementById('revive-auto-accept')?.checked;
  const src = document.getElementById('revive-source-profile-id')?.value || '';
  // Guard: OK with auto-accept on but no profile chosen — keep the modal open.
  if (ok && aa && !src) { _updateReviveOkState(); return; }
  const m = document.getElementById('revive-intros-modal');
  if (m) m.classList.add('hidden');
  const resolve = _reviveModalResolve;
  _reviveModalResolve = null;
  if (typeof resolve !== 'function') return;
  if (!ok) { resolve({ ok: false }); return; }
  resolve({ ok: true, autoAccept: aa, primarySource: aa ? src : '' });
}
window._resolveReviveModal = _resolveReviveModal;

async function _runSoloCheckPast(idx, mode) {
  if (idx == null) return;
  const entry = Array.isArray(_v3PastEntries) ? _v3PastEntries.find((e) => e._originalIdx === idx) : null;
  const s = entry && entry.settings;
  if (!s || !s.sheetUrl) {
    if (typeof showCampaignToast === 'function') showCampaignToast('No saved settings for this campaign.');
    return;
  }
  const t = s.templates || {};
  const body = {
    sheetUrl: s.sheetUrl,
    linkedinColumn: s.linkedinColumn || '',
    primaryName: t.primaryName || '',
    primaryIntroBody: t.primaryIntroBody || '',
    primaryUrl: t.primaryUrl || '',
    introTitle: t.introTitle || '',
    // v2.99: carry the saved primary GoLogin account + auto-accept flag so the
    // accept routes to the primary's own profile (there's no live campaign to
    // fall back to for a past-campaign solo check).
    primarySource: t.primarySource,
    autoAcceptPrimary: t.autoAcceptPrimary,
  };
  // 'campaign' → pass the saved accounts. 'sheet' → omit profileIds so the
  // server derives every account from the sheet's Sender column.
  if (mode === 'campaign') body.profileIds = Array.isArray(s.profileIds) ? s.profileIds : [];
  if (mode === 'sheet') body.allSenders = true;
  // v2.98: offer to reconnect & retry previously-failed intros first.
  await _maybeConfirmReviveIntros(body, {
    primaryName: t.primaryName || '',
    primarySource: t.primarySource,
    autoAcceptPrimary: t.autoAcceptPrimary,
  });
  if (typeof showCampaignToast === 'function') {
    showCampaignToast(mode === 'sheet'
      ? 'Solo check started — sweeping all senders in the sheet… watch the log.'
      : 'Solo check started — sweeping this campaign’s accounts… watch the log.', 5000);
  }
  // Flip to the Stop button while the sweep runs.
  _soloCheckRunning = true;
  _soloCheckRunningIdx = idx;
  if (typeof window.renderPastSection === 'function') window.renderPastSection();
  try {
    const r = await fetch('/api/bulk-check-now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'failed');
    const res = d.result || {};
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(`Solo check done — ${res.matched || 0} Connected, ${res.stamped || 0} still pending across ${d.profilesSweep || 0} account(s).`, 7000);
    }
  } catch (e) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Solo check failed: ' + e.message, 7000);
  } finally {
    _soloCheckRunning = false;
    _soloCheckRunningIdx = null;
    if (typeof window.renderPastSection === 'function') window.renderPastSection();
  }
}
async function stopSoloCheck(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  try {
    await fetch('/api/bulk-check/stop', { method: 'POST' });
    if (typeof showCampaignToast === 'function') showCampaignToast('Stopping solo check…', 3000);
  } catch (e) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Could not stop: ' + e.message, 4000);
    if (btn) { btn.disabled = false; btn.textContent = '■ Stop solo check'; }
  }
  // The in-flight runSoloCheck fetch resolves once the sweep breaks; its
  // finally clears the running state and re-renders the Run button.
}
window.openSoloCheckModal = openSoloCheckModal;
window.openActiveBulkCheckModal = openActiveBulkCheckModal;
window.closeSoloCheckModal = closeSoloCheckModal;
window.runSoloCheck = runSoloCheck;
window.stopSoloCheck = stopSoloCheck;

function buildPastRowHtml({ idx, c }) {
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
  // STOPPED chip = one-shot resume affordance (variant F). Click resumes
  // from the saved settings snapshot; Edit pill covers the "edit first"
  // path. Gating: any stopped entry with a saved snapshot.
  const canResume = reason === 'stopped' && !!c.settings;
  const statusClasses = canResume ? `${reasonClass} is-stopped-action` : reasonClass;
  const statusAttrs = canResume
    ? `role="button" tabindex="0" title="Resume this campaign — pick up where it stopped" onclick="event.stopPropagation(); resumeFromPastRow(${idx})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();resumeFromPastRow(${idx});}"`
    : '';
  const rowState = c.state === 'monitoring' ? 'monitoring' : (c.state || 'past');
  return `
    <div class="campaign-row campaign-row-clickable campaign-row--with-edit" data-campaign-id="${escHtml(c.id || c.runId || 'past-' + idx)}" data-state="${escHtml(rowState)}" data-history-idx="${idx}" data-past-idx="${idx}" onclick="openPastCampaignModal(${idx})">
      <input type="checkbox" class="past-row-checkbox" data-past-idx="${idx}" ${checked} onclick="event.stopPropagation()" onchange="onPastRowCheckboxChange(event, ${idx})" aria-label="Select campaign" />
      <div class="campaign-row-name">${dashboardNameButton(c.name, 'past', String(idx))}</div>
      <span class="campaign-row-type">${escHtml(subtitle)}</span>
      <span class="campaign-row-progress">${escHtml(processed + ' processed')}</span>
      <span class="campaign-row-status ${statusClasses}" ${statusAttrs}>${reasonLabel}</span>
      ${monitoringChipHtml(idx, c)}
      <button type="button" class="campaign-row-edit" onclick="event.stopPropagation(); goCreateCampaign()" title="Open the campaign page">Edit</button>
      <button type="button" class="past-row-delete" aria-label="Delete campaign" onclick="event.stopPropagation(); singleDeletePast(${idx})">&times;</button>
    </div>
  `;
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
    // v2.59 (Drafts & Stops merge): stopped campaigns moved to the Drafts &
    // Stops tab. Past tab now shows only completed + errored.
    const visible2 = _renderablePast.filter(({ c }) => (c.endReason || 'completed') !== 'stopped');

    list.innerHTML = visible2.map(buildPastRowHtml).join('');

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
      const pastMonitoringHtml = _renderableMonitoring.map(buildPastRowHtml).join('');
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
  window.__viewingActiveCampaign = false;
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
  // v2.57.7: capture the source index BEFORE closeResumeChoiceModal()
  // clears it. We delete the old past entry once the resume starts so
  // the dashboard doesn't accumulate duplicates (FIFO — only the most
  // recent run of a given campaign survives).
  const oldIdx = _resumeChoiceIdx;
  const entry = (pastCampaignsCache || []).find(e => e.idx === oldIdx);
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
    delayMin: s.delayMin ?? 30,
    delayMax: s.delayMax ?? 60,
    linkedinColumn: s.linkedinColumn || '',
    concurrency: s.concurrency ?? 1,
    // v2.60.x: don't suffix "(resumed)" — keeps the name clean across
    // multiple resumes. The new past-history entry's timestamp + the
    // original entry's STOPPED ▸ RESUME chip together tell the story.
    name: c.name || '',
    // v2.52.0: carry forward the operator-chosen monitoring cadence so resume
    // doesn't silently fall back to the server's 60-min default. Pre-v2.52
    // history entries don't have the field — undefined here lets the server
    // apply its 60-min default just like before.
    checkIntervalMinutes: s.checkIntervalMinutes,
    // v2.112: carry the operator's automatic-checks choice across resume.
    autoChecksEnabled: s.autoChecksEnabled,
    // v2.59 resume — seed cockpit + history with the prior run's totals so
    // counters continue instead of restarting from 0. processedToday is
    // intentionally NOT seeded (it's a today-only counter; resuming on a
    // new day shouldn't lie about today's sends).
    resumeContext: {
      totalProcessed: Number(c.totalProcessed) || Number(c.successCount) || 0,
    },
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

    // v2.57.7: now that the resume has started, delete the source past
    // entry so the dashboard collapses to a single row per campaign.
    // FIFO behaviour requested by operator — without this, every resume
    // doubles the past list with near-duplicate entries.
    if (Number.isInteger(oldIdx) && oldIdx >= 0) {
      try {
        await fetch('/api/history/delete-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ indexes: [oldIdx] }),
        });
        if (typeof refreshPastCampaigns === 'function') await refreshPastCampaigns();
        // v2.58.x — ALL tab is a derived view that clones rows from the
        // source tabs (active/past/queued/...). Refresh the active tab
        // FIRST so the freshly-resumed campaign exists as a clone source
        // before renderDashboardAll() runs. Without this the ALL tab
        // briefly shows "No campaigns yet" until the 2s poll tick lands.
        if (typeof refreshActiveCampaign === 'function') await refreshActiveCampaign();
        if (typeof renderDashboardAll === 'function') renderDashboardAll();
        if (typeof dashRefreshAll === 'function') dashRefreshAll();
      } catch (delErr) {
        console.warn('[resume] failed to delete source past entry:', delErr.message);
      }
    }
  } catch (err) {
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(`Resume failed: ${err.message}`, 6000);
    }
  }
}
window.resumeWithSameSettings = resumeWithSameSettings;

// v2.60.x: One-shot resume entry point used by the chip-as-button on past
// rows (variant F). Sets the module-scoped _resumeChoiceIdx so the
// existing resumeWithSameSettings() can find the entry, then calls it
// directly — no modal. The Edit pill on the past row remains the path
// for "I want to tweak settings before starting again".
function resumeFromPastRow(idx) {
  _resumeChoiceIdx = idx;
  resumeWithSameSettings();
}
window.resumeFromPastRow = resumeFromPastRow;

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
  window.__viewingActiveCampaign = false;
  // Fresh draft → re-arm the scrape baseline so the next scrape view hides any
  // prior run's jobs (the engine's job list is global, not per-draft).
  _scrapeBaselineDone = false;
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
      setActiveDraftId(data?.draft?.id || '');
    }
  } catch { /* fall through; wizard still works without a draft id */ }
  try { localStorage.removeItem('campaignName'); } catch {}
  try { localStorage.removeItem('wizardStoppedFromContext'); } catch {}
  // v2.86.1 (port): a brand-new campaign is NOT an edit-resume. Drop the
  // edit-resume context and hide the "Editing a stopped campaign" banner so it
  // can't leak in from a previous edit-resume session. (Also stops a stale
  // editResumeSourceIdx from later deleting the wrong history row.)
  try { localStorage.removeItem('editResumeSourceIdx'); } catch {}
  { const _rb = document.getElementById('wizard-resume-banner'); if (_rb) _rb.style.display = 'none'; }
  wizardDirty = false;
  _runningEditWarningShown = false;
  const input = document.getElementById('campaign-name-input');
  if (input) input.value = '';
  // Clear every wizard input whose value persists in the DOM between route
  // changes. Without this, the previously-edited campaign's sheet URL,
  // templates, primary-person fields, etc. bleed into the fresh wizard.
  // daily-limit-input is intentionally NOT cleared (it has a sensible
  // default of 50 set in the HTML); mode selection is JS state handled
  // separately by the profile/mode reset below.
  const _clearIds = [
    'sheet-url',
    'tpl-note', 'tpl-followup',
    'tpl-inmail-subject', 'tpl-inmail-body',
    'tpl-op-subject', 'tpl-op-body',
    'primary-intro-body', 'intro-title',
    'primary-person-url', 'primary-person-name',
  ];
  for (const id of _clearIds) {
    const el = document.getElementById(id);
    if (el && 'value' in el) el.value = '';
  }
  if (typeof updateSheetTabHint === 'function') updateSheetTabHint();
  if (typeof _refreshOpenSheetButtons === 'function') _refreshOpenSheetButtons();
  // Clear the loaded sheet preview pane (row count, sample rows, IC
  // mapping block) so the previous campaign's table doesn't sit there
  // looking like it belongs to the new one.
  const _sheetPreview = document.getElementById('sheet-preview');
  if (_sheetPreview) { _sheetPreview.innerHTML = ''; _sheetPreview.classList.add('hidden'); }
  const _icExtras = document.getElementById('ic-extras');
  const _icExtrasEmpty = document.getElementById('ic-extras-empty');
  const _icExtrasFilled = document.getElementById('ic-extras-filled');
  if (_icExtrasFilled) _icExtrasFilled.style.display = 'none';
  if (_icExtrasEmpty) _icExtrasEmpty.style.display = '';
  selectedProfileIds = [];
  selectedProfileNames = {};
  if (typeof renderProfiles === 'function' && Array.isArray(allProfilesData)) renderProfiles(allProfilesData);
  if (typeof renderSelectedPanel === 'function') renderSelectedPanel();
  if (typeof updateChipCounts === 'function') updateChipCounts();
  goCreateCampaign();
  if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
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
  // 2026-05-27 (drafts-isolation): when an active draft id is set (whether
  // freshly created by startNewCampaign or loaded by editDraft), the draft
  // row IS the source of truth — fetch its name and use it verbatim (empty
  // string for a fresh draft). Skip the running-status / legacy / cached
  // fallbacks so the previous campaign's name doesn't bleed in.
  const activeId = getActiveDraftId();
  if (activeId) {
    let nm = '';
    try {
      const r = await fetch('/api/drafts/' + encodeURIComponent(activeId));
      if (r.ok) nm = (await r.json())?.name || '';
      else if (r.status === 404) {
        // Draft was deleted from the dashboard while wizard was open.
        clearActiveDraft();
      }
    } catch {}
    input.value = nm;
    return;
  }
  let value = '';
  let isRunning = false;
  try {
    const sRes = await fetch('/api/campaign/status');
    if (sRes.ok) {
      const status = await sRes.json();
      isRunning = !!(status.running || status.paused);
      // v2.59: drop the !isRunning gate. The Active tab's Edit button calls
      // viewRunningCampaign() which clears the active draft id — so falling
      // through to status.name here is exactly how we surface the running
      // campaign's name in the wizard.
      if (!value && status.name) value = status.name;
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

// True when the wizard is bound to the currently-running campaign — i.e.,
// the operator entered via the Active tab's Edit button (which clears
// currentDraftId via viewRunningCampaign). In that mode, Save Edits MUST
// NOT create a new draft (the running campaign already exists in /api/
// campaign/status); field changes won't take effect until the campaign
// is stopped + relaunched.
function isViewingRunningCampaign() {
  try {
    if (typeof location === 'undefined' || location.hash !== '#/new') return false;
    if (getActiveDraftId()) return false;
    return !!(typeof __cockpit !== 'undefined' && __cockpit && (__cockpit.running || __cockpit.paused));
  } catch { return false; }
}

// Module-level dirty flag — flipped true by wizardDirtyOnInput when the
// operator types into any watched wizard field. Cleared on Save / start
// / startNewCampaign / editDraft. Used by saveCampaignEdits to pick
// between the no-op-on-running-with-no-edits path and the stop-first
// warning path.
let wizardDirty = false;

// First-edit-while-running modal — shown once per dirty-cycle when the
// operator types into a wizard field while viewing the running campaign.
// Tells them the change won't apply unless they stop + relaunch (or stop
// + save edits). The modal is dismissable; dirty stays true until Save
// or campaign stop.
let _runningEditWarningShown = false;
function showRunningEditWarning() {
  if (_runningEditWarningShown) return;
  _runningEditWarningShown = true;
  const bg = document.createElement('div');
  bg.className = 'dash-dialog-bg';
  bg.innerHTML = `
    <div class="dash-dialog" role="dialog" aria-modal="true">
      <h2>Campaign is running</h2>
      <p>Edits to the wizard fields <b>will not apply</b> while the campaign is running. Stop the campaign first, then either relaunch it or press Save Edits to persist the changes as a new starting point.</p>
      <div class="dash-dialog-actions">
        <button type="button" class="btn btn-primary" id="rew-ok">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  const ok = bg.querySelector('#rew-ok');
  const close = () => bg.remove();
  ok.onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  ok.focus();
}

function wizardDirtyOnInput() {
  // 2026-05-27 (drafts-isolation): every input on the wizard triggers a
  // debounced autosave — the dirty flag is kept for legacy code paths that
  // read it (Save Edits button, viewing-running-campaign warning). We no
  // longer early-return on `wizardDirty`, because the autosave needs to
  // pick up EVERY keystroke, not just the first.
  if (!wizardDirty && isViewingRunningCampaign()) showRunningEditWarning();
  wizardDirty = true;
  debouncedAutosave();
}

// Wire input/change listeners on every watched wizard field. Idempotent.
function initWizardDirtyTracking() {
  if (document.body.__wizardDirtyWired) return;
  document.body.__wizardDirtyWired = true;
  const watchIds = [
    'campaign-name-input', 'sheet-url', 'daily-limit-input',
    'tpl-note', 'tpl-followup',
    'tpl-inmail-subject', 'tpl-inmail-body',
    'tpl-op-subject', 'tpl-op-body',
    'primary-intro-body', 'intro-title',
    'primary-person-url', 'primary-person-name',
  ];
  for (const id of watchIds) {
    const el = document.getElementById(id);
    if (el && !el.__dirtyWired) {
      el.addEventListener('input', wizardDirtyOnInput);
      el.addEventListener('change', wizardDirtyOnInput);
      el.__dirtyWired = true;
    }
  }
  // Snappier feedback for the launch pill: live-mirror the campaign name
  // as the user types instead of waiting for the 500ms autosave debounce.
  const nameInput = document.getElementById('campaign-name-input');
  if (nameInput && !nameInput.__pillMirrorWired) {
    nameInput.addEventListener('input', () => {
      if (typeof window.updateEditingBanner === 'function') {
        try { window.updateEditingBanner(); } catch (_) {}
      }
    });
    nameInput.__pillMirrorWired = true;
  }
}
document.addEventListener('DOMContentLoaded', initWizardDirtyTracking);
if (document.readyState !== 'loading') initWizardDirtyTracking();

// ─────────────────────────────────────────────────────────────────────────
// Debounced draft autosave.
//
// Called on every wizard input. Serializes pending saves so a later PATCH
// awaits an earlier one (no two PATCHes in flight to the same draft id at
// once). flushAutosaveImmediate() is the public hook for callers like the
// banner's launch CTA — they MUST await the queue before reading wizard
// values, otherwise the server-side draft would lag behind the form.
//
// No-ops when getActiveDraftId() is null (e.g. the wizard is bound to the
// running campaign, not a draft).
// ─────────────────────────────────────────────────────────────────────────
const AUTOSAVE_DEBOUNCE_MS = 500;
let _autosaveTimer = null;
let _autosavePending = null;
let _lastAutosavedAt = null;

function debouncedAutosave() {
  if (!getActiveDraftId()) return; // no draft → nothing to save
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    _autosaveTimer = null;
    _flushAutosave();
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function flushAutosaveImmediate() {
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  if (_autosavePending) { try { await _autosavePending; } catch {} }
  await _flushAutosave();
}

async function _flushAutosave() {
  const id = getActiveDraftId();
  if (!id) return;
  let config = null;
  try { config = (typeof collectCurrentConfig === 'function') ? collectCurrentConfig() : null; }
  catch (err) { console.warn('[drafts] collectCurrentConfig failed:', err); }
  const nameInput = document.getElementById('campaign-name-input');
  const name = (nameInput?.value || '').trim();
  // Serialize: if a previous save is still in-flight, wait it out before
  // starting a new one.
  if (_autosavePending) { try { await _autosavePending; } catch {} }
  _autosavePending = fetch('/api/drafts/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  }).then(async (r) => {
    if (r.ok) {
      _lastAutosavedAt = Date.now();
      updateSavePip();
      if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
    } else if (r.status === 404) {
      // Draft was deleted out from under us — drop the stale id so the
      // next input doesn't keep firing 404s.
      clearActiveDraft();
      if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
    } else {
      const body = await r.json().catch(() => ({}));
      console.warn('[drafts] autosave failed:', r.status, body);
    }
  }).catch((err) => {
    console.warn('[drafts] autosave error:', err);
  }).finally(() => {
    _autosavePending = null;
  });
  return _autosavePending;
}

function updateSavePip() {
  const pip = document.getElementById('wiz-save-pip');
  if (!pip) return;
  if (!_lastAutosavedAt) { pip.textContent = '— not saved yet'; return; }
  const sec = Math.round((Date.now() - _lastAutosavedAt) / 1000);
  if (sec < 5) pip.textContent = 'saved just now';
  else if (sec < 60) pip.textContent = `saved ${sec}s ago`;
  else pip.textContent = `saved ${Math.round(sec / 60)}m ago`;
}

// Tick the pip every 5s so "saved 30s ago" doesn't stay stale at "5s ago".
setInterval(updateSavePip, 5000);

window.flushAutosaveImmediate = flushAutosaveImmediate;
window.debouncedAutosave = debouncedAutosave;
window.updateSavePip = updateSavePip;

// ─────────────────────────────────────────────────────────────────────────
// Editing banner (variant B) — pinned to top of the wizard. Shows the
// draft name + autosave pip + "+ Add to queue" CTA. The banner is the
// canonical launch surface for drafts; the section-VI Add to Queue
// button is hidden under the same refactor.
// ─────────────────────────────────────────────────────────────────────────
window.updateEditingBanner = function() {
  // Sales Nav Scrape has its OWN launcher (the Start Scrape button in the
  // section-6 scrape card). The campaign launch rail does not apply — its
  // "Launch options" would start an outreach CAMPAIGN, not a scrape — so hide
  // it entirely in scrape mode to remove the wrong launch path.
  if (document.getElementById('campaign-mode')?.value === 'sales_nav_scrape') {
    const rail = document.getElementById('wiz-launch-rail');
    const inlineEl = document.getElementById('wiz-editing-inline');
    if (rail) rail.style.display = 'none';
    if (inlineEl) inlineEl.style.display = 'none';
    document.body.classList.remove('has-launch-rail');
    return;
  }
  // The old #wiz-editing-banner was replaced by an inline indicator next
  // to the back link and a sticky launch rail at the bottom. Both
  // visibilities are mirrored on the active-draft state.
  const inline = document.getElementById('wiz-editing-inline');
  const rail = document.getElementById('wiz-launch-rail');
  const trigger = document.getElementById('wiz-launch-trigger');
  const controls = document.getElementById('wiz-launch-controls');
  const id = getActiveDraftId();
  // Bug 15: a launched campaign consumes the draft (clearActiveDraft in
  // startCampaign), so `id` goes null even though the operator is still in the
  // editor watching a live run. Keep the rail up when a campaign is running /
  // paused / monitoring, and swap its contents to campaign controls.
  const running = !!(typeof __cockpit !== 'undefined' && __cockpit &&
    (__cockpit.running || __cockpit.paused || __cockpit.state === 'monitoring'));
  if (!id && !running) {
    if (inline) inline.style.display = 'none';
    if (rail) rail.style.display = 'none';
    if (controls) controls.hidden = true;
    if (trigger) trigger.style.display = '';
    document.body.classList.remove('has-launch-rail');
    return;
  }
  if (rail) rail.style.display = 'flex';
  document.body.classList.add('has-launch-rail');

  if (running) {
    // Control-bar mode — hide the launch trigger + its menu, show Pause/Stop/
    // Save-as-draft. (The rail's fixed ancestor is display:none on the
    // dashboard route, so this never bleeds outside the editor.)
    if (inline) inline.style.display = 'none';
    if (trigger) trigger.style.display = 'none';
    _closeLaunchMenu();
    if (controls) controls.hidden = false;
    // Distinguish the post-send monitoring phase from active sending. During
    // monitoring campaign.running is false but state === 'monitoring' — the
    // bar must REPORT "Monitoring" (not the "Running campaign" fallback) and
    // drop the Pause button, which is gated on campaign.running server-side
    // and so does nothing while monitoring.
    const monitoring = !!(__cockpit && __cockpit.state === 'monitoring' && !__cockpit.running);
    if (controls) controls.classList.toggle('is-monitoring', monitoring);
    const modeVal = (__cockpit && __cockpit.mode) || document.getElementById('campaign-mode')?.value || '';
    const nm = (__cockpit && __cockpit.name) ||
      (document.getElementById('campaign-name-input')?.value || '').trim() || 'Running campaign';
    const cmEl = document.getElementById('wiz-controls-mode');
    const cnEl = document.getElementById('wiz-controls-name');
    if (cmEl) cmEl.textContent = modeVal ? dashboardModeLabel(modeVal) : 'Live';
    if (cnEl) cnEl.textContent = monitoring ? 'Monitoring' : nm;
    const pauseBtn = document.getElementById('wiz-ctrl-pause');
    if (pauseBtn) {
      // Pause is a no-op during monitoring (nothing is sending) — hide it.
      pauseBtn.hidden = monitoring;
      const paused = !!(__cockpit && __cockpit.paused);
      const pausing = !!(__cockpit && __cockpit.pauseRequested);
      pauseBtn.textContent = paused ? 'Resume' : (pausing ? 'Pausing…' : 'Pause');
      pauseBtn.disabled = pausing;
    }
    return;
  }

  // Draft (not running) — original launch-options behaviour.
  if (controls) controls.hidden = true;
  if (trigger) trigger.style.display = '';
  if (inline) inline.style.display = 'inline-flex';
  // Sync the display name from the canonical campaign-name-input.
  const nameInput = document.getElementById('campaign-name-input');
  const draftName = (nameInput?.value || '').trim() || 'Untitled draft';
  const nameEl = document.getElementById('wiz-editing-name');
  if (nameEl) nameEl.textContent = draftName;

  // Mirror name + mode onto the launch pill so the operator can see at a
  // glance what they're drafting. Mode falls back to "—" before selection.
  const modeEl = document.getElementById('campaign-mode');
  const modeVal = modeEl?.value || '';
  const modeLabel = modeVal ? dashboardModeLabel(modeVal) : 'No mode yet';
  const triggerName = document.getElementById('wiz-launch-trigger-name');
  const triggerMode = document.getElementById('wiz-launch-trigger-mode');
  const triggerMeta = document.getElementById('wiz-launch-trigger-meta');
  const triggerDivider = document.getElementById('wiz-launch-trigger-divider');
  if (triggerName) triggerName.textContent = draftName;
  if (triggerMode) triggerMode.textContent = modeLabel;
  if (triggerMeta) triggerMeta.hidden = false;
  if (triggerDivider) triggerDivider.hidden = false;

  updateSavePip();
};

/* ── Launch menu — open/close + click-outside dismiss ─────────────────── */
window.toggleLaunchMenu = function(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const trigger = document.getElementById('wiz-launch-trigger');
  const menu = document.getElementById('wiz-launch-menu');
  if (!trigger || !menu) return;
  const opening = !menu.classList.contains('show');
  menu.classList.toggle('show', opening);
  trigger.classList.toggle('is-open', opening);
  trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
  menu.setAttribute('aria-hidden', opening ? 'false' : 'true');
};
function _closeLaunchMenu() {
  const trigger = document.getElementById('wiz-launch-trigger');
  const menu = document.getElementById('wiz-launch-menu');
  if (menu) { menu.classList.remove('show'); menu.setAttribute('aria-hidden', 'true'); }
  if (trigger) { trigger.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); }
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.wiz-launch-wrap')) _closeLaunchMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') _closeLaunchMenu();
});

/* ── Launch menu options ──────────────────────────────────────────────── */

// Start a campaign — flush autosave, then POST queue-only (auto-drains when
// idle, queues behind a running campaign).
window.launchStartNow = async function() {
  _closeLaunchMenu();
  try { await flushAutosaveImmediate(); } catch (err) { console.warn('[drafts] flush before start:', err); }
  // Hit /api/campaign/start (NOT /queue-only) — that endpoint fires
  // immediately when idle, and only falls back to queueing if a campaign
  // is already running. Earlier wiring routed this to addToQueueCampaign,
  // which always queued regardless of idle state.
  if (typeof startCampaign === 'function') await startCampaign();
  if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
};

// Queue it — semantically distinct from Start: operator explicitly wants
// to wait. Same backend call (queue-only handles both). Distinct toast.
window.launchQueueIt = async function() {
  _closeLaunchMenu();
  try { await flushAutosaveImmediate(); } catch (err) { console.warn('[drafts] flush before queue:', err); }
  if (typeof addToQueueCampaign === 'function') await addToQueueCampaign();
  if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
};

// v2.61: Schedule modal — opens #schedule-modal and resolves to
// { name, cron } or null. Supports both one-shot (specific date+time) and
// recurring (weekly on selected days). No backend call here — caller is
// responsible for gathering the rest of the campaign config and POSTing
// to /api/schedules.
function openScheduleModal({ defaultName = '' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('schedule-modal');
    if (!modal) { resolve(null); return; }
    const nameInput = document.getElementById('schedule-modal-name');
    const dateInput = document.getElementById('schedule-modal-date');
    const timeInput = document.getElementById('schedule-modal-time');
    const dayInputs = Array.from(document.querySelectorAll('.schedule-modal-day'));
    const summaryEl = document.getElementById('schedule-modal-summary');
    const saveBtn = document.getElementById('schedule-modal-save');
    const cancelBtn = document.getElementById('schedule-modal-cancel');
    if (!nameInput || !dateInput || !timeInput || !summaryEl || !saveBtn || !cancelBtn) {
      resolve(null); return;
    }

    // Defaults — pre-fill name from campaign field if available, date = today,
    // time = next round hour after now.
    nameInput.value = defaultName || '';
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    dateInput.value = soon.toISOString().slice(0, 10);
    timeInput.value = `${String(soon.getHours()).padStart(2, '0')}:00`;
    dayInputs.forEach((d) => { d.checked = false; });

    const computeCron = () => {
      const time = timeInput.value || '09:00';
      const parts = time.split(':').map((n) => parseInt(n, 10));
      const h = parts[0]; const m = parts[1];
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      const days = dayInputs.filter((d) => d.checked).map((d) => d.value);
      if (days.length > 0) {
        const dayStr = days.length === 7 ? '*' : days.join(',');
        return { cron: `${m} ${h} * * ${dayStr}`, kind: 'weekly', days, time };
      }
      if (!dateInput.value) return null;
      const dParts = dateInput.value.split('-').map((n) => parseInt(n, 10));
      const mm = dParts[1]; const dd = dParts[2];
      return { cron: `${m} ${h} ${dd} ${mm} *`, kind: 'once', date: dateInput.value, time };
    };

    const DAY_LABELS = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
    const formatSummary = () => {
      const r = computeCron();
      if (!r) { summaryEl.textContent = '—'; return; }
      if (r.kind === 'weekly') {
        const labels = r.days.map((d) => DAY_LABELS[d]).join(' · ');
        summaryEl.textContent = `Every ${labels} at ${r.time}`;
      } else {
        const dt = new Date(`${r.date}T${r.time}`);
        const fmt = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        summaryEl.textContent = `Once on ${fmt} at ${r.time}`;
      }
    };
    formatSummary();
    const reactive = [dateInput, timeInput, ...dayInputs];
    reactive.forEach((el) => el.addEventListener('input', formatSummary));
    reactive.forEach((el) => el.addEventListener('change', formatSummary));

    modal.hidden = false;
    setTimeout(() => { try { nameInput.focus(); } catch (_) {} }, 0);

    const cleanup = () => {
      modal.hidden = true;
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      reactive.forEach((el) => {
        el.removeEventListener('input', formatSummary);
        el.removeEventListener('change', formatSummary);
      });
    };
    const onSave = () => {
      const r = computeCron();
      if (!r) {
        if (typeof showCampaignToast === 'function') {
          showCampaignToast('Pick a date+time (or at least one repeat day).');
        }
        return;
      }
      cleanup();
      const name = (nameInput.value || '').trim() || defaultName || 'Scheduled campaign';
      resolve({ name, cron: r.cron });
    };
    const onCancel = () => { cleanup(); resolve(null); };
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
  });
}
if (typeof window !== 'undefined') window.openScheduleModal = openScheduleModal;

// v2.61: Schedule it — opens the schedule modal, gathers the full campaign
// config (mirrors saveQuickSchedule), POSTs to /api/schedules. Fixes the
// previous launchScheduleIt bug where the POST omitted required fields
// (profileIds, sheetUrl) and server returned 400.
window.launchScheduleIt = async function () {
  _closeLaunchMenu();
  const nameInput = document.getElementById('campaign-name-input');
  const result = await openScheduleModal({ defaultName: (nameInput?.value || '').trim() });
  if (!result) return;

  // Validation mirrors saveQuickSchedule's prerequisites.
  if (!Array.isArray(selectedProfileIds) || selectedProfileIds.length === 0) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Select at least one GoLogin account first.');
    return;
  }
  const sheetUrl = (document.getElementById('sheet-url')?.value || '').trim();
  if (!sheetUrl) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Enter the Google Sheet URL first.');
    return;
  }
  const dailyLimit = parseInt(document.getElementById('daily-limit')?.value, 10) || 50;
  const mode = document.getElementById('campaign-mode')?.value || 'connect_only';

  // Mirror saveQuickSchedule's delay derivation (message_only uses message-gap,
  // others use within-batch-min/max).
  let delayMin; let delayMax;
  if (mode === 'message_only') {
    const gap = parseInt(document.getElementById('message-gap')?.value, 10) || 60;
    delayMin = Math.max(5, Math.round(gap * 0.8));
    delayMax = Math.max(delayMin + 5, Math.round(gap * 1.3));
  } else {
    delayMin = parseInt(document.getElementById('within-batch-min')?.value, 10) || 30;
    delayMax = parseInt(document.getElementById('within-batch-max')?.value, 10) || 60;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMin, delayMin + 5];
  }

  const templates = {
    connectionNote: document.getElementById('tpl-note')?.value || '',
    followUp1: document.getElementById('tpl-followup')?.value || '',
    inmailSubject: document.getElementById('tpl-inmail-subject')?.value || '',
    inmailBody: document.getElementById('tpl-inmail-body')?.value || '',
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
    opChannel: document.getElementById('tpl-op-channel')?.value || 'sn_first',
    opSpendInMail: !!document.getElementById('tpl-op-spend-inmail')?.checked,
  };

  try { await flushAutosaveImmediate(); } catch {}
  try {
    const r = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: result.name,
        cron: result.cron,
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
    if (r.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Scheduled!');
    } else {
      const body = await r.json().catch(() => ({}));
      if (typeof showCampaignToast === 'function') showCampaignToast(`Schedule failed: ${body.error || r.statusText}`);
    }
  } catch (err) {
    console.error('[drafts] schedule:', err);
    if (typeof showCampaignToast === 'function') showCampaignToast('Schedule failed');
  }
};

// Save as draft — autosave already persisted everything; this just closes
// the wizard and returns to the dashboard. The draft stays in the drafts
// list and the resume pill will surface it from the dashboard header.
window.launchSaveAsDraft = function() {
  _closeLaunchMenu();
  // No backend call — autosave has the data. Just navigate back.
  window.location.hash = '#/';
  if (typeof showCampaignToast === 'function') showCampaignToast('Saved as draft');
};

// Bug 15: "Save as draft" from the running-campaign control bar. The launch
// consumed the original draft (deleted server-side + activeDraftId cleared), so
// there's nothing to autosave into — spawn a fresh draft from the still-populated
// editor form so the operator can re-run / tweak it later. Does NOT stop the
// running campaign or navigate away.
window.railSaveAsDraft = async function() {
  try {
    const nameInput = document.getElementById('campaign-name-input');
    const name = (nameInput?.value || '').trim();
    const r = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const newId = data?.draft?.id || '';
    if (newId) {
      setActiveDraftId(newId);
      // Persist the current form (sheet URL, templates, cadence, profiles) into
      // the new draft via the existing autosave path.
      if (typeof flushAutosaveImmediate === 'function') await flushAutosaveImmediate();
    }
    if (typeof showCampaignToast === 'function') showCampaignToast('Saved as draft');
  } catch (err) {
    console.warn('[drafts] railSaveAsDraft failed:', err);
    if (typeof showCampaignToast === 'function') showCampaignToast('Could not save draft');
  }
};

// Delete the draft currently being edited. Confirms first, DELETEs the
// draft server-side, clears activeDraftId, and returns to the dashboard.
window.launchDeleteDraft = async function() {
  _closeLaunchMenu();
  const id = getActiveDraftId();
  if (!id) {
    window.location.hash = '#/';
    return;
  }
  const nameInput = document.getElementById('campaign-name-input');
  const name = (nameInput?.value || '').trim() || 'this draft';
  if (!confirm(`Delete draft "${name}"? This can't be undone.`)) return;
  try {
    await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (err) {
    console.warn('[drafts] delete from wizard:', err);
  }
  clearActiveDraft();
  window.location.hash = '#/';
  if (typeof showCampaignToast === 'function') showCampaignToast('Draft deleted');
};

// Keep the banner's name display in sync with live edits of the campaign
// name input. Wires once, idempotent across initWizardDirtyTracking
// invocations.
(function _wireEditingBannerNameSync() {
  function attach() {
    const input = document.getElementById('campaign-name-input');
    if (!input || input.__bannerNameWired) return;
    input.__bannerNameWired = true;
    input.addEventListener('input', () => {
      if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
    });
  }
  if (document.readyState !== 'loading') attach();
  document.addEventListener('DOMContentLoaded', attach);
})();

async function saveCampaignEdits() {
  const buttons = document.querySelectorAll('.wizard-save-edits');
  const originals = [];
  buttons.forEach((b, i) => { originals[i] = b.textContent; b.disabled = true; b.textContent = 'Saving…'; });
  try {
    // Special path: viewing the running campaign. Don't ever create a new
    // draft (the running campaign IS the source of truth). If dirty, warn
    // the operator to stop first; if clean, pretend to save so the button
    // still feels responsive.
    if (isViewingRunningCampaign()) {
      if (wizardDirty) {
        showCampaignToast('Stop the campaign first — edits won’t apply while it’s running.');
      } else {
        showCampaignToast('Edits saved');
      }
      return;
    }
    await saveDraftName();
    wizardDirty = false;
    _runningEditWarningShown = false;
    showCampaignToast('Edits saved');
  } catch (err) {
    showCampaignToast(`Save failed: ${err.message || err}`);
  } finally {
    buttons.forEach((b, i) => { b.disabled = false; b.textContent = originals[i] || 'Save Edits'; });
  }
}
window.saveCampaignEdits = saveCampaignEdits;

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

    // Persist to the new multi-draft store under the wizard's active
    // draft id (set by startNewCampaign or editDraft). If somehow there
    // isn't one (legacy state), spin one up so this Save sticks.
    let draftId = getActiveDraftId() || '';
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
        } else if (r.status === 409) {
          // v2.59: name collision with the running campaign.
          const data = await r.json().catch(() => ({}));
          throw new Error(data.message || 'A campaign with that name is already running.');
        }
      } catch (err) {
        if (err && /running/i.test(err.message || '')) throw err; // bubble 409
        // else fall through to legacy save
      }
    }
    if (!draftId) {
      try {
        const r = await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (r.status === 409) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.message || 'A campaign with that name is already running.');
        }
        if (r.ok) {
          const data = await r.json();
          setActiveDraftId(data?.draft?.id || '');
        }
      } catch (err) {
        if (err && /running/i.test(err.message || '')) throw err;
      }
    }
    // Keep legacy single-draft endpoint in sync so syncCampaignNameInput's
    // back-compat fallback still picks up the right name.
    const legacyRes = await fetch('/api/draft-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (legacyRes.status === 409) {
      const data = await legacyRes.json().catch(() => ({}));
      throw new Error(data.message || 'A campaign with that name is already running.');
    }
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

// Task 6: wire tab picker to sheet-url
(function () {
  function _wireTabPicker() {
    const el = document.getElementById('sheet-url');
    if (!el) return;
    el.addEventListener('input', _debounceTabPicker);
    el.addEventListener('blur', refreshSheetTabPicker);
    // If a URL is already pre-filled (config restore), trigger immediately
    if (el.value && el.value.includes('docs.google.com')) refreshSheetTabPicker();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireTabPicker);
  } else {
    _wireTabPicker();
  }
})();

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
// Dashboard tabbed layout (v2.51) — REMOVED in v2.60 dashboard v0.3.
// The 7-tab structure (#dash-tabs, .dash-panel, *-campaign-list, bulk
// strip, search, select-all, dashKeyHandler 1-7 shortcuts) was replaced
// by the v0.3 Active / Monitoring / Up Next / Calendar / Past renderers
// further down in this file. Helpers deleted here:
//   DASH_TABS, _dashActiveTab, _dashSelection, _dashSearch, DASH_PERSIST_KEY,
//   dashGetIdsByTab, dashUpdateCounts, dashShowPanel, dashSetTab,
//   dashApplySearch, dashRenderSelection, dashRenderSelectAll,
//   dashRenderBulkStrip, dashInitListeners, dashToggleSelectAll,
//   dashClearSelection, dashBulkPauseWatch, dashRefreshAll, dashInit,
//   dashBulkDelete, dashPerformBulkDelete, renderDashboardAll, dashKeyHandler.
// (The typeof-guarded callers in refresh*/post-action paths now no-op safely.)
// ──────────────────────────────────────────────────────────────────────

/* ============================================================
 * Dashboard v0.3 renderers + handlers
 * Targets DOM placeholders set up by the Phase 3 markup swap.
 * Driven by pollStatus() (active/monitoring, 2s) and the dashboard
 * poll timer (queue/calendar/past, 5s).
 * ============================================================ */

const V3_MODE_BADGE = {
  connect_only: 'CC',
  connect_and_introduce: 'C+I',
  connect_and_message: 'C+D',
  introduce_back: 'IB',
  message_only: 'DM',
  inmail_only: 'IM',
  check_status: 'CS',
  open_profile_only: 'OP',
  check_dms: 'CD',
  post_amplification: 'PA',
};

function v3ModeBadge(mode) {
  if (!mode) return '—';
  return V3_MODE_BADGE[mode] || String(mode).slice(0, 4).toUpperCase();
}

function v3SetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function v3FmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function v3FmtClock(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// v2.70.1: per-profile rows on the active card. Matches the chip set used by
// renderAccountQueue (#account-queue in the legacy Live Status section) but
// in a compact one-line-per-profile layout. Shows: name · status chip ·
// "X / Y today" (per-profile sent count from campaignCounts vs dailyLimit).
// Hidden when there's nothing to render (no campaign / no profile names).
function _activeProfileChip(name, status) {
  const findIn = (arr) => Array.isArray(arr)
    ? arr.find(x => x?.profileName === name || x?.pName === name || x?.name === name || x?.account === name) || null
    : null;
  const parkedHit = findIn(status.parked || status.parkedProfiles);
  const warningHit = findIn(status.softWarnings);
  const endHit = findIn(status.profileEndReasons);
  const isActive = status.currentProfile && name === status.currentProfile;
  if (isActive) return { label: 'Sending', cls: 'is-sending' };
  if (parkedHit) {
    const r = parkedHit.reason;
    if (r === 'session_expired')  return { label: 'Needs login',         cls: 'is-warn' };
    if (r === 'weekly_limit_429') return { label: 'LinkedIn cap·invites', cls: 'is-warn' };
    if (r === 'consecutive_skips') return { label: 'Parked·skips',       cls: 'is-warn' };
    return { label: 'Parked', cls: 'is-warn' };
  }
  if (warningHit) {
    if (warningHit.kind === 'weekly_limit') return { label: 'LinkedIn cap·invites', cls: 'is-warn' };
    if (warningHit.kind === 'rate_limited') return { label: 'Rate limited', cls: 'is-warn' };
    return { label: 'Action needed', cls: 'is-warn' };
  }
  if (endHit) {
    const r = String(endHit.reason || '');
    if (/InMail/i.test(r))          return { label: 'LinkedIn cap·InMail', cls: 'is-warn' };
    if (/weekly|429/i.test(r))      return { label: 'LinkedIn cap·invites', cls: 'is-warn' };
    if (/session expired/i.test(r)) return { label: 'Needs login', cls: 'is-warn' };
    return { label: 'Batch done', cls: 'is-done' };
  }
  return { label: 'Queued', cls: 'is-idle' };
}

// v2.78: bench/un-bench an account in the live rotation. checked = active (in
// rotation); we send skip = !checked. The next status poll re-renders state.
async function toggleProfileSkip(id, checked, event) {
  if (event) event.stopPropagation();
  try {
    await fetch('/api/campaign/profile-skip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: id, skip: !checked }),
    });
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(checked ? 'Account back in the rotation.' : 'Account benched for this run.', 3000);
    }
  } catch (e) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Could not change account: ' + e.message, 4000);
  }
}
window.toggleProfileSkip = toggleProfileSkip;

function renderPrimaryPanel(status) {
  const el = document.getElementById('primary-panel');
  if (!el) return;
  const conn = status && status.primaryConn ? status.primaryConn : null;
  const names = Array.isArray(status?.profileNames) ? status.profileNames : [];
  const ids   = Array.isArray(status?.profileIds)   ? status.profileIds   : [];
  if (!conn || !names.length || !Object.keys(conn).length) { el.hidden = true; el.innerHTML = ''; return; }
  const src = status.primaryConnSource || {};
  const pName = status.primaryName || 'the primary';
  const initials = pName.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || 'P';
  const STATE = {
    connected: { cls: 's-connected', st: 'Connected' },
    pending:   { cls: 's-pending',   st: 'Pending' },
    accepting: { cls: 's-checking',  st: 'Checking' },
    sent:      { cls: 's-pending',   st: 'Pending' },
    unverified:{ cls: 's-unverified',st: 'Primary?' },
    no_url:    { cls: 's-unverified',st: '—' },
  };
  const rows = names.map((name, i) => {
    const id = ids[i] || '';
    const state = (id && conn[id]) || 'unverified';
    const s = STATE[state] || STATE.unverified;
    const remembered = src[id] === 'remembered';
    const meta = remembered ? 'remembered · from store'
      : state === 'pending' || state === 'sent' ? 'connect request sent · awaiting accept'
      : state === 'unverified' ? 'degree unread · re-checks next turn'
      : 'verified live';
    return `<div class="v3-item ${s.cls}"><span class="led"></span>` +
      `<span><span class="nm" title="${escHtml(name)}">${escHtml(name)}</span>` +
      `<span class="meta">${escHtml(meta)}</span></span>` +
      `<span class="st">${escHtml(s.st)}${remembered ? ' <span class=\"remember\">remembered</span>' : ''}</span></div>`;
  }).join('');
  const timing = status.primaryCheckTiming === 'after_connections' ? 'After connections' : 'Immediately';
  const timingChip = status.primaryCheckTiming
    ? `<div class="mode">Timing · ${escHtml(timing)}</div>`
    : '';
  el.innerHTML =
    `<div class="v3-head"><div class="v3-ava">${escHtml(initials)}</div>` +
    `<div class="who"><span class="lbl">Primary person</span>${escHtml(pName)}</div>${timingChip}</div>` +
    rows;
  el.hidden = false;
}

function renderActiveProfiles(status) {
  const el = document.getElementById('active-profiles');
  if (!el) return;
  const names = Array.isArray(status?.profileNames) ? status.profileNames : [];
  const ids   = Array.isArray(status?.profileIds)   ? status.profileIds   : [];
  if (!names.length) { el.hidden = true; el.innerHTML = ''; return; }
  const counts = status.campaignCounts || {};
  const cap    = Number(status.dailyLimit) || 0;
  const skippedList = Array.isArray(status.skippedProfiles) ? status.skippedProfiles : [];
  const rows = names.map((name, i) => {
    const id = ids[i] || '';
    const chip = _activeProfileChip(name, status);
    const sent = id ? (Number(counts[id]) || 0) : 0;
    const todayCell = cap > 0 ? `${sent}/${cap} today` : `${sent} today`;
    // v2.78: skip toggle. "Active" (checked) = in the rotation. An account is
    // off when manually skipped OR auto-parked/capped (is-warn). Flipping a
    // parked account on retries it; flipping an active one off benches it.
    const isSkipped = !!(id && skippedList.includes(id));
    const isWarn = chip.cls === 'is-warn';
    const active = !isSkipped && !isWarn;
    const toggleTitle = active
      ? 'In rotation — turn off to skip this account for the rest of the run'
      : (isWarn ? 'Parked — turn on to retry this account' : 'Skipped — turn on to put it back in the rotation');
    const toggle = id ? `<label class="prof-skip-toggle" title="${escHtml(toggleTitle)}">
          <input type="checkbox" ${active ? 'checked' : ''} onchange="toggleProfileSkip('${escHtml(id)}', this.checked, event)" />
          <span class="prof-skip-slider"></span>
        </label>` : '<span></span>';
    // v2.78: open the account's browser to fix issues (e.g. "needs login").
    const openBtn = id
      ? `<button type="button" class="prof-open-btn" title="Open this account's browser to log in / fix issues" onclick="event.stopPropagation(); openProfileBrowser('${escHtml(id)}')">Open</button>`
      : '<span></span>';
    // v2.78: CC+IC connection-to-primary label.
    const pc = (status.primaryConn && id) ? status.primaryConn[id] : null;
    const primaryTag = pc === 'connected'
      ? '<span class="prof-primary-tag is-yes" title="Connected to the primary person (1st-degree)">Primary ✓</span>'
      : pc === 'pending'
        ? '<span class="prof-primary-tag is-no" title="Not connected to the primary — a connect request was sent; this account’s intros are held until it’s accepted">No primary</span>'
        : pc === 'unverified'
          ? '<span class="prof-primary-tag is-unknown" title="Couldn’t read the connection degree to the primary (rate-limit or slow page). No connect was sent and introductions still proceed — this re-checks next turn.">Primary?</span>'
          : '<span></span>';
    return `
      <div class="vj-prof-row ${chip.cls}${isSkipped ? ' is-skipped' : ''}">
        <span class="vj-prof-name" title="${escHtml(name)}">${escHtml(name)}</span>
        ${primaryTag}
        <span class="vj-prof-chip">${escHtml(isSkipped ? 'Skipped' : chip.label)}</span>
        <span class="vj-prof-today">${escHtml(todayCell)}</span>
        ${openBtn}
        ${toggle}
      </div>
    `;
  }).join('');
  el.innerHTML = rows;
  renderPrimaryPanel(status);
  el.hidden = false;
}

window.renderActiveCard = function(status) {
  const card = document.getElementById('active-card');
  if (!card) return;
  // A campaign in the monitoring phase has running:false but is NOT idle —
  // it's watching for acceptances. The card must render it, not fall through
  // to "No campaign running" (the dashboard's half of the CC+IC/CC+DM
  // monitoring story; the cockpit ring already handled this state).
  const isMonitoring = !!(status && !status.running && status.state === 'monitoring');
  // v2.72: a campaign that ran this session and has now ended (completed,
  // stopped, or errored) — keep the log + details visible so the operator can
  // review what happened, instead of wiping straight to "No campaign running".
  // Detected by: not running, not monitoring, but logs exist from this session.
  const isFinished = !!(status && !status.running && !isMonitoring
    && Array.isArray(status.logs) && status.logs.length > 0);
  if (isFinished) {
    card.classList.remove('is-empty', 'is-monitor');
    const total = Number(status.totalTargets) || 0;
    const done = Number(status.totalProcessed) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    v3SetText('activeName', status.name || '(unnamed)');
    v3SetText('activeEyebrow', 'Finished');
    v3SetText('activePct', String(pct));
    v3SetText('activeSent', String(done));
    v3SetText('activeTotal', String(total));
    v3SetText('activeAccounts', String((status.profileIds || []).length));
    v3SetText('activeAccepted', String(status.acceptedCount ?? '—'));
    v3SetText('sendingLbl', 'Finished');
    v3SetText('batchEta', '—');
    const glyph = document.getElementById('activeGlyph');
    if (glyph) glyph.textContent = (typeof v3ModeBadge === 'function') ? v3ModeBadge(status.mode) : '';
    const bar = card.querySelector('.vj-hbar > i');
    if (bar) bar.style.width = pct + '%';
    const liveEl = document.getElementById('active-live');
    if (liveEl) liveEl.hidden = true;
    const profEl = document.getElementById('active-profiles');
    if (profEl) { profEl.hidden = true; profEl.innerHTML = ''; }
    try { applyCheckSectionMode(status.mode); } catch (_) { /* section relabel best-effort */ }
    // Keep the live log on screen + the details panel open.
    _setActiveDetails(true);
    const logEl = document.getElementById('active-log');
    if (logEl && Array.isArray(status.logs)) {
      const lastN = status.logs.slice(-100);
      logEl.innerHTML = lastN.map(line => v3RenderLogLine(line)).join('');
      const head = card.querySelector('.vj-log-head .vj-details-head');
      if (head) head.textContent = `Live log · ${lastN.length} events (finished)`;
      const moreBtn = document.getElementById('wiz-log-more');
      if (moreBtn) moreBtn.hidden = true;
    }
    window.__activeFullLogs = Array.isArray(status.logs) ? status.logs.slice() : [];
    // Reset the auto-open latch so the NEXT launch re-opens the panel cleanly.
    window.__activeCardActive = false;
    return;
  }
  if (!status || (!status.running && !isMonitoring)) {
    card.classList.add('is-empty');
    card.classList.remove('is-monitor');
    v3SetText('activeName', 'No campaign running');
    v3SetText('activeEyebrow', 'No campaign running');
    v3SetText('activePct', '0');
    v3SetText('activeSent', '0');
    v3SetText('activeTotal', '0');
    v3SetText('activeAccounts', '0');
    v3SetText('activeAccepted', '—');
    v3SetText('sendingLbl', 'Idle');
    v3SetText('batchEta', '—');
    const glyph = document.getElementById('activeGlyph');
    if (glyph) glyph.textContent = '';
    const bar = card.querySelector('.vj-hbar > i');
    if (bar) bar.style.width = '0%';
    const logEl = document.getElementById('active-log');
    if (logEl) logEl.innerHTML = '';
    // Bug 14: campaign is fully stopped/idle — collapse the live log and reset
    // the "was active" latch so the NEXT launch auto-opens it again.
    _setActiveDetails(false);
    window.__activeCardActive = false;
    const liveEl0 = document.getElementById('active-live');
    if (liveEl0) liveEl0.hidden = true;
    const profEl0 = document.getElementById('active-profiles');
    if (profEl0) { profEl0.hidden = true; profEl0.innerHTML = ''; }
    return;
  }
  card.classList.remove('is-empty');
  card.classList.toggle('is-monitor', isMonitoring);
  // v2.105: pre-flight primary handshake state (gold). Mirrors is-monitor.
  const _isPreflight = status.phase === 'preflight';
  card.classList.toggle('is-preflight', _isPreflight);
  const _pfList = document.getElementById('active-preflight-list');
  if (_pfList) {
    if (_isPreflight) {
      const ICONS = { connected: '✓', accepting: '↻', sent: '•', already_connected: '–', unverified: '•', pending: '•', no_url: '–' };
      const LABEL = { connected: 'accepted by primary', accepting: 'accepting…', sent: 'request sent — waiting', already_connected: 'already connected', unverified: 'could not verify', pending: 'request sent — waiting', no_url: 'no primary URL' };
      const conn = status.primaryConn || {};
      const names = status.profileNames || [];
      const ids = status.profileIds || [];
      const rows = ids.filter((id) => id && id !== 'local-browser' && conn[id]).map((id) => {
        const st = conn[id];
        const nm = names[ids.indexOf(id)] || id;
        const cls = st === 'connected' ? 'pf-done' : st === 'accepting' ? 'pf-active' : (st === 'already_connected' || st === 'no_url') ? 'pf-skip' : 'pf-wait';
        return `<div class="pf-row ${cls}"><span class="pf-ic">${ICONS[st] || '•'}</span><span class="pf-acct">${escHtml(nm)}</span><span class="pf-state">${LABEL[st] || ''}</span></div>`;
      }).join('');
      _pfList.innerHTML = rows;
      _pfList.hidden = !rows;
    } else {
      _pfList.hidden = true;
      _pfList.innerHTML = '';
    }
  }
  try { applyCheckSectionMode(status.mode); } catch (_) { /* section relabel best-effort */ }
  // v2.59.19: live activity line — what the campaign is doing right now.
  try {
    const la = buildLiveActivity(status);
    const liveEl = document.getElementById('active-live');
    if (liveEl) {
      liveEl.hidden = (la.state === 'idle');
      liveEl.classList.toggle('is-checking', la.state === 'checking');
      liveEl.classList.toggle('is-paused', la.state === 'paused');
      v3SetText('activeLiveIco', la.icon);
      v3SetText('activeLiveL1', la.l1);
      v3SetText('activeLiveL2', la.l2);
    }
  } catch (_) { /* live line is best-effort */ }
  // Bug 14: once a campaign is launched, keep the live log visible through the
  // whole running → monitoring lifecycle. Auto-open the details panel on the
  // transition INTO active/monitoring (not every poll, so a manual collapse via
  // the chevron still sticks). It only re-collapses on a FULL stop (the empty
  // branch above), matching "stays on until you stop it completely".
  if (!window.__activeCardActive) {
    _setActiveDetails(true);
    window.__activeCardActive = true;
  }
  if (isMonitoring && typeof v3RenderMonitorHero === 'function') v3RenderMonitorHero(status);
  const total = Number(status.totalTargets) || 0;
  const done = Number(status.totalProcessed) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  v3SetText('activeName', status.name || '(unnamed)');
  v3SetText('activeEyebrow', isMonitoring ? 'Monitoring' : (status._paused || status.paused ? 'Paused' : 'Running'));
  v3SetText('activePct', String(pct));
  v3SetText('activeSent', String(done));
  v3SetText('activeTotal', String(total));
  v3SetText('activeAccounts', String(((isMonitoring ? status.participatingProfileIds : status.profileIds) || status.profileIds || []).length));
  v3SetText('activeAccepted', String(status.acceptedCount ?? '—'));
  try { renderActiveProfiles(status); } catch (err) { console.warn('[active-profiles] render failed:', err.message); }
  const isPaused = !!(status._paused || status.paused);
  v3SetText('sendingLbl', isMonitoring
    ? (status.monitoringCheckInProgress ? 'Checking now…' : 'Monitoring')
    : (isPaused ? 'Paused' : (status.pauseRequested ? 'Pausing…' : 'Sending')));
  const glyph = document.getElementById('activeGlyph');
  if (glyph) glyph.textContent = v3ModeBadge(status.mode);
  const bar = card.querySelector('.vj-hbar > i');
  if (bar) bar.style.width = pct + '%';
  // Pause button icon swap based on paused state
  const pauseBtn = document.getElementById('dock-active-pause');
  if (pauseBtn) {
    pauseBtn.innerHTML = isPaused
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,4 20,12 7,20"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    pauseBtn.setAttribute('data-tip', isPaused ? 'Resume' : 'Pause');
    pauseBtn.setAttribute('aria-label', isPaused ? 'Resume' : 'Pause');
  }
  // Live log lines — 6 on the compact dashboard card, 15 when the card is
  // relocated into the wizard Live Status (v2.59.22: more real estate there).
  const logEl = document.getElementById('active-log');
  if (logEl && Array.isArray(status.logs)) {
    const inWizard = card.classList.contains('in-wizard');
    const expanded = !!window.__wizLogExpanded;
    const defaultN = inWizard ? 15 : 6;
    const limit = expanded ? 100 : defaultN;
    const lastN = status.logs.slice(-limit);
    logEl.innerHTML = lastN.map(line => v3RenderLogLine(line)).join('');
    const head = card.querySelector('.vj-log-head .vj-details-head');
    if (head) head.textContent = `Live log · last ${lastN.length} events`;
    const moreBtn = document.getElementById('wiz-log-more');
    if (moreBtn) {
      // Show the toggle whenever there's more to reveal (or we're expanded).
      moreBtn.hidden = !(expanded || status.logs.length > defaultN);
      moreBtn.textContent = expanded ? 'Show less' : 'Show more';
    }
    card.classList.toggle('is-log-expanded', expanded);
  }
  // Stash the FULL log (not just the 6 rendered) so the "Copy all" button can
  // copy everything the campaign has emitted (in-memory log, capped ~500).
  window.__activeFullLogs = Array.isArray(status.logs) ? status.logs.slice() : [];
  // Batch ETA — best-effort from nextCheckAt or currentAction.endsAt
  const etaEl = document.getElementById('batchEta');
  if (etaEl) {
    let etaText = '—';
    if (status.nextCheckAt) {
      const ms = new Date(status.nextCheckAt).getTime() - Date.now();
      etaText = v3FmtMs(ms);
    } else if (status.currentAction?.endsAt) {
      const ms = new Date(status.currentAction.endsAt).getTime() - Date.now();
      etaText = v3FmtMs(ms);
    }
    etaEl.textContent = etaText;
  }
};

// Variant E monitoring hero: big live countdown to the next acceptance check
// + one quiet stat line. Driven by the same 2s pollStatus tick as the rest of
// the card. All values come straight from /api/campaign/status.
function v3FmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// v2.59.19: the dashboard monitoring card only re-renders on the 5s dashboard
// poll, so the "until next check" countdown stepped in 5-second jumps. Cache
// the latest nextCheckAt and tick the *display* once a second (no re-fetch —
// nextCheckAt only changes every cadence interval) so it counts down smoothly.
let _monHeroNextCheckAt = null;
let _fuHeroDueAt = null; // v2.111: cached follow-up batch dueAt for the 1s tick
function v3RenderMonitorHero(status) {
  const countEl = document.getElementById('monCount');
  const capEl = document.querySelector('#active-monitor .vj-mon-cap');
  const heroEl = document.querySelector('#active-monitor .vj-mon-hero');
  _monHeroNextCheckAt = status.nextCheckAt || null;
  if (countEl) {
    // Bug 12: while a connection check is actually running, replace the
    // "12:00 / until next check" countdown with a pulsing "CHECKING / NOW" in
    // the same hero slot, instead of a confusing "now / until next check".
    if (status.monitoringCheckInProgress) {
      countEl.textContent = 'CHECKING';
      if (capEl) capEl.textContent = 'now';
      if (heroEl) heroEl.classList.add('is-checking');
    } else {
      const txt = status.nextCheckAt
        ? v3FmtCountdown(new Date(status.nextCheckAt).getTime() - Date.now())
        : '—';
      countEl.textContent = txt;
      if (capEl) capEl.textContent = 'until next check';
      if (heroEl) heroEl.classList.remove('is-checking');
    }
  }
  const lineEl = document.getElementById('monLine');
  if (lineEl) {
    const sent = Number(status.totalProcessed) || 0;
    const accepted = status.acceptedCount ?? '—';
    const cadMin = Number(status.checkIntervalMinutes) || 60;
    const cad = cadMin >= 60 ? (cadMin / 60) + 'h' : cadMin + ' min';
    let ends = '—';
    if (status.monitoringUntil) {
      ends = new Date(status.monitoringUntil).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    }
    // Bug 10: "replies" removed from the dashboard.
    lineEl.innerHTML =
      `<b>${sent}</b> sent · <b>${accepted}</b> accepted · checks every <b>${cad}</b> · ends <b>${ends}</b>`;
  }
  // v2.111: follow-up batch countdown.
  const fu = status.followUp;
  const fuHero = document.getElementById('active-fu-hero');
  if (fuHero) {
    if (fu && fu.count > 0) {
      _fuHeroDueAt = fu.dueAt || null;
      const q = document.getElementById('fuQueued');
      const s = document.getElementById('fuSender');
      const c = document.getElementById('fuCount');
      if (q) q.textContent = String(fu.count);
      if (s) s.textContent = (fu.sender && fu.sender !== 'local-browser') ? 'the primary' : 'you';
      if (c) { const ms = (fu.dueAt || 0) - Date.now(); c.textContent = ms <= 0 ? 'Sending…' : v3FmtCountdown(ms); }
      fuHero.hidden = false;
    } else {
      _fuHeroDueAt = null;
      fuHero.hidden = true;
    }
  }
}

// v2.59.19: smooth 1s display tick for the monitoring countdown. Only touches
// the monCount text, only while the active card is in monitor mode and NOT
// mid-check (CHECKING stays put). Recomputes from the cached nextCheckAt — no
// network — so the number ticks every second instead of jumping every 5s.
function _tickMonHeroCountdown() {
  const card = document.getElementById('active-card');
  if (!card || !card.classList.contains('is-monitor')) return;
  if (!_monHeroNextCheckAt) return;
  const heroEl = document.querySelector('#active-monitor .vj-mon-hero');
  if (heroEl && heroEl.classList.contains('is-checking')) return; // leave "CHECKING"
  const countEl = document.getElementById('monCount');
  if (countEl) {
    countEl.textContent = v3FmtCountdown(new Date(_monHeroNextCheckAt).getTime() - Date.now());
  }
  if (_fuHeroDueAt) {
    const fuEl = document.getElementById('fuCount');
    if (fuEl) { const ms = _fuHeroDueAt - Date.now(); fuEl.textContent = ms <= 0 ? 'Sending…' : v3FmtCountdown(ms); }
  }
}
setInterval(_tickMonHeroCountdown, 1000);

function v3RenderLogLine(rawLine) {
  const safe = (typeof escHtml === 'function') ? escHtml : (s) =>
    String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (!rawLine) return '';
  // campaign.logs format: "[ISO timestamp] message" OR "HH:MM:SS [event] msg"
  // Best-effort parse to extract a short time + event class.
  let timeStr = '';
  let evtStr = 'log';
  let restStr = String(rawLine);
  const isoMatch = restStr.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (isoMatch) {
    const t = new Date(isoMatch[1]);
    if (!Number.isNaN(t.getTime())) {
      timeStr = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    }
    restStr = isoMatch[2];
  }
  let cls = '';
  if (/✓|connection_sent|message_sent|status_accepted|accepted/i.test(restStr)) { cls = 'is-ok'; evtStr = 'ok'; }
  else if (/✗|error|fail|FAILED|429/i.test(restStr)) { cls = 'is-err'; evtStr = 'err'; }
  else if (/⚠|warn|retry|backoff|park|SKIPPED/i.test(restStr)) { cls = 'is-warn'; evtStr = 'warn'; }
  else if (/===|▶|■|start|finished/i.test(restStr)) { evtStr = 'info'; }
  return `<div class="vj-log-line ${cls}"><span class="time">${safe(timeStr)}</span><span class="evt">${safe(evtStr)}</span><span class="what">${safe(restStr)}</span></div>`;
}

// Single setter for the active card's details panel (live log + bulk check) so
// the manual chevron AND the auto-expand-on-monitoring (bug 14) stay in sync —
// class, chevron rotation, and tooltip all move together.
function _setActiveDetails(open) {
  const card = document.getElementById('active-card');
  if (!card) return;
  card.classList.toggle('is-detailed', open);
  const btn = card.querySelector('.vj-toggle-btn');
  const svg = btn && btn.querySelector('svg');
  if (svg) svg.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
  if (btn) btn.setAttribute('data-tip', open ? 'Hide details' : 'Show details');
}

window.toggleActiveDetails = function(btn) {
  const card = document.getElementById('active-card');
  if (!card) return;
  _setActiveDetails(!card.classList.contains('is-detailed'));
};

// "[ISO] message" → "HH:MM:SS  message" for a clean clipboard paste.
function _logLineToPlain(raw) {
  const s = String(raw == null ? '' : raw);
  const m = s.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m) {
    const t = new Date(m[1]);
    if (!Number.isNaN(t.getTime())) {
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}  ${m[2]}`;
    }
    return m[2];
  }
  return s;
}

// Copy the FULL live log (all events, not just the 6 shown) to the clipboard.
window.dashCopyLog = async function(btn) {
  const lines = Array.isArray(window.__activeFullLogs) ? window.__activeFullLogs : [];
  const text = lines.map(_logLineToPlain).join('\n');
  const flash = (label) => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  };
  try {
    await navigator.clipboard.writeText(text);
    flash(lines.length ? 'Copied ✓' : 'Log empty');
  } catch (_) {
    flash('Copy failed');
  }
};

// v2.112: resume-with-live-state client. Renders ONLY from the server's resumeChanges
// object — never computes counts locally (no invented data).
async function reloadSheetWhilePaused() {
  const r = await fetch('/api/campaign/resume/reload-sheet', { method: 'POST' })
    .then(x => x.json()).catch(() => null);
  if (!r || !r.ok) { showCampaignToast(`Reload failed: ${r?.error || 'unknown'}`, 4000); return; }
  showCampaignToast(`Sheet reloaded — review on Resume.`, 2500);
}

function renderResumeReview(rc) {
  const groups = [];
  if (rc.sheet && (rc.sheet.addedCount || rc.sheet.updatedCount || rc.sheet.skippedNew)) {
    let lines = '';
    if (rc.sheet.addedCount || rc.sheet.updatedCount) {
      lines += `<div class="rr-line">+${rc.sheet.addedCount} new lead(s) · ${rc.sheet.updatedCount} updated · ${rc.sheet.newTotal} total</div>`;
    }
    if (rc.sheet.skippedNew) {
      lines += `<div class="rr-line rr-warn">${rc.sheet.skippedNew} new lead(s) found — restart the campaign to include them in this mode.</div>`;
    }
    groups.push(`<div class="rr-group"><div class="rr-label">Sheet</div>${lines}
      <div class="rr-sub">Already-sent leads untouched.</div></div>`);
  }
  const a = rc.accounts || {};
  if ((a.added||[]).length || (a.benched||[]).length || (a.reEnabled||[]).length) {
    const parts = [];
    (a.added||[]).forEach(x => parts.push(`<div class="rr-line">＋ Added ${escapeHtml(x.name)}</div>`));
    (a.benched||[]).forEach(x => parts.push(`<div class="rr-line">⏸ Benched ${escapeHtml(x.name)}</div>`));
    (a.reEnabled||[]).forEach(x => parts.push(`<div class="rr-line">▶ Re-enabled ${escapeHtml(x.name)}</div>`));
    groups.push(`<div class="rr-group"><div class="rr-label">Accounts</div>${parts.join('')}</div>`);
  }
  if ((rc.settings||[]).length) {
    const parts = (rc.settings).map(s => s.changed
      ? `<div class="rr-line">${escapeHtml(s.label)} changed</div>`
      : `<div class="rr-line">${escapeHtml(s.label)} ${escapeHtml(String(s.from))} → ${escapeHtml(String(s.to))}</div>`);
    groups.push(`<div class="rr-group"><div class="rr-label">Settings</div>${parts.join('')}</div>`);
  }
  document.getElementById('resume-review-body').innerHTML = groups.join('') || '<div class="rr-line">No changes.</div>';
}

// Shared confirm path: applies any staged edits, gives the operator feedback, and refreshes
// the card so it leaves the "paused" state immediately (not on the next poll cycle).
async function confirmResume() {
  await fetch('/api/campaign/resume/confirm', { method: 'POST' });
  if (typeof showCampaignToast === 'function') showCampaignToast('Resuming…');
  if (typeof pollStatus === 'function') pollStatus();
}

async function onResumeClicked() {
  const pre = await fetch('/api/campaign/resume/preview').then(x => x.json()).catch(() => null);
  if (!pre || !pre.ok || pre.resumeChanges.isEmpty) {
    // Nothing staged (or preview unavailable) → resume straight away. confirm still applies
    // any staged edits server-side, so this never silently drops changes.
    await confirmResume();
    return;
  }
  renderResumeReview(pre.resumeChanges);
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = false; panel.style.display = 'flex'; // .cockpit-panel is flex; match #pause-edit-panel
}

document.getElementById('resume-keep-editing')?.addEventListener('click', () => {
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = true; panel.style.display = 'none';
});
document.getElementById('resume-confirm')?.addEventListener('click', async () => {
  await confirmResume();
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = true; panel.style.display = 'none';
});
window.reloadSheetWhilePaused = reloadSheetWhilePaused;

// v2.112 (#2b): per-account staged intent — keyed by profileId, value is boolean (true=benched).
// Reset each time the editor renders so a fresh pause starts from current server state.
let _pausedAcctIntent = {};

// v2.112 (#2b): stage account add/swap/bench for the resume review (NOT applied until Confirm).
async function stageAccountChange({ bench, add } = {}) {
  const body = {}; if (bench) body.bench = bench; if (add) body.add = add;
  const r = await fetch('/api/campaign/resume/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(x => x.json()).catch(() => null);
  if (!r || !r.ok) { showCampaignToast((r && r.error) || 'account change rejected', 4000); return false; }
  showCampaignToast('Staged — review on Resume.', 2000);
  return true;
}
function stageBench(id, skip) { return stageAccountChange({ bench: { [id]: skip } }); }
function stageAddAccount(id) { return stageAccountChange({ add: [{ id }] }); }
function stageSwap(oldId, newId) { return stageAccountChange({ bench: { [oldId]: true }, add: [{ id: newId }] }); }
window.stageBench = stageBench; window.stageAddAccount = stageAddAccount; window.stageSwap = stageSwap;

// v2.112 (#2b): Fetch available GoLogin profiles, excluding those already in the run,
// and render the ＋ Add account control inside the pause-edit-panel.
async function renderPauseAccountAdd() {
  const container = document.getElementById('acct-add-section');
  if (!container) return;
  if (!__cockpit || __cockpit.paused !== true) { container.hidden = true; container.style.display = 'none'; return; }
  container.hidden = false; container.style.display = 'flex';

  // Fetch all profiles (same endpoint the wizard account picker uses).
  const data = await fetch('/api/profiles').then(x => x.json()).catch(() => null);
  const allProfiles = (data && Array.isArray(data.profiles) ? data.profiles : (Array.isArray(data) ? data : []));

  // Exclude accounts already in the running campaign.
  const runIds = new Set(__cockpit.profileIds || []);
  const available = allProfiles.filter(p => !runIds.has(p.id));

  // --- Step 2: Per-account rows (bench toggle + Swap) ---
  // Reset intent map from current server state so a fresh pause starts correctly.
  const benchedNow = new Set(__cockpit.skippedProfiles || []);
  _pausedAcctIntent = {};
  const runProfileIds = __cockpit.profileIds || [];
  const runProfileNames = __cockpit.profileNames || [];
  runProfileIds.forEach((id, i) => {
    _pausedAcctIntent[id] = benchedNow.has(id);
  });

  // Build swap <select> options from available list (profiles not already in the run).
  const swapOptions = available.length > 0
    ? available.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')
    : '';

  const rowsHtml = runProfileIds.map((id, i) => {
    const name = escapeHtml(runProfileNames[i] || id);
    const safeId = escapeHtml(id);
    const isBenched = _pausedAcctIntent[id];
    const benchLabel = isBenched ? 'Benched' : 'Active';
    const benchClass = isBenched ? 'btn btn-secondary btn-sm is-benched' : 'btn btn-secondary btn-sm';
    const swapSelectId = `acct-swap-sel-${i}`;
    const swapToggleId = `acct-swap-toggle-${i}`;
    const swapBlockId = `acct-swap-block-${i}`;
    const swapHtml = available.length > 0
      ? `<span class="acct-swap-wrap" id="${escapeHtml(swapBlockId)}" style="display:none">
           <select id="${escapeHtml(swapSelectId)}" class="intro-config-select" style="max-width:130px">${swapOptions}</select>
           <button type="button" class="btn btn-start btn-sm" onclick="window._doSwapAccount(${i})">Swap</button>
         </span>
         <button type="button" class="btn btn-secondary btn-sm" id="${escapeHtml(swapToggleId)}" onclick="window._toggleSwapRow(${i})">Swap…</button>`
      : '';
    return `<div class="acct-edit-row" id="acct-edit-row-${i}" data-acct-id="${safeId}">
      <span class="acct-edit-name">${name}</span>
      <span class="acct-edit-actions" style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        ${swapHtml}
        <button type="button" class="${benchClass}" id="acct-bench-btn-${i}" onclick="window._toggleBenchIntent(${i})">${benchLabel}</button>
      </span>
    </div>`;
  }).join('');

  // --- ＋ Add account control (existing, below per-account rows) ---
  let addHtml;
  if (available.length === 0) {
    addHtml = `<div class="acct-edit-add"><span style="color:var(--gray,#8a8a8a);font-size:12px">No additional accounts available to add.</span></div>`;
  } else {
    const options = available.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('');
    addHtml = `
      <div class="acct-edit-add">
        <label class="intro-config-label" style="display:block;margin-bottom:6px">＋ Add account</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="acct-add-select" class="intro-config-select" style="flex:1;min-width:0">${options}</select>
          <button type="button" class="btn btn-secondary btn-sm" onclick="window._doAddAccount()">Add</button>
        </div>
      </div>`;
  }

  const sectionLabel = runProfileIds.length > 0
    ? `<div class="rr-label" style="margin-bottom:2px">Current accounts</div>`
    : '';

  container.innerHTML = sectionLabel + rowsHtml + addHtml;

  // --- inline onclick handlers ---

  // Bench toggle: flip intended state, update button, stage via stageBench.
  // id is resolved from the row's data-acct-id (never embedded as a JS string literal).
  window._toggleBenchIntent = async function(idx) {
    const id = document.getElementById(`acct-edit-row-${idx}`)?.dataset.acctId;
    if (!id) return;
    _pausedAcctIntent[id] = !_pausedAcctIntent[id];
    const intendedBenched = _pausedAcctIntent[id];
    const btn = document.getElementById(`acct-bench-btn-${idx}`);
    if (btn) {
      btn.textContent = intendedBenched ? 'Benched' : 'Active';
      if (intendedBenched) btn.classList.add('is-benched');
      else btn.classList.remove('is-benched');
    }
    await stageBench(id, intendedBenched);
  };

  // Swap…: show/hide the inline swap select + confirm button.
  window._toggleSwapRow = function(idx) {
    const block = document.getElementById(`acct-swap-block-${idx}`);
    const tog = document.getElementById(`acct-swap-toggle-${idx}`);
    if (!block) return;
    const visible = block.style.display !== 'none';
    block.style.display = visible ? 'none' : 'inline-flex';
    if (tog) tog.textContent = visible ? 'Swap…' : 'Cancel';
  };

  // Swap confirm: call stageSwap(oldId, newId), mark row as swapping.
  window._doSwapAccount = async function(idx) {
    const oldId = document.getElementById(`acct-edit-row-${idx}`)?.dataset.acctId;
    const sel = document.getElementById(`acct-swap-sel-${idx}`);
    if (!oldId || !sel || !sel.value) return;
    const newId = sel.value;
    const ok = await stageSwap(oldId, newId);
    if (ok) {
      const row = document.getElementById(`acct-edit-row-${idx}`);
      if (row) {
        const actionsEl = row.querySelector('.acct-edit-actions');
        if (actionsEl) actionsEl.innerHTML = `<span style="color:var(--gray,#8a8a8a);font-size:12px">→ swapping on resume</span>`;
      }
    }
  };

  // ＋ Add account handler.
  window._doAddAccount = async function() {
    const sel = document.getElementById('acct-add-select');
    if (!sel || !sel.value) return;
    const ok = await stageAddAccount(sel.value);
    if (ok) {
      // Remove the added option so the same profile can't be added twice.
      const opt = sel.querySelector(`option[value="${CSS.escape(sel.value)}"]`);
      if (opt) opt.remove();
      if (sel.options.length === 0) {
        const c = document.getElementById('acct-add-section');
        if (c) {
          const addSection = c.querySelector('.acct-edit-add');
          if (addSection) addSection.innerHTML = `<span style="color:var(--gray,#8a8a8a);font-size:12px">No additional accounts available to add.</span>`;
        }
      }
    }
  };
}
window.renderPauseAccountAdd = renderPauseAccountAdd;

window.dashPauseActive = async function() {
  try {
    const sr = await fetch('/api/campaign/status');
    const s = await sr.json();
    const isPaused = !!(s._paused || s.paused);
    if (isPaused) {
      // onResumeClicked either resumes immediately (confirmResume → toast + pollStatus) or
      // opens the review panel (whose Confirm button does the same). No poll here: when the
      // panel is shown nothing has changed yet, and confirmResume owns the post-resume refresh.
      await onResumeClicked();
    } else {
      const endpoint = '/api/campaign/pause';
      const r = await fetch(endpoint, { method: 'POST' });
      if (r.ok) {
        if (typeof showCampaignToast === 'function') showCampaignToast('Pausing…');
        if (typeof pollStatus === 'function') pollStatus();
      } else {
        if (typeof showCampaignToast === 'function') showCampaignToast('Pause/resume failed');
      }
    }
  } catch (err) { console.error('[v3] dashPauseActive:', err); }
};

window.dashStopActive = async function() {
  // If the campaign is already in the MONITORING phase, the dashboard Stop
  // button must END MONITORING (→ /api/monitoring/stop → stopMonitoring,
  // state → 'done'), not run the campaign-stop flow. The active card is what
  // shows during monitoring, so its Stop ■ lands here — route it straight to
  // the monitoring stop so "end monitoring on the dashboard" actually ends it,
  // regardless of modal routing or the running flag.
  if (typeof __cockpit !== 'undefined' && __cockpit && __cockpit.state === 'monitoring'
      && typeof window.dashStopMonitoring === 'function') {
    window.dashStopMonitoring();
    return;
  }
  // Otherwise route through confirmStopCampaign so CC+IC / CC+DM get the
  // "Stop everything vs. keep monitoring" choice modal and simpler modes
  // get the plain confirm.
  if (typeof confirmStopCampaign === 'function') {
    confirmStopCampaign();
  }
};

window.dashRestartActive = async function() {
  if (!confirm('Restart this campaign from the beginning? Progress will reset.')) return;
  try {
    const sr = await fetch('/api/campaign/status');
    const s = await sr.json();
    // Capture config before stop wipes the in-memory campaign state.
    const config = {
      name: s.name,
      mode: s.mode,
      profileIds: s.profileIds,
      sheetUrl: s.sheetUrl,
      templates: s.templates,
      dailyLimit: s.dailyLimit,
      linkedinColumn: s.linkedinColumn,
    };
    await fetch('/api/campaign/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
    await fetch('/api/campaign/queue-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (typeof showCampaignToast === 'function') showCampaignToast('Restart queued');
    if (typeof pollStatus === 'function') pollStatus();
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashRestartActive:', err); }
};

window.dashCopyActiveToQueue = async function() {
  try {
    const sr = await fetch('/api/campaign/status');
    const s = await sr.json();
    if (!s.running) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Nothing to copy');
      return;
    }
    await fetch('/api/campaign/queue-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (s.name || 'Campaign') + ' (copy)',
        mode: s.mode,
        profileIds: s.profileIds,
        sheetUrl: s.sheetUrl,
        templates: s.templates,
        dailyLimit: s.dailyLimit,
        linkedinColumn: s.linkedinColumn,
      }),
    });
    if (typeof showCampaignToast === 'function') showCampaignToast('Copied "' + (s.name || '') + '" to queue');
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashCopyActiveToQueue:', err); }
};

// v2.78: Run check now → ask scope (this campaign's accounts vs all senders in
// the sheet), then run via _runActiveBulkCheck. Same modal as "Run a solo check".
window.dashBulkCheck = function() { openActiveBulkCheckModal(); };

// v2.72: messaging campaigns don't send connection requests, so the check
// section becomes a REPLY check (scan sent threads for replies) instead of a
// connection-acceptance sweep. These modes message leads directly.
const _REPLY_CHECK_MODES = new Set(['open_profile_only', 'inmail_only', 'message_only', 'introduce_back']);
function isReplyCheckMode(mode) { return _REPLY_CHECK_MODES.has(String(mode || '')); }

// Re-label the active-card check section based on the running campaign's mode.
function applyCheckSectionMode(mode) {
  window.__activeCheckMode = mode || '';
  const reply = isReplyCheckMode(mode);
  const head = document.getElementById('vj-bulk-head');
  const suffix = document.getElementById('vj-bulk-status-suffix');
  const label = document.getElementById('vj-bulk-btn-label');
  const hint = document.getElementById('vj-bulk-hint');
  if (head) head.textContent = reply ? 'Reply check' : 'Bulk check connection';
  if (suffix) suffix.textContent = reply ? 'new replies' : 'newly accepted';
  if (label) label.textContent = reply ? 'Run reply check now' : 'Run check now';
  if (hint) hint.textContent = reply
    ? 'Scans the messages you sent for replies and writes them to your sheet. Doesn’t affect throughput.'
    : 'Checks all pending connect requests via Voyager. Doesn’t affect throughput.';
}
window.applyCheckSectionMode = applyCheckSectionMode;

// Single button dispatcher — routes to the reply check or the connection
// bulk-check depending on the active campaign's mode.
window.dashRunCheck = function() {
  if (isReplyCheckMode(window.__activeCheckMode)) return window.dashReplyCheck();
  return window.dashBulkCheck();
};

window.dashReplyCheck = async function() {
  try {
    const sr = await fetch('/api/campaign/status');
    const s = await sr.json();
    if (!s.sheetUrl) {
      if (typeof showCampaignToast === 'function') showCampaignToast('No sheet URL');
      return;
    }
    const willPause = !!(s.running && !s.paused);
    if (typeof showCampaignToast === 'function') {
      showCampaignToast(willPause ? 'Pausing campaign + checking for replies…' : 'Checking for replies…');
    }
    const r = await fetch('/api/reply-check-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl: s.sheetUrl, profileIds: s.profileIds, linkedinColumn: s.linkedinColumn }),
    });
    const body = await r.json().catch(() => ({}));
    if (body.ok) {
      const n = body.repliesFound || 0;
      const msg = body.autoPaused
        ? `Reply check done — ${n} new repl${n === 1 ? 'y' : 'ies'}. Campaign resumed.`
        : `Reply check done — ${n} new repl${n === 1 ? 'y' : 'ies'}.`;
      if (typeof showCampaignToast === 'function') showCampaignToast(msg);
      if (typeof window.renderReplies === 'function') window.renderReplies();
    } else {
      if (typeof showCampaignToast === 'function') showCampaignToast('Reply check failed: ' + (body.error || 'unknown'));
    }
  } catch (err) { console.error('[v3] dashReplyCheck:', err); }
};

window.dashOpenActive = async function() {
  // Entering via Open = a read-only VIEW of the live campaign. The launch panel
  // is hidden (see applyViewingActiveLock). The flag is cleared by every other
  // wizard entry (+ New, Edit, preset-load) so staging a NEW campaign while one
  // runs still shows Start/Queue.
  window.__viewingActiveCampaign = true;
  // "Open" enters the RUNNING/MONITORING campaign's editor. It MUST clear the
  // active draft first — otherwise it just navigates to #/new and shows
  // whatever draft was last open (a new campaign, or another campaign you
  // touched), NOT the live one. viewRunningCampaign() flushes autosave →
  // clearActiveDraft → goCreateCampaign.
  if (typeof viewRunningCampaign === 'function') {
    try { await viewRunningCampaign(); } catch (_) { window.location.hash = '#/new'; }
  } else {
    clearActiveDraft();
    window.location.hash = '#/new';
  }

  // v2.83: clearing the draft left every field blank — the operator saw an
  // empty wizard even though a campaign was live (sheet URL, primary contact,
  // templates all missing). Pre-fill from the live settings snapshot the same
  // way the past "Edit & resume" flow does, so Open lands on a fully-populated
  // wizard. Fetch is best-effort: on any failure we still navigate (old
  // behaviour) rather than block the operator.
  let config = null;
  try {
    const r = await fetch('/api/campaign/active-settings');
    const data = await r.json();
    if (data && data.ok && data.settings) {
      const s = data.settings;
      config = {
        mode: s.mode,
        sheetUrl: s.sheetUrl || '',
        dailyLimit: s.dailyLimit ?? 50,
        delayMin: s.delayMin ?? 30,
        delayMax: s.delayMax ?? 60,
        linkedinColumn: s.linkedinColumn || '',
        messageOpenProfiles: !!s.messageOpenProfiles,
        addNote: !!(s.templates && s.templates.connectionNote),
        templates: s.templates || {},
        profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
        senderColumn: s.senderColumn || '',
        allLeadsConnected: !!s.allLeadsConnected,
        concurrency: s.concurrency ?? 1,
        senderFirstNames: s.senderFirstNames || {},
        _campaignName: s.name || '',
      };
    }
  } catch (_) { /* best-effort — navigate without prefill */ }

  // Then scroll to Section 5 (Message Templates / Campaign Settings) so the
  // operator lands where the post-acceptance DM body + other message fields are.
  setTimeout(() => {
    if (config && typeof applyPresetConfig === 'function') {
      applyPresetConfig(config);
      const nameInput = document.getElementById('campaign-name-input');
      if (nameInput && config._campaignName) nameInput.value = config._campaignName;
    }
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
    const target = document.getElementById('nav-templates');
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, 200);
};

// v2.59.24: "Show more / less" log toggle for the wizard Live Status card.
// Re-renders immediately from the stashed full log so it doesn't wait for the
// next 2s poll. Only meaningful in-wizard (the button is hidden elsewhere).
window.dashToggleLogLines = function(btn) {
  window.__wizLogExpanded = !window.__wizLogExpanded;
  const logs = window.__activeFullLogs || [];
  const card = document.getElementById('active-card');
  const inWizard = !!(card && card.classList.contains('in-wizard'));
  const expanded = window.__wizLogExpanded;
  const defaultN = inWizard ? 15 : 6;
  const lastN = logs.slice(-(expanded ? 100 : defaultN));
  const logEl = document.getElementById('active-log');
  if (logEl) logEl.innerHTML = lastN.map(l => v3RenderLogLine(l)).join('');
  const head = card && card.querySelector('.vj-log-head .vj-details-head');
  if (head) head.textContent = `Live log · last ${lastN.length} events`;
  if (btn) btn.textContent = expanded ? 'Show less' : 'Show more';
  if (card) card.classList.toggle('is-log-expanded', expanded);
};

window.dashOpenBatchSettings = function() {
  window.location.hash = '#/new';
  setTimeout(() => {
    const target = document.getElementById('nav-pace');
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth' });
  }, 200);
};

/* ── Monitoring card ─────────────────────────────────────────────────────── */

const V3_MONITORING_TOTAL_DAYS = 7;

function v3ComputeMonitoringDay(status) {
  // Day X of 7 — derived from monitoringUntil (7 days from sending end).
  // Fall back to 0 if we can't compute.
  if (!status || !status.monitoringUntil) return 0;
  const endMs = new Date(status.monitoringUntil).getTime();
  if (Number.isNaN(endMs)) return 0;
  const startMs = endMs - V3_MONITORING_TOTAL_DAYS * 24 * 3600 * 1000;
  const ms = Date.now() - startMs;
  const day = Math.floor(ms / (24 * 3600 * 1000)) + 1;
  return Math.max(0, Math.min(V3_MONITORING_TOTAL_DAYS, day));
}

window.renderMonitoringCard = function(_status) {
  // v2.59.x: monitoring is now shown in the main active card (Variant E —
  // blue, next-check countdown). This standalone section is retired so the
  // dashboard doesn't render the same monitoring campaign twice.
  const sect = document.getElementById('monitoring-section');
  if (sect) sect.style.display = 'none';
};

window.toggleMonitorMini = function() {
  const card = document.getElementById('monitoring-section');
  if (!card) return;
  const goingMini = !card.classList.contains('is-mini');
  card.classList.toggle('is-mini');
  if (goingMini) card.classList.remove('is-detailed');
};

window.toggleMonitorDetails = function(btn) {
  const card = document.getElementById('monitoring-section');
  if (!card) return;
  const opening = !card.classList.contains('is-detailed');
  card.classList.toggle('is-detailed');
  const svg = btn && btn.querySelector('svg');
  if (svg) svg.style.transform = opening ? 'rotate(180deg)' : 'rotate(0deg)';
  if (btn) btn.setAttribute('data-tip', opening ? 'Hide details' : 'Show details');
};

window.dashStopMonitoring = async function() {
  if (!confirm('Stop monitoring? Remaining unaccepted leads will be stamped Closed.')) return;
  try {
    const r = await fetch('/api/monitoring/stop', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Monitoring stopped');
    } else {
      if (typeof showCampaignToast === 'function') showCampaignToast('Stop failed: ' + (body.error || 'unknown'));
    }
    if (typeof pollStatus === 'function') pollStatus();
  } catch (err) { console.error('[v3] dashStopMonitoring:', err); }
};

window.dashForceSweep = async function() {
  try {
    const r = await fetch('/api/monitoring/check-now', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Sweep firing now…');
    } else {
      if (typeof showCampaignToast === 'function') showCampaignToast('Sweep failed: ' + (body.error || body.reason || 'unknown'));
    }
    if (typeof pollStatus === 'function') pollStatus();
  } catch (err) { console.error('[v3] dashForceSweep:', err); }
};

window.dashCopyMonitorToQueue = async function() {
  try {
    const r = await fetch('/api/monitoring/state');
    const m = await r.json();
    if (!m || !m.name) {
      if (typeof showCampaignToast === 'function') showCampaignToast('No monitoring state to copy');
      return;
    }
    await fetch('/api/campaign/queue-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (m.name || 'Campaign') + ' (rerun)',
        mode: m.mode,
        profileIds: m.profileIds || m.participatingProfileIds,
        sheetUrl: m.sheetUrl,
        templates: m.templates,
        dailyLimit: m.dailyLimit,
        linkedinColumn: m.linkedinColumn,
      }),
    });
    if (typeof showCampaignToast === 'function') showCampaignToast('Copied to queue');
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashCopyMonitorToQueue:', err); }
};

/* ── Up Next deck ───────────────────────────────────────────────────────── */

const V3_SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,4 20,12 7,20"/></svg>';
const V3_SVG_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
const V3_SVG_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const V3_SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const V3_SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const V3_SVG_CHEV = '<svg class="dock-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const V3_SVG_CLOCK_INLINE = '<svg class="clock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';
const V3_SVG_RESTART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
const V3_SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>';
const V3_SVG_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const V3_SVG_ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';

function v3Ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function v3FormatScheduledAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const ms = d.getTime() - now;
  if (ms < 60 * 1000) return 'starting…';
  if (ms < 24 * 3600 * 1000) {
    const hours = Math.round(ms / 3600 / 1000);
    return hours <= 0 ? 'soon' : `in ${hours}h`;
  }
  const days = Math.round(ms / 86400 / 1000);
  if (days === 1) return `tomorrow ${v3FmtClock(d)}`;
  return `in ${days}d`;
}

function v3BuildQueueDock(q, isScheduled) {
  const dockId = 'dock-queue-' + (q.id || Math.random().toString(36).slice(2));
  const safeId = (typeof escHtml === 'function' ? escHtml(q.id || '') : (q.id || ''));
  const safeName = (typeof escHtml === 'function' ? escHtml(q.name || '') : (q.name || ''));
  const primaryTip = isScheduled ? 'Reschedule' : 'Start now';
  const primarySvg = isScheduled ? V3_SVG_CAL : V3_SVG_PLAY;
  const primaryFn = isScheduled ? 'dashRescheduleQueueItem' : 'dashStartQueueItem';
  const otherTip = isScheduled ? 'Start now' : 'Reschedule';
  const otherSvg = isScheduled ? V3_SVG_PLAY : V3_SVG_CAL;
  const otherFn = isScheduled ? 'dashStartQueueItem' : 'dashRescheduleQueueItem';
  return `
    <div class="dock" id="${dockId}" role="toolbar" aria-label="${safeName} actions">
      <button class="dock-btn" data-tip="${primaryTip}" aria-label="${primaryTip}" onclick="window.${primaryFn}('${safeId}')">${primarySvg}</button>
      <div class="dock-actions">
        <button class="dock-btn" data-tip="${otherTip}" aria-label="${otherTip}" onclick="window.${otherFn}('${safeId}')">${otherSvg}</button>
        <button class="dock-btn" data-tip="Edit" aria-label="Edit" onclick="window.dashEditQueueItem('${safeId}')">${V3_SVG_PENCIL}</button>
        <button class="dock-btn" data-tip="Duplicate" aria-label="Duplicate" onclick="window.dashDuplicateQueueItem('${safeId}')">${V3_SVG_COPY}</button>
        <button class="dock-btn danger" data-tip="Remove" aria-label="Remove" onclick="window.dashRemoveQueueItem('${safeId}')">${V3_SVG_TRASH}</button>
      </div>
    </div>
  `;
}

window.renderUpNextDeck = async function() {
  const list = document.getElementById('queueList');
  if (!list) return;
  let queue = [];
  try {
    const r = await fetch('/api/queue');
    const data = await r.json();
    queue = Array.isArray(data?.queue) ? data.queue : [];
  } catch (err) {
    console.error('[v3] renderUpNextDeck fetch:', err);
  }
  v3SetText('queueCount', String(queue.length));
  // Bug 13: "Clear all" only when there's something to clear.
  const clearBtn = document.getElementById('queue-clear-btn');
  if (clearBtn) clearBtn.hidden = queue.length === 0;

  if (queue.length === 0) {
    list.innerHTML = '<div class="vc-empty" style="padding:24px;color:var(--gray);font-size:13px">No queued campaigns.</div>';
    return;
  }

  const safe = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s || ''));

  const parts = ['<div class="vc-stack">'];
  queue.forEach((q, idx) => {
    const id = safe(q.id || '');
    const name = safe(q.name || '(unnamed)');
    const badge = v3ModeBadge(q.mode);
    const modeLabel = safe((typeof dashboardModeLabel === 'function' ? dashboardModeLabel(q.mode) : q.mode) || '');
    const accountCount = (q.profileIds || []).length;
    const isScheduled = !!q.scheduledAt;
    const whenText = isScheduled ? v3FormatScheduledAt(q.scheduledAt) : '';
    const eyebrowText = isScheduled
      ? `Scheduled · ${whenText}`
      : (idx === 0 ? 'Queued · Next up' : `Queued · ${v3Ordinal(idx + 1)}`);
    const dockHtml = v3BuildQueueDock(q, isScheduled);

    if (idx === 0) {
      // Showcase card — top of deck
      const queuedAt = q.queuedAt ? safe((typeof _humanAgo === 'function' ? _humanAgo(new Date(q.queuedAt).getTime()) : q.queuedAt)) : '';
      const sheetLabel = q.sheetUrl ? safe((q.sheetUrl.match(/#gid=\d+/) ? (q.sheetUrl.split('/').slice(-1)[0] || q.sheetUrl) : q.sheetUrl).slice(0, 60)) : '—';
      parts.push(`
        <div class="vc-card-top${isScheduled ? ' is-scheduled' : ''}" data-queue-id="${id}" draggable="true">
          <div class="vc-handle" aria-label="Drag to reorder" title="Drag to reorder"></div>
          <div class="vc-top-glyph">${safe(badge)}</div>
          <div class="vc-top-body">
            <div class="vc-top-eyebrow${isScheduled ? ' is-scheduled' : ''}">
              <span class="dot"></span>${safe(eyebrowText)}
            </div>
            <div class="vc-top-name">${name}</div>
            <div class="vc-top-preview-dense">
              <div class="row"><span class="k">Mode</span><span class="v"><b>${safe(badge)}</b> · ${modeLabel}</span></div>
              <div class="row"><span class="k">Sheet</span><span class="v">${sheetLabel}</span></div>
              <div class="row"><span class="k">Accounts</span><span class="v"><b>${accountCount}</b></span></div>
              ${queuedAt ? `<div class="row"><span class="k">Queued</span><span class="v">${queuedAt}</span></div>` : ''}
            </div>
          </div>
          ${dockHtml}
        </div>
      `);
    } else {
      const depth = idx === 1 ? 'depth-2' : 'depth-3';
      const whenHtml = isScheduled
        ? `${V3_SVG_CLOCK_INLINE}<b>${safe(whenText)}</b>`
        : `Queued · ${v3Ordinal(idx + 1)}`;
      parts.push(`
        <div class="vc-mini ${depth}${isScheduled ? ' is-scheduled' : ''}" data-queue-id="${id}" draggable="true">
          <div class="vc-handle" aria-label="Drag to reorder" title="Drag to reorder"></div>
          <div class="vc-mini-glyph">${safe(badge)}</div>
          <div class="vc-mini-name">${name}</div>
          <div class="vc-mini-when">${whenHtml}</div>
          ${dockHtml}
        </div>
      `);
    }
  });
  parts.push('</div>');
  list.innerHTML = parts.join('');

  v3EnableQueueDnD();
};

function v3EnableQueueDnD() {
  const rows = document.querySelectorAll('#queueList [data-queue-id]');
  let dragId = null;
  rows.forEach(row => {
    row.addEventListener('dragstart', (e) => {
      dragId = row.getAttribute('data-queue-id');
      row.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId || ''); } catch {}
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dropId = row.getAttribute('data-queue-id');
      if (!dragId || dropId === dragId) { dragId = null; return; }
      // Compute the new ordering: pull dragId out, insert before dropId.
      const allRows = Array.from(document.querySelectorAll('#queueList [data-queue-id]'));
      const ids = allRows.map(r => r.getAttribute('data-queue-id')).filter(Boolean);
      const fromIdx = ids.indexOf(dragId);
      if (fromIdx === -1) { dragId = null; return; }
      ids.splice(fromIdx, 1);
      const toIdx = ids.indexOf(dropId);
      if (toIdx === -1) ids.push(dragId);
      else ids.splice(toIdx, 0, dragId);
      dragId = null;
      try {
        const r = await fetch('/api/queue/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          if (typeof showCampaignToast === 'function') showCampaignToast('Reorder failed: ' + (body.error || r.statusText));
        }
      } catch (err) {
        console.error('[v3] queue reorder:', err);
      }
      if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
    });
  });
}

window.dashStartQueueItem = async function(id) {
  try {
    const r = await fetch('/api/queue');
    const data = await r.json();
    const queue = Array.isArray(data?.queue) ? data.queue : [];
    const ids = queue.map(q => q.id);
    const fromIdx = ids.indexOf(id);
    if (fromIdx === -1) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Queue item not found');
      return;
    }
    if (fromIdx > 0) {
      ids.splice(fromIdx, 1);
      ids.unshift(id);
      await fetch('/api/queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    }
    const launchR = await fetch('/api/queue/run-next', { method: 'POST' });
    const body = await launchR.json().catch(() => ({}));
    if (launchR.ok && body.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Started ' + (queue[fromIdx]?.name || ''));
    } else {
      if (typeof showCampaignToast === 'function') showCampaignToast('Cannot start: ' + (body.message || body.reason || body.error || 'busy'));
    }
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashStartQueueItem:', err); }
};

window.dashRescheduleQueueItem = async function(id) {
  let when;
  if (typeof promptModal === 'function') {
    when = await promptModal({ label: 'Reschedule to ISO timestamp (e.g. 2026-05-28T10:00:00Z):' });
  } else {
    when = window.prompt('Reschedule to ISO timestamp (e.g. 2026-05-28T10:00:00Z):');
  }
  if (!when) return;
  try {
    const r = await fetch('/api/queue/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: when }),
    });
    if (r.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Rescheduled');
    } else {
      const body = await r.json().catch(() => ({}));
      if (typeof showCampaignToast === 'function') showCampaignToast('Reschedule failed: ' + (body.error || r.statusText));
    }
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashRescheduleQueueItem:', err); }
};

window.dashEditQueueItem = async function(id) {
  try {
    const r = await fetch('/api/queue/' + encodeURIComponent(id));
    const entry = await r.json();
    if (!entry || !entry.config) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Queue entry not found');
      return;
    }
    // Open the wizard. The existing applyPresetConfig path is the cleanest
    // hydrate hook — used by editPastCampaign as well.
    if (typeof applyPresetConfig === 'function') {
      applyPresetConfig({ name: entry.name, ...entry.config });
    }
    if (typeof goCreateCampaign === 'function') goCreateCampaign();
    else window.location.hash = '#/new';
  } catch (err) { console.error('[v3] dashEditQueueItem:', err); }
};

window.dashDuplicateQueueItem = async function(id) {
  try {
    const r = await fetch('/api/queue/' + encodeURIComponent(id));
    const entry = await r.json();
    if (!entry || !entry.config) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Queue entry not found');
      return;
    }
    await fetch('/api/campaign/queue-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry.config, name: (entry.name || 'Campaign') + ' (copy)' }),
    });
    if (typeof showCampaignToast === 'function') showCampaignToast('Duplicated');
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashDuplicateQueueItem:', err); }
};

window.dashRemoveQueueItem = async function(id) {
  if (!confirm('Remove from queue?')) return;
  try {
    await fetch('/api/queue/' + encodeURIComponent(id), { method: 'DELETE' });
    if (typeof showCampaignToast === 'function') showCampaignToast('Removed');
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashRemoveQueueItem:', err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// v3 dashboard — Calendar grid (This Week)
// Builds a Monday→Sunday grid for the visible week. Today is highlighted.
// Chips: running campaign (today), monitoring sweep (nextCheckAt's day),
// scheduled cron entries (simple 5-field parser; non-trivial expressions skip
// with console.warn). Week navigation via _v3CalWeekOffset.
// ─────────────────────────────────────────────────────────────────────────────
let _v3CalWeekOffset = 0; // 0 = current week, +1 = next, -1 = prev

window.renderCalendarGrid = async function() {
  const grid = document.getElementById('calGrid');
  if (!grid) return;

  const today = new Date();
  const monday = v3StartOfWeek(today, _v3CalWeekOffset);
  const range = document.getElementById('calRange');
  if (range) range.textContent = v3FormatWeekRange(monday);

  let schedules = [];
  let status = {};
  try {
    const [sr, str] = await Promise.all([
      fetch('/api/schedules'),
      fetch('/api/campaign/status'),
    ]);
    if (sr.ok) {
      const sBody = await sr.json();
      schedules = Array.isArray(sBody) ? sBody : (sBody && sBody.schedules) || [];
    }
    if (str.ok) status = await str.json();
  } catch (err) {
    console.error('[v3] renderCalendarGrid fetch:', err);
  }

  // Build 7 day cells (Monday → Sunday)
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = v3AddDays(monday, i);
    days.push({ date: d, isToday: v3SameDay(d, today), chips: [] });
  }

  // Running campaign chip on today (only if we're viewing the current week)
  if (status && status.running && _v3CalWeekOffset === 0) {
    const todayCell = days.find(x => x.isToday);
    if (todayCell) {
      todayCell.chips.push({
        mode: v3ModeBadge(status.mode),
        name: status.name || '',
        running: true,
        kind: 'running',
      });
    }
  }

  // Monitoring next-sweep chip on nextCheckAt's day
  if (status && status.state === 'monitoring' && status.nextCheckAt) {
    try {
      const next = new Date(status.nextCheckAt);
      const cell = days.find(x => v3SameDay(x.date, next));
      if (cell) {
        cell.chips.push({
          mode: 'SW',
          name: 'Sweep · ' + (status.name || ''),
          time: v3FormatTime(next),
          faded: false,
          kind: 'sweep',
        });
      }
    } catch (err) { /* ignore malformed nextCheckAt */ }
  }

  // Scheduled cron entries — only fires within visible week
  const weekEnd = v3AddDays(monday, 7);
  for (const sched of schedules) {
    if (!sched || sched.enabled === false) continue;
    try {
      const fireDates = v3ExpandSimpleCronInRange(sched.cron, monday, weekEnd);
      for (const fd of fireDates) {
        const cell = days.find(x => v3SameDay(x.date, fd));
        if (cell) {
          cell.chips.push({
            mode: v3ModeBadge(sched.mode),
            name: sched.name || 'Scheduled',
            time: v3FormatTime(fd),
            faded: true,
            kind: 'scheduled',
            scheduleId: sched.id,
          });
        }
      }
    } catch (err) {
      console.warn('[v3] calendar cron parse skipped:', sched && sched.cron, err && err.message);
    }
  }

  // Render cells
  grid.innerHTML = '';
  const dowLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  days.forEach((day, idx) => {
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (day.isToday ? ' today' : '');
    cell.dataset.calDate = day.date.toISOString().slice(0, 10);
    if (!day.isToday) cell.addEventListener('click', () => window.dashCalDayClick(cell));

    const head = '<div class="cal-head"><div class="cal-dow">' + dowLabels[idx] + '</div><div class="cal-date">' + day.date.getDate() + '</div></div>';
    const chipsHtml = day.chips.slice(0, 3).map(c => v3CalChipHtml(c)).join('');
    const moreHtml = day.chips.length > 3
      ? '<div class="cal-more" style="margin-top:6px;font-family:var(--mono);font-size:0.56rem;color:var(--gray);">+ ' + (day.chips.length - 3) + ' more</div>'
      : '';
    const hint = day.isToday ? '' : '<div class="cal-hint">+ Schedule</div>';
    cell.innerHTML = head + chipsHtml + moreHtml + hint;
    grid.append(cell);
  });
};

function v3CalChipHtml(c) {
  const safe = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s));
  const cls = 'cal-chip' + (c.running ? ' running' : '') + (c.faded ? ' faded' : '');
  const time = c.time ? '<span class="time">' + safe(c.time) + '</span>' : '';
  return '<div class="' + cls + '" data-chip-kind="' + safe(c.kind || '') + '" data-chip-name="' + safe(c.name) + '" onclick="window.dashCalChipClick(this, event)"><span class="badge">' + safe(c.mode) + '</span>' + time + '<span class="name">' + safe(c.name) + '</span></div>';
}

// Date helpers — Monday-based start of week
function v3StartOfWeek(d, weekOffset) {
  const base = new Date(d);
  const day = base.getDay(); // 0=Sun … 6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  base.setDate(base.getDate() + diff + ((weekOffset || 0) * 7));
  base.setHours(0, 0, 0, 0);
  return base;
}
function v3SameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
function v3AddDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function v3FormatTime(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function v3FormatWeekRange(monday) {
  const sunday = v3AddDays(monday, 6);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (monday.getMonth() === sunday.getMonth()) {
    return monday.getDate() + ' — ' + sunday.getDate() + ' ' + months[sunday.getMonth()];
  }
  return monday.getDate() + ' ' + months[monday.getMonth()] + ' — ' + sunday.getDate() + ' ' + months[sunday.getMonth()];
}

// Simple cron expander — "M H D M W" with literal numbers or "*".
// Skips comma lists, ranges, /steps with a console.warn (called by renderer).
function v3ExpandSimpleCronInRange(cronExpr, start, end) {
  if (!cronExpr || typeof cronExpr !== 'string') return [];
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) { console.warn('[v3] cron not 5-field, skipping:', cronExpr); return []; }
  const [mP, hP, domP, monP, dowP] = parts;
  const isSimple = (p) => p === '*' || /^\d+$/.test(p);
  if (![mP, hP, domP, monP, dowP].every(isSimple)) { console.warn('[v3] cron has non-simple parts, skipping:', cronExpr); return []; }
  const minute = mP === '*' ? null : parseInt(mP, 10);
  const hour = hP === '*' ? null : parseInt(hP, 10);
  const dom = domP === '*' ? null : parseInt(domP, 10);
  const mon = monP === '*' ? null : parseInt(monP, 10);
  const dow = dowP === '*' ? null : parseInt(dowP, 10); // 0=Sun, 6=Sat
  const dates = [];
  const cursor = new Date(start);
  while (cursor < end) {
    if ((dom === null || cursor.getDate() === dom)
      && (mon === null || (cursor.getMonth() + 1) === mon)
      && (dow === null || cursor.getDay() === dow)) {
      const fire = new Date(cursor);
      if (hour !== null) fire.setHours(hour);
      if (minute !== null) fire.setMinutes(minute);
      fire.setSeconds(0);
      fire.setMilliseconds(0);
      if (fire >= start && fire < end) dates.push(fire);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

window.dashCalPrev = function() { _v3CalWeekOffset--; window.renderCalendarGrid(); };
window.dashCalNext = function() { _v3CalWeekOffset++; window.renderCalendarGrid(); };
window.dashCalToday = function() { _v3CalWeekOffset = 0; window.renderCalendarGrid(); };

window.dashCalDayClick = function(cell) {
  const d = cell && cell.dataset && cell.dataset.calDate;
  if (typeof showCampaignToast === 'function') showCampaignToast('Schedule on ' + (d || 'day') + ' — open wizard');
  if (typeof window.startNewCampaign === 'function') window.startNewCampaign();
};

window.dashCalChipClick = function(chip, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const kind = (chip && chip.dataset && chip.dataset.chipKind) || '';
  if (kind === 'running') {
    const active = document.getElementById('active-card');
    if (active && active.scrollIntoView) active.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (kind === 'sweep') {
    const monSect = document.getElementById('monitoring-section');
    if (monSect && monSect.scrollIntoView) monSect.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    if (typeof window.startNewCampaign === 'function') window.startNewCampaign();
  }
};

/* ── Past section ───────────────────────────────────────────────────────── */

let _v3PastEntries = []; // cached for handlers (display order: newest-first)

window.renderPastSection = async function() {
  const collapsedEl = document.getElementById('pastCollapsed');
  const listEl = document.getElementById('pastList');
  const countEl = document.getElementById('pastCount');
  if (!collapsedEl || !listEl) return;

  let all = [];
  try {
    // Fetch the full history (including archived rows) so onDiskIdx aligns
    // with history.json's actual indexing — server-side filtering would
    // make the per-row idx point to a different (possibly already-archived)
    // record, which is the "delete does nothing" bug. Archived rows are
    // filtered out below AFTER the on-disk idx is recorded.
    const r = await fetch('/api/history');
    if (r.ok) all = await r.json();
  } catch (err) {
    console.error('[v3] renderPastSection fetch:', err);
  }
  if (!Array.isArray(all)) all = [];

  // Display newest-first. Record each entry's actual on-disk idx FIRST,
  // then drop archived rows. /api/history/:idx/{archive,relaunch,log}
  // operate by on-disk index — getting this wrong silently mutates the
  // wrong record.
  _v3PastEntries = all.map((entry, onDiskIdx) => ({ ...entry, _originalIdx: onDiskIdx }))
                      .filter((entry) => !entry.archived)
                      .slice().reverse();

  if (countEl) countEl.textContent = String(_v3PastEntries.length);

  // Collapsed summary (default state)
  const pcCount = document.getElementById('pcCount');
  const pcSummary = document.getElementById('pcSummary');
  if (_v3PastEntries.length === 0) {
    if (pcCount) pcCount.innerHTML = '0<span class="pc-lbl">past</span>';
    if (pcSummary) pcSummary.innerHTML = 'no finished campaigns yet';
  } else {
    const latest = _v3PastEntries[0];
    const ago = (typeof _humanAgo === 'function' && latest.date) ? _humanAgo(new Date(latest.date).getTime()) : '';
    const isStopped = (latest.endReason === 'stopped' || latest.fullStop);
    let rate;
    if (isStopped) {
      rate = '<b>stopped early</b>';
    } else if (latest.totalProcessed && latest.totalProcessed > 0) {
      const r = ((latest.successCount || 0) / latest.totalProcessed) * 100;
      rate = '<b>' + r.toFixed(1) + '%</b> success rate';
    } else {
      rate = '<b>—</b>';
    }
    const safe = (typeof escHtml === 'function') ? escHtml : (s) => String(s || '');
    if (pcCount) pcCount.innerHTML = _v3PastEntries.length + '<span class="pc-lbl">past</span>';
    if (pcSummary) pcSummary.innerHTML = 'last finished <b>' + safe(latest.name || '') + '</b> · ' + safe(ago) + ' · ' + rate;
  }

  // Expanded list (rendered always; visibility toggled by togglePastExpanded)
  const safe = (typeof escHtml === 'function') ? escHtml : (s) => String(s || '');
  const rows = _v3PastEntries.map((p, displayIdx) => v3RenderPastRow(p, displayIdx, safe)).join('');
  listEl.innerHTML = '<div class="pa-list">' + rows + '</div>';
  // Bug 13: reflect manage ("Select") mode + refresh the bulk-delete bar.
  listEl.classList.toggle('is-managing', pastManageMode);
  _v3UpdatePastBulkBar();
};

// ─────────────────────────────────────────────────────────────────────────
// Resume-draft badge — variant F (2026-05-27 drafts-isolation v2). Small
// gold count on the New-campaign button. Click badge → resume the draft.
// Visible only when getActiveDraftId() points at a draft that still
// exists server-side. Kept the name `renderResumeDraftPill` so existing
// call sites keep working; aliased as renderResumeDraftBadge too.
// ─────────────────────────────────────────────────────────────────────────
window.renderResumeDraftPill = async function() {
  const badge = document.getElementById('resume-draft-badge');
  const nameEl = document.getElementById('resume-draft-name');
  if (!badge) return;
  const id = getActiveDraftId();
  if (!id) { badge.style.display = 'none'; return; }
  try {
    const r = await fetch('/api/drafts/' + encodeURIComponent(id));
    if (!r.ok) {
      if (r.status === 404) clearActiveDraft();
      badge.style.display = 'none';
      return;
    }
    const draft = await r.json();
    const nm = (draft && draft.name ? String(draft.name) : '').trim() || 'Untitled draft';
    if (nameEl) nameEl.textContent = nm.slice(0, 32);
    badge.setAttribute('data-tip', `Resume draft — ${nm}`);
    badge.style.display = 'inline-flex';
  } catch (err) {
    console.warn('[drafts] resume-badge fetch:', err);
    badge.style.display = 'none';
  }
};
window.renderResumeDraftBadge = window.renderResumeDraftPill;

window.dashResumeDraft = function() {
  const id = getActiveDraftId();
  if (!id) return;
  // editDraft already navigates via goCreateCampaign() and hydrates the
  // form. Call it directly so the hash change + draft load happen in
  // sequence (router would also fire updateEditingBanner via applyRoute).
  if (typeof editDraft === 'function') editDraft(id);
  else window.location.hash = '#/new';
};

// Delete the active draft from the dashboard resume-pill. Same call as the
// drafts-list delete, just rooted at the pill so the operator doesn't need
// to navigate anywhere to throw away an unfinished draft.
window.dashDeleteDraftFromPill = async function() {
  const id = getActiveDraftId();
  if (!id) return;
  // Pull the name for the confirm prompt — falls back to the pill text if
  // the network call fails.
  let name = '';
  try {
    const r = await fetch('/api/drafts/' + encodeURIComponent(id));
    if (r.ok) {
      const d = await r.json();
      name = d?.name || '';
    }
  } catch {}
  if (!name) name = document.getElementById('resume-draft-name')?.textContent?.trim() || 'this draft';
  if (!confirm(`Delete draft "${name}"? This can't be undone.`)) return;
  try {
    await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (err) {
    console.warn('[drafts] delete from pill:', err);
  }
  clearActiveDraft();
  if (typeof window.renderResumeDraftPill === 'function') window.renderResumeDraftPill();
  if (typeof showCampaignToast === 'function') showCampaignToast('Draft deleted');
};

function v3RenderPastRow(p, displayIdx, safe) {
  const oIdx = p._originalIdx;
  const ago = (typeof _humanAgo === 'function' && p.date) ? _humanAgo(new Date(p.date).getTime()) : '';
  const isStopped = (p.endReason === 'stopped' || p.fullStop);
  const sent = p.totalProcessed || 0;
  // Bug 10: "replies" removed from the dashboard. successCount still drives the
  // success-rate %, just no longer labelled "replies".
  const succeeded = p.successCount || 0;
  let rateHtml;
  if (isStopped) {
    rateHtml = '<div class="pa-stopped">Stopped early</div>';
  } else if (sent > 0) {
    const r = (succeeded / sent) * 100;
    rateHtml = `<div class="pa-rate">${r.toFixed(1)}<span class="pct">%</span></div>`;
  } else {
    rateHtml = `<div class="pa-rate">—</div>`;
  }
  const dockId = 'dock-past-' + oIdx;
  const selected = pastSelectedIdxs.has(oIdx) ? ' is-selected' : '';
  const checkedAttr = pastSelectedIdxs.has(oIdx) ? 'checked' : '';
  return `
    <div class="pa-row${selected}">
      <input type="checkbox" class="pa-check" ${checkedAttr} onclick="event.stopPropagation()" onchange="window.togglePastSelect(${oIdx}, event)" aria-label="Select campaign" />
      <div class="glyph">${safe(v3ModeBadge(p.mode))}</div>
      <div class="pa-name">${safe(p.name || '(unnamed)')}</div>
      <div class="pa-when">${safe(ago)}</div>
      <div class="pa-stats"><b>${sent}</b> sent</div>
      ${rateHtml}
      <div class="pa-actions">
      ${soloCheckChipHtml(oIdx, p)}
      ${monitoringChipHtml(oIdx, p)}
      <div class="dock" id="${dockId}" role="toolbar" aria-label="${safe(p.name || '')} actions">
        ${isStopped && p.settings ? `<button class="dock-btn" data-tip="Resume" aria-label="Resume" onclick="window.dashResumePast(${oIdx})">${V3_SVG_PLAY}</button>` : ''}
        <button class="dock-btn" data-tip="Rerun" aria-label="Rerun" onclick="window.dashRerunPast(${oIdx})">${V3_SVG_RESTART}</button>
        <div class="dock-actions">
          <button class="dock-btn" data-tip="Open log" aria-label="Open log" onclick="window.dashOpenPastLog(${oIdx})">${V3_SVG_DOC}</button>
          ${isStopped && p.settings ? `<button class="dock-btn" data-tip="Edit &amp; resume" aria-label="Edit and resume" onclick="window.dashEditResumePast(${oIdx})">${V3_SVG_PENCIL}</button>` : ''}
          <button class="dock-btn" data-tip="Copy to queue" aria-label="Copy to queue" onclick="window.dashCopyPastToQueue(${oIdx})">${V3_SVG_COPY}</button>
          <button class="dock-btn" data-tip="Export CSV" aria-label="Export CSV" onclick="window.dashExportPast(${oIdx})">${V3_SVG_DOWNLOAD}</button>
          <button class="dock-btn danger" data-tip="Delete" aria-label="Delete" onclick="window.dashArchivePast(${oIdx})">${V3_SVG_ARCHIVE}</button>
        </div>
      </div>
      </div>
    </div>
  `;
}

window.togglePastExpanded = function() {
  // v2.61: V3 expand pattern — the bordered frame (#pastFrame) contains
  // both the header (#pastCollapsed) and the list (#pastList). Toggling
  // .is-expanded on the frame rotates the chevron, slides the list into
  // view, and keeps the header visible at the top. No more display:none
  // swap between two visually-different containers.
  const frame = document.getElementById('pastFrame');
  const header = document.getElementById('pastCollapsed');
  const btn = document.getElementById('past-toggle-btn');
  if (!frame) return;
  const isExpanded = frame.classList.toggle('is-expanded');
  if (btn) btn.textContent = isExpanded ? 'Collapse' : 'Show all';
  if (header) header.setAttribute('aria-expanded', String(isExpanded));
};

// v2.71: Resume a stopped past campaign from where it stopped (no edits).
// Wires the dock's Resume icon to the existing resumeFromPastRow flow.
// The `_originalIdx` from v3 = the on-disk history idx, which matches
// `pastCampaignsCache[i].idx` in the legacy renderer too — both paths
// resolve to the same /api/campaign/start with resumeContext.
window.dashResumePast = async function(originalIdx) {
  // Build the legacy pastCampaignsCache shape so resumeWithSameSettings can
  // look up the entry. v3 caches in _v3PastEntries by _originalIdx; the
  // legacy code expects { idx, c } entries in pastCampaignsCache.
  const entry = (_v3PastEntries || []).find(p => p._originalIdx === originalIdx);
  if (!entry) {
    if (typeof showCampaignToast === 'function') showCampaignToast('Past entry not found');
    return;
  }
  pastCampaignsCache = (pastCampaignsCache || []);
  if (!pastCampaignsCache.find(e => e.idx === originalIdx)) {
    pastCampaignsCache.push({ idx: originalIdx, c: entry });
  }
  if (typeof resumeFromPastRow === 'function') resumeFromPastRow(originalIdx);
};

// v2.71: Edit + resume flow. Prefill the wizard with the past campaign's
// settings, set localStorage hooks so:
//   • the existing startCampaign auto-attaches resumeContext.totalProcessed
//     (via the wizardStoppedFromContext mechanism — name-match required)
//   • submitStartCampaign's success block knows which source past entry to
//     delete after the resume launches (editResumeSourceIdx)
// Then shows the wizard's resume banner with the "Save edits & resume"
// button so the operator has a clearly-labelled commit action.
window.dashEditResumePast = async function(originalIdx) {
  const entry = (_v3PastEntries || []).find(p => p._originalIdx === originalIdx);
  if (!entry || !entry.settings) {
    if (typeof showCampaignToast === 'function') showCampaignToast('No saved settings on this row');
    return;
  }
  const s = entry.settings;
  const config = {
    mode: entry.mode,
    sheetUrl: s.sheetUrl || '',
    dailyLimit: s.dailyLimit ?? 50,
    delayMin: s.delayMin ?? 30,
    delayMax: s.delayMax ?? 60,
    linkedinColumn: s.linkedinColumn || '',
    messageOpenProfiles: !!s.messageOpenProfiles,
    addNote: !!(s.templates && s.templates.connectionNote),
    templates: s.templates || {},
    profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
    concurrency: s.concurrency ?? 1,
    senderFirstNames: s.senderFirstNames || {},
  };
  // Seed the resume hooks BEFORE navigation so the wizard view picks them up.
  try {
    localStorage.setItem('wizardStoppedFromContext', JSON.stringify({
      name: entry.name || '',
      totalProcessed: Number(entry.totalProcessed) || Number(entry.successCount) || 0,
    }));
    localStorage.setItem('editResumeSourceIdx', String(originalIdx));
  } catch {}
  if (typeof goCreateCampaign === 'function') goCreateCampaign();
  setTimeout(() => {
    if (typeof applyPresetConfig === 'function') applyPresetConfig(config);
    // Restore the original name UNMODIFIED — resume requires name match.
    const nameInput = document.getElementById('campaign-name-input');
    if (nameInput) nameInput.value = (entry.name || '').trim();
    // Show the resume banner with the labelled commit button.
    const banner = document.getElementById('wizard-resume-banner');
    if (banner) banner.style.display = '';
  }, 100);
};

// v2.71: explicit commit button for the edit-resume flow. Functionally the
// same as the wizard Start button (resumeContext is auto-attached from
// wizardStoppedFromContext), just labelled clearly so the operator knows
// this is the persist-changes-and-resume action vs. a fresh launch.
window.saveEditsAndResume = async function() {
  if (typeof startCampaign === 'function') {
    await startCampaign({});
  }
};

window.dashRerunPast = async function(originalIdx) {
  try {
    const r = await fetch('/api/history/' + originalIdx + '/relaunch', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast(body.message || 'Queued rerun');
      if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
      // When the server fired the campaign immediately (idle path), kick
      // the 2s pollStatus loop + a direct active-card paint so the tile
      // populates without waiting up to 5s for the dashboard timer.
      if (body.started) {
        if (typeof startPolling === 'function') startPolling();
        try {
          const s = await fetch('/api/campaign/status').then(r => r.json());
          if (typeof window.renderActiveCard === 'function') window.renderActiveCard(s);
        } catch { /* best-effort */ }
      }
    } else {
      if (typeof showCampaignToast === 'function') showCampaignToast('Rerun failed: ' + (body.error || r.statusText));
    }
  } catch (err) { console.error('[v3] dashRerunPast:', err); }
};

window.dashOpenPastLog = async function(originalIdx) {
  try {
    const r = await fetch('/api/history/' + originalIdx + '/log');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Log fetch failed: ' + (body.error || r.statusText));
      return;
    }
    v3ShowLogModal(body.name || ('Campaign ' + originalIdx), body.lines || []);
  } catch (err) { console.error('[v3] dashOpenPastLog:', err); }
};

function v3ShowLogModal(name, lines) {
  let modal = document.getElementById('v3-log-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'v3-log-modal';
    modal.className = 'modal-shade';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div class="modal-card" style="background:var(--bg);border:1px solid var(--hairline);color:var(--ink);width:min(720px, 92vw);max-height:80vh;display:flex;flex-direction:column;font-family:var(--mono);">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hairline);display:flex;justify-content:space-between;align-items:center;">
          <div id="v3-log-title" style="font-family:var(--display);font-size:1.2rem;letter-spacing:0.02em;"></div>
          <button type="button" onclick="document.getElementById('v3-log-modal').style.display='none'" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);padding:6px 12px;font-family:var(--mono);font-size:0.6rem;letter-spacing:0.22em;text-transform:uppercase;cursor:pointer;border-radius:9999px;">Close</button>
        </div>
        <pre id="v3-log-body" style="flex:1;overflow:auto;padding:14px 18px;font-family:'JetBrains Mono', 'SF Mono', Menlo, monospace;font-size:0.72rem;line-height:1.5;color:var(--gray);white-space:pre-wrap;word-break:break-word;margin:0;background:var(--bg-soft);"></pre>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  }
  const title = document.getElementById('v3-log-title');
  const body = document.getElementById('v3-log-body');
  const safe = (typeof escHtml === 'function') ? escHtml : (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (title) title.textContent = name;
  if (body) {
    if (Array.isArray(lines) && lines.length > 0) {
      body.innerHTML = lines.map(l => safe(l)).join('\n');
    } else {
      body.textContent = 'No log lines found for this campaign.';
    }
  }
  modal.style.display = 'flex';
}

window.dashCopyPastToQueue = async function(originalIdx) {
  try {
    const r = await fetch('/api/history');
    const all = await r.json();
    if (!Array.isArray(all) || !all[originalIdx]) {
      if (typeof showCampaignToast === 'function') showCampaignToast('History entry not found');
      return;
    }
    const entry = all[originalIdx];
    if (!entry.settings) {
      if (typeof showCampaignToast === 'function') showCampaignToast('No settings to copy');
      return;
    }
    await fetch('/api/campaign/queue-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...entry.settings,
        name: (entry.name || 'Campaign') + ' (copy)',
        mode: entry.mode,
      }),
    });
    if (typeof showCampaignToast === 'function') showCampaignToast('Copied to queue');
    if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
  } catch (err) { console.error('[v3] dashCopyPastToQueue:', err); }
};

window.dashExportPast = function(originalIdx) {
  // /api/export/csv exports state.json processed leads (existing endpoint, not per-entry).
  try {
    window.open('/api/export/csv', '_blank');
  } catch (err) { console.error('[v3] dashExportPast:', err); }
};

window.dashArchivePast = async function(originalIdx) {
  if (!confirm('Delete this campaign? It will be removed from the list.')) return;
  try {
    // Soft-delete on the server (history record kept for audit), shown as
    // a hard "Delete" in the UI because "Archive" was confusing operators.
    const r = await fetch('/api/history/' + originalIdx + '/archive', { method: 'PATCH' });
    if (r.ok) {
      if (typeof showCampaignToast === 'function') showCampaignToast('Deleted');
      if (typeof window.renderPastSection === 'function') window.renderPastSection();
    } else {
      const body = await r.json().catch(() => ({}));
      if (typeof showCampaignToast === 'function') showCampaignToast('Delete failed: ' + (body.error || r.statusText));
    }
  } catch (err) { console.error('[v3] dashArchivePast:', err); }
};

// ── Bug 13: Past bulk delete (manage / "Select" mode) ────────────────────────
// Reuses the module-scoped pastManageMode + pastSelectedIdxs state. Selection is
// keyed on _originalIdx (on-disk history index). Delete = soft-archive, the same
// endpoint the single-row Delete uses; archive never reindexes history.json, so
// a whole batch of indexes stays valid.
window.togglePastManage = function() {
  pastManageMode = !pastManageMode;
  if (!pastManageMode) pastSelectedIdxs.clear();
  const btn = document.getElementById('past-manage-btn');
  if (btn) btn.textContent = pastManageMode ? 'Done' : 'Select';
  // Entering Select mode auto-expands the list so rows + checkboxes are visible.
  if (pastManageMode) {
    const frame = document.getElementById('pastFrame');
    if (frame && !frame.classList.contains('is-expanded') && typeof window.togglePastExpanded === 'function') {
      window.togglePastExpanded();
    }
  }
  if (typeof window.renderPastSection === 'function') window.renderPastSection();
};

window.togglePastSelect = function(oIdx, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (pastSelectedIdxs.has(oIdx)) pastSelectedIdxs.delete(oIdx);
  else pastSelectedIdxs.add(oIdx);
  const row = event && event.target && event.target.closest && event.target.closest('.pa-row');
  if (row) row.classList.toggle('is-selected', pastSelectedIdxs.has(oIdx));
  _v3UpdatePastBulkBar();
};

function _v3UpdatePastBulkBar() {
  const bar = document.getElementById('past-bulk-bar');
  if (!bar) return;
  if (!pastManageMode) { bar.hidden = true; return; }
  bar.hidden = false;
  const n = pastSelectedIdxs.size;
  const countEl = document.getElementById('past-bulk-count');
  const delBtn = document.getElementById('past-bulk-delete-btn');
  if (countEl) countEl.textContent = `${n} selected`;
  if (delBtn) {
    delBtn.disabled = n === 0;
    delBtn.textContent = n > 0 ? `Delete ${n}` : 'Delete selected';
  }
}

async function _v3ArchivePastIdxs(indexes) {
  let ok = 0;
  for (const idx of indexes) {
    try {
      const r = await fetch('/api/history/' + idx + '/archive', { method: 'PATCH' });
      if (r.ok) ok++;
    } catch (err) { console.warn('[v3] archive idx', idx, err); }
  }
  return ok;
}

function _v3ExitPastManage() {
  pastSelectedIdxs.clear();
  pastManageMode = false;
  const btn = document.getElementById('past-manage-btn');
  if (btn) btn.textContent = 'Select';
}

window.bulkDeletePastSelected = async function() {
  const idxs = [...pastSelectedIdxs];
  if (idxs.length === 0) return;
  if (!confirm(`Delete ${idxs.length} campaign${idxs.length === 1 ? '' : 's'}? They'll be removed from the list.`)) return;
  const ok = await _v3ArchivePastIdxs(idxs);
  _v3ExitPastManage();
  if (typeof showCampaignToast === 'function') showCampaignToast(`Deleted ${ok}`);
  if (typeof window.renderPastSection === 'function') window.renderPastSection();
};

window.deleteAllPast = async function() {
  const all = (Array.isArray(_v3PastEntries) ? _v3PastEntries : []).map((p) => p._originalIdx);
  if (all.length === 0) return;
  if (!confirm(`Delete ALL ${all.length} past campaign${all.length === 1 ? '' : 's'}? This clears the Past list.`)) return;
  const ok = await _v3ArchivePastIdxs(all);
  _v3ExitPastManage();
  if (typeof showCampaignToast === 'function') showCampaignToast(`Deleted ${ok}`);
  if (typeof window.renderPastSection === 'function') window.renderPastSection();
};

// Bug 13: clear the whole queue (per-item Remove already exists on each card).
window.dashClearQueue = async function() {
  let items = [];
  try {
    const r = await fetch('/api/queue');
    const data = await r.json();
    items = Array.isArray(data?.queue) ? data.queue : [];
  } catch (err) { console.warn('[v3] dashClearQueue fetch', err); }
  if (items.length === 0) return;
  if (!confirm(`Clear all ${items.length} queued campaign${items.length === 1 ? '' : 's'}?`)) return;
  for (const q of items) {
    if (!q || !q.id) continue;
    try { await fetch('/api/queue/' + encodeURIComponent(q.id), { method: 'DELETE' }); }
    catch (err) { console.warn('[v3] dashClearQueue delete', q.id, err); }
  }
  if (typeof showCampaignToast === 'function') showCampaignToast('Queue cleared');
  if (typeof window.renderUpNextDeck === 'function') window.renderUpNextDeck();
};

// toggleDock — shared dock open/close + click-outside dismissal. Used by Active,
// Monitoring, Up Next item docks, and Past row docks.
if (typeof window.toggleDock !== 'function') {
  window.toggleDock = function(idOrEl, e) {
    if (e && e.stopPropagation) e.stopPropagation();
    const dock = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : (idOrEl && idOrEl.closest && idOrEl.closest('.dock'));
    if (!dock) return;
    const opening = dock.getAttribute('data-open') !== 'true';
    document.querySelectorAll('.dock[data-open="true"]').forEach(d => {
      if (d !== dock) {
        d.setAttribute('data-open', 'false');
        const trig = d.querySelector('.dock-trigger');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      }
    });
    dock.setAttribute('data-open', opening ? 'true' : 'false');
    const trig = dock.querySelector('.dock-trigger');
    if (trig) trig.setAttribute('aria-expanded', opening ? 'true' : 'false');
  };
  // Click-outside dismissal
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.dock[data-open="true"]').forEach(dock => {
      if (!dock.contains(e.target)) {
        dock.setAttribute('data-open', 'false');
        const trig = dock.querySelector('.dock-trigger');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      }
    });
  });
}

/* ── Global tooltip for [data-tip] attributes ──────────────────────────
   v0.3 markup decorates dock buttons / toggles with data-tip="…". This
   listener pops a small fixed-position bubble on hover so the tip text
   shows up. CSS at body[data-dashboard='v3'] .global-tip in
   dashboard-v0.3.css. */
if (!window.__v3TipWired) {
  window.__v3TipWired = true;
  const _v3Tip = document.createElement('div');
  _v3Tip.className = 'global-tip';
  document.body.appendChild(_v3Tip);
  function _v3ShowTip(target) {
    const t = target.getAttribute && target.getAttribute('data-tip');
    if (!t) return;
    const r = target.getBoundingClientRect();
    _v3Tip.textContent = t;
    _v3Tip.style.left = (r.left + r.width / 2) + 'px';
    _v3Tip.style.top = r.top + 'px';
    _v3Tip.classList.add('show');
  }
  function _v3HideTip() { _v3Tip.classList.remove('show'); }
  document.addEventListener('mouseover', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-tip]');
    if (t) _v3ShowTip(t); else _v3HideTip();
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-tip]');
    if (t && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-tip]'))) _v3HideTip();
  });
  document.addEventListener('scroll', _v3HideTip, true);
}

// ─────────────────────────────────────────────────────────────────────────
// Floating live console — DOM glue. Pure helpers live in /js/live-console.mjs.
// Hooked into pollStatus() so it shares the existing 2s poll cadence.
// ─────────────────────────────────────────────────────────────────────────
function renderLiveConsole(s) {
  const root = document.getElementById('live-console');
  if (!root) return;

  const running = !!(s && s.running);
  const hasRoster = !!(s && Array.isArray(s.profileNames) && s.profileNames.length);
  const visible = shouldShowConsole({
    running,
    paused: !!(s && (s.paused || s.pauseRequested)),
    state: s && s.state,
    hasRoster,
  });

  if (!visible) {
    root.hidden = true;
    // Console is disappearing entirely (fully idle, no roster). Collapse back
    // to the lip so it re-appears as a lip next time, never auto-opened.
    if (_lcPrevRunning) _lcApplyState(false);
    _lcPrevRunning = running;
    return;
  }
  root.hidden = false;

  const pill = computePillState(s);

  // Helper: only write text if it changed, to avoid layout thrash.
  const setText = (sel, value) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const cached = _lcWriteCache[sel];
    if (cached === value) return;
    el.textContent = value;
    _lcWriteCache[sel] = value;
  };
  const setAttr = (sel, attr, value) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const key = `${sel}@${attr}`;
    if (_lcWriteCache[key] === value) return;
    if (value == null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
    _lcWriteCache[key] = value;
  };
  const setHidden = (sel, hide) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const key = `${sel}@hidden`;
    const v = hide ? '1' : '0';
    if (_lcWriteCache[key] === v) return;
    if (hide) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
    _lcWriteCache[key] = v;
  };

  // ── v2.59.26 redesign: state class drives lip/head colours; drawer body is
  // a mini dashboard card (shared buildLiveActivity live line + countdown). ──
  const isMon = !s.running && s.state === 'monitoring';
  const isPaused = !!(s.paused || s.pauseRequested);
  const isRunning = !!s.running && !isPaused;
  const isWarn = !!((s.throttle && s.throttle.active) || (Array.isArray(s.parked) && s.parked.length));
  const stateClass = isMon ? 'lc-monitoring'
    : isPaused ? 'lc-paused'
    : isWarn ? 'lc-warn'
    : isRunning ? 'lc-running'
    : 'lc-idle';
  ['lc-monitoring', 'lc-running', 'lc-paused', 'lc-warn', 'lc-idle'].forEach((c) => {
    root.classList.toggle(c, c === stateClass);
  });

  // Head — status label + campaign name + mode badge.
  const statusLabel = isMon ? 'Monitoring' : isPaused ? 'Paused' : isRunning ? 'Running' : (pill.state || 'idle');
  setText('[data-lc="hstatus"]', statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1));
  setText('[data-lc="title"]', (pill.name && pill.name !== '—') ? pill.name.toUpperCase() : '(UNNAMED)');
  // Short mode tag ("C+D") — pill.mode can be the full mode string for modes
  // missing from MODE_LABELS, which overflowed the badge into the × button.
  setText('[data-lc="badge"]', (typeof v3ModeBadge === 'function') ? v3ModeBadge(s.mode) : pill.mode);

  // Mini card — the same live line as the dashboard card + big number.
  const la = buildLiveActivity(s);
  setText('[data-lc="live-ico"]', la.icon);
  setText('[data-lc="live-l1"]', la.l1);
  setText('[data-lc="live-l2"]', la.l2);
  let bigN = '—', bigU = '';
  if (isMon) {
    bigN = s.nextCheckAt ? v3FmtCountdown(new Date(s.nextCheckAt).getTime() - Date.now()) : '—';
    bigU = 'next check';
  } else if (isRunning || isPaused) {
    bigN = pill.total > 0 ? `${Math.round((pill.processed / pill.total) * 100)}%` : String(pill.processed);
    bigU = pill.total > 0 ? 'done' : 'sent';
  }
  setText('[data-lc="live-n"]', bigN);
  setText('[data-lc="live-u"]', bigU);

  // Mini stats line.
  const _sent = Number(s.totalProcessed) || pill.processed || 0;
  const _accepted = (s.acceptedCount != null ? s.acceptedCount : '—');
  let _statsHTML = `<b>${_sent}</b> sent · <b>${_accepted}</b> accepted`;
  if (isMon && s.monitoringUntil) {
    const _ends = new Date(s.monitoringUntil).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    _statsHTML += ` · ends <b>${_ends}</b>`;
  } else {
    const _acc = (Array.isArray(s.profileNames) ? s.profileNames.length : 0);
    _statsHTML += ` · <b>${_acc}</b> account${_acc === 1 ? '' : 's'}`;
  }
  const _statsEl = root.querySelector('[data-lc="mini-stats"]');
  if (_statsEl && _lcWriteCache['__mini_stats'] !== _statsHTML) {
    _statsEl.innerHTML = _statsHTML;
    _lcWriteCache['__mini_stats'] = _statsHTML;
  }

  // Selected GoLogin account roster — "who we selected", with the currently
  // acting account marked. Re-render only when the roster signature changes.
  const acctEl = root.querySelector('[data-lc="accounts"]');
  if (acctEl) {
    const accts = pill.accounts || [];
    const sig = accts.map((a) => (a.active ? '*' : '') + a.name).join('|');
    if (_lcWriteCache['__acct_sig'] !== sig) {
      acctEl.innerHTML = '';
      if (!accts.length) {
        acctEl.textContent = '—';
      } else {
        accts.forEach((a) => {
          const span = document.createElement('span');
          span.className = 'live-console__acct' + (a.active ? ' is-active' : '');
          span.textContent = a.name;
          acctEl.appendChild(span);
        });
      }
      _lcWriteCache['__acct_sig'] = sig;
    }
  }
  const sentStr = `${pill.processed} / ${pill.total}` +
    (pill.errSegment ? ` ${pill.errSegment}` : '') +
    (pill.parkedSegment ? ` ${pill.parkedSegment}` : '');
  setText('[data-lc="sent"]', sentStr);
  setText('[data-lc="state"]', `state · ${pill.state}`);

  // Cockpit ring (Variant B): fill % = sent / total, gold while running and
  // blue while monitoring. Center = processed count, caption = "of total".
  const ringEl = root.querySelector('[data-lc="ring"]');
  if (ringEl) {
    const pct = pill.total > 0
      ? Math.max(0, Math.min(100, Math.round((pill.processed / pill.total) * 100)))
      : 0;
    const accent = pill.state === 'monitoring' ? 'var(--blue)' : 'var(--gold)';
    const bg = `conic-gradient(${accent} 0 ${pct}%, rgba(255,255,255,0.10) ${pct}% 100%)`;
    if (_lcWriteCache['__ring_bg'] !== bg) {
      ringEl.style.background = bg;
      _lcWriteCache['__ring_bg'] = bg;
    }
  }
  setText('[data-lc="ring-num"]', String(pill.processed));
  setText('[data-lc="ring-cap"]', `of ${pill.total}`);

  // Log tail (3 lines)
  const logEl = root.querySelector('[data-lc="log"]');
  if (logEl) {
    const lines = pill.logs;
    const sig = lines.join('|');
    if (_lcWriteCache['__log_sig'] !== sig) {
      logEl.innerHTML = '';
      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'live-console__log-line' + (i === lines.length - 1 ? ' is-latest' : '');
        span.textContent = line;
        logEl.appendChild(span);
      });
      _lcWriteCache['__log_sig'] = sig;
    }
  }

  // Note: run-end collapse is handled in the !visible branch above. While the
  // console remains visible (running → monitoring, or roster staged), we keep
  // the operator's chosen expand state instead of force-collapsing.
  _lcPrevRunning = running;
}

// ── Live console: expand / collapse interaction ───────────────────────────
// The console is a LIP by default and only opens on an explicit click on the
// lip. It never restores an "expanded" state automatically — operator
// feedback was that an auto-opening drawer covered the dashboard. The drawer's
// × button (and a click on the dashboard link) collapses it back to the lip.

function _lcApplyState(expanded) {
  const root = document.getElementById('live-console');
  if (!root) return;
  root.classList.toggle('is-expanded', expanded);
  root.classList.toggle('is-collapsed', !expanded);
}

function _lcExpand()   { _lcApplyState(true);  }
function _lcCollapse() { _lcApplyState(false); }

function _lcInit() {
  const root = document.getElementById('live-console');
  if (!root) return;

  // Always start as a collapsed lip — never auto-open.
  _lcApplyState(false);

  // Click lip → expand. Click × (collapse) button → back to lip.
  // Click dashboard link → goDashboard() (defined elsewhere in app.js).
  const pillBtn = root.querySelector('[data-lc="pill"]');
  if (pillBtn) pillBtn.addEventListener('click', _lcExpand);

  const collapseBtn = root.querySelector('[data-lc="collapse"]');
  if (collapseBtn) collapseBtn.addEventListener('click', _lcCollapse);

  const dashLink = root.querySelector('[data-lc="dash"]');
  if (dashLink) dashLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (typeof goDashboard === 'function') goDashboard();
    else window.location.hash = '#/';
  });

  // Console visibility is route-independent now (it's a persistent monitor),
  // so the route change no longer toggles it — the 2s poll owns visibility.
  window.addEventListener('hashchange', () => {
    // v2.61: Live Status section also reacts to hash changes — switching
    // away from #/new or into a draft view must hide it immediately,
    // not wait for the next 2s poll tick.
    try { syncLiveStatusVisibility(); } catch {}
  });

  // v2.61: Initial sync so we don't flash the Live Status section on load
  // before the first 2s poll tick decides whether to hide it.
  try { syncLiveStatusVisibility(); } catch {}
}

// Initialize once DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _lcInit);
} else {
  _lcInit();
}

