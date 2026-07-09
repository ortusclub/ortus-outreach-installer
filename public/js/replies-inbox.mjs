/**
 * Replies inbox — the in-app Replies VIEW (sidebar → Review → Replies).
 *
 * Feature ⑨. Reads GET /api/replies (auto-classified inbound replies), sorts
 * "interested" to the top with a gold left rule, and lets the operator correct
 * a label (POST /api/replies/label). AI "Suggest reply" drafts are opt-in and
 * OFF by default (aiReplySuggestions pref); drafts are COPY-ONLY — there is no
 * path from a suggestion to any send.
 *
 * SECURITY: every reply text / lead name / AI draft is LinkedIn- or
 * model-sourced and therefore UNTRUSTED. This module NEVER interpolates those
 * fields into innerHTML — untrusted strings go through esc() (an escapeHTML
 * equivalent of app.js's escHtml) or textContent only.
 *
 * The dashboard's separate "Check DMs" scan panel lives in replies-panel.mjs
 * and is untouched by this module.
 */

// The five approved labels — display strings, matching CATEGORY_LABELS /
// isValidLabel in src/reply-classify.js (the label field from /api/replies is
// the display string, and POST /api/replies/label validates against these).
const LABELS = ['Interested', 'Not interested', 'Out of office', 'Question', 'Other'];

// Local HTML-escape — identical semantics to app.js escHtml(). Kept local so
// this ESM module has no import coupling to app.js's function scope.
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Only allow http(s) links from the (untrusted) linkedinUrl field — blocks a
// javascript:/data: href from executing on click. Returns '' when unsafe.
function safeHttpUrl(url) {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

let _mount = null;
let _state = { replies: [], ai: { optIn: false, keyPresent: false }, unseen: 0 };
let _loaded = false;
let _toastTimer = null;

/** Entry point — called by app.js's router when the #/replies route is shown. */
export async function initRepliesInbox(mount) {
  if (!mount) return;
  _mount = mount;
  await load();
}

async function load() {
  if (!_mount) return;
  if (!_loaded) renderShell('Loading replies…');
  try {
    const res = await fetch('/api/replies');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _state.replies = Array.isArray(data.replies) ? data.replies : [];
    _state.ai = data.ai || { optIn: false, keyPresent: false };
    _state.unseen = data.unseen || 0;
    _loaded = true;
    render();
  } catch (err) {
    renderShell(`Could not load replies — ${esc(err && err.message ? err.message : err)}`);
  }
}

// ── sorting: interested first, then the rest by recordedAt desc ──────────────
function sortReplies(list) {
  return list.slice().sort((a, b) => {
    const ai = a.label === 'Interested' ? 0 : 1;
    const bi = b.label === 'Interested' ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return (b.recordedAt || 0) - (a.recordedAt || 0);
  });
}

function relTime(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  if (delta < 2 * 86_400_000) return 'yesterday';
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} days ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

// A minimal shell used for loading / error states before data arrives.
function renderShell(message) {
  if (!_mount) return;
  _mount.innerHTML = `
    <div class="replies-wrap">
      <div class="replies-head">
        <span class="tag"><span class="dot"></span>Replies</span>
      </div>
      <div class="replies-title">Replies</div>
      <div class="replies-sub">${esc(message)}</div>
    </div>`;
}

function render() {
  if (!_mount) return;
  const sorted = sortReplies(_state.replies);
  const total = sorted.length;
  const interested = sorted.filter((r) => r.label === 'Interested').length;
  const aiOptIn = !!(_state.ai && _state.ai.optIn);

  const countPill = `${total} repl${total === 1 ? 'y' : 'ies'}${interested ? ` · ${interested} interested` : ''}`;

  const rowsHtml = total
    ? sorted.map(rowHtml).join('')
    : `<div class="replies-empty">No replies recorded yet. Replies are checked automatically every hour.</div>`;

  _mount.innerHTML = `
    <div class="replies-wrap">
      <div class="replies-head">
        <span class="tag"><span class="dot"></span>Replies</span>
        <label class="ai-toggle" title="AI reply drafts are opt-in and off by default. Drafts are copy-only — never sent.">
          <input type="checkbox" id="replies-ai-toggle" ${aiOptIn ? 'checked' : ''} />
          <span>AI reply drafts — off by default</span>
        </label>
        <span class="mark" id="replies-mark-read" role="button" tabindex="0">Mark all read</span>
      </div>
      <div class="replies-title">Replies <span class="replies-count-pill">${esc(countPill)}</span></div>
      <div class="replies-sub">Checked automatically every hour · every reply is also written to your Google Sheet.</div>
      <div class="replies-list">${rowsHtml}</div>
      <div class="replies-note">Labels assigned automatically from reply text · click a label to correct it.</div>
    </div>`;

  wire();
}

function rowHtml(r) {
  const isInterested = r.label === 'Interested';
  const isSeen = !!r.seen;
  // dashed "check" chip: low-confidence AND still an automatic label.
  const lowConf = r.labelConfidence !== 'high' && r.labelSource === 'auto';
  const isAuto = r.labelSource === 'auto';
  const key = esc(r.key || '');

  const chipClasses = ['lbl-chip'];
  if (isInterested) chipClasses.push('interested');
  if (lowConf) chipClasses.push('lowconf');
  chipClasses.push(isAuto ? 'auto' : 'manual');

  const menuItems = LABELS.map(
    (l) => `<button type="button" class="lbl-item" data-label="${esc(l)}">${esc(l)}</button>`,
  ).join('');

  // Lead name → linkedinUrl (new tab). Untrusted name via esc(); href limited
  // to http(s) and escaped so a hostile URL can neither execute nor break out.
  const safeUrl = safeHttpUrl(r.linkedinUrl);
  const nameHtml = safeUrl
    ? `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.leadName || '(unknown)')}</a>`
    : esc(r.leadName || '(unknown)');

  const suspected = r.suspected
    ? `<span class="reply-suspected" title="Same-name match — verify this is the right person">SUSPECTED · same name</span>`
    : '';

  const via = r.profileName
    ? `via <strong>${esc(r.profileName)}</strong>${r.campaign ? ` · ${esc(r.campaign)}` : ''}`
    : (r.campaign ? esc(r.campaign) : '');

  // AI "Suggest reply" — only when the opt-in is on. Copy-only.
  const suggestBtn = (_state.ai && _state.ai.optIn)
    ? `<button type="button" class="reply-suggest" data-key="${key}">Suggest reply</button>`
    : '';

  const confHint = lowConf ? ` <span class="lbl-conf">· check</span>` : '';

  return `
    <div class="reply-item${isInterested ? ' interested' : ''}${isSeen ? ' seen' : ''}" data-key="${key}">
      <div class="reply-row1">
        <strong>${nameHtml}</strong>
        <span class="reply-when">${esc(relTime(r.recordedAt))}</span>
      </div>
      <div class="reply-sub">${via} ${suspected}</div>
      <div class="reply-msg">${esc(r.text || '')}</div>
      <div class="reply-foot">
        <span class="lbl" data-key="${key}">
          <button type="button" class="${chipClasses.join(' ')}"><span class="ldot"></span>${esc(r.label || 'Other')}${confHint}</button>
          <span class="lbl-menu">${menuItems}</span>
        </span>
        ${suggestBtn}
        ${safeUrl ? `<a class="reply-open" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">Open thread ↗</a>` : ''}
      </div>
      <div class="reply-draft" hidden></div>
    </div>`;
}

// ── event wiring (delegated where possible) ──────────────────────────────────
function wire() {
  if (!_mount) return;

  const markBtn = _mount.querySelector('#replies-mark-read');
  if (markBtn) {
    markBtn.addEventListener('click', markAllRead);
    markBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); markAllRead(); } });
  }

  const aiToggle = _mount.querySelector('#replies-ai-toggle');
  if (aiToggle) aiToggle.addEventListener('change', () => setAiPref(aiToggle.checked));

  // label chip open/close
  _mount.querySelectorAll('.lbl-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const l = chip.closest('.lbl');
      const wasOpen = l.classList.contains('open');
      closeAllMenus();
      if (!wasOpen) l.classList.add('open');
    });
  });

  // label pick
  _mount.querySelectorAll('.lbl-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const l = item.closest('.lbl');
      const key = l ? l.getAttribute('data-key') : '';
      const label = item.getAttribute('data-label');
      closeAllMenus();
      if (key && label) correctLabel(key, label);
    });
  });

  // suggest buttons
  _mount.querySelectorAll('.reply-suggest').forEach((btn) => {
    btn.addEventListener('click', () => suggest(btn));
  });

  // close menus on outside click — bound ONCE for the module's lifetime, not
  // per render (render() re-runs after every label edit / toggle / mark-read,
  // so binding here each time would leak a duplicate document listener).
  if (!_docClickBound) { document.addEventListener('click', closeAllMenus); _docClickBound = true; }
}
let _docClickBound = false;

function closeAllMenus() {
  if (!_mount) return;
  _mount.querySelectorAll('.lbl.open').forEach((x) => x.classList.remove('open'));
}

async function markAllRead() {
  try {
    const res = await fetch('/api/replies/seen', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('Marked all read');
    await load();
  } catch (err) {
    toast(`Could not mark read — ${err && err.message ? err.message : err}`);
  }
}

async function correctLabel(key, label) {
  try {
    const res = await fetch('/api/replies/label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, label }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    toast(`Corrected to "${label}"`);
    await load();
  } catch (err) {
    toast(`Could not save label — ${err && err.message ? err.message : err}`);
  }
}

// AI opt-in: GET the full prefs object, spread it, set only aiReplySuggestions,
// POST it back — never drop the operator's other notification prefs.
async function setAiPref(on) {
  try {
    const getRes = await fetch('/api/notification-prefs');
    const getData = await getRes.json().catch(() => ({}));
    const prefs = (getData && getData.prefs) || {};
    const next = { ...prefs, aiReplySuggestions: !!on };
    const postRes = await fetch('/api/notification-prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!postRes.ok) throw new Error(`HTTP ${postRes.status}`);
    toast(on ? 'AI reply drafts on (copy-only)' : 'AI reply drafts off');
    // Reload so ai.optIn flips and the Suggest buttons appear/disappear.
    await load();
  } catch (err) {
    toast(`Could not update setting — ${err && err.message ? err.message : err}`);
    // Revert the checkbox on failure.
    const t = _mount && _mount.querySelector('#replies-ai-toggle');
    if (t) t.checked = !on;
  }
}

async function suggest(btn) {
  const key = btn.getAttribute('data-key');
  if (!key) return;
  const item = btn.closest('.reply-item');
  const draftBox = item ? item.querySelector('.reply-draft') : null;
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Drafting…';
  try {
    const res = await fetch('/api/replies/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (draftBox) renderDraft(draftBox, data.suggestion || '');
  } catch (err) {
    toast(err && err.message ? err.message : String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

// Render the AI draft with a Copy button. The draft is model-sourced and
// UNTRUSTED — it goes into the DOM via textContent, never innerHTML.
function renderDraft(box, suggestion) {
  box.hidden = false;
  box.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'reply-draft-label';
  label.textContent = 'AI draft — copy-only, review before sending manually';
  const text = document.createElement('div');
  text.className = 'reply-draft-text';
  text.textContent = suggestion;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'reply-draft-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(suggestion);
      toast('Draft copied');
    } catch {
      toast('Copy failed — select the text and copy manually');
    }
  });
  box.appendChild(label);
  box.appendChild(text);
  box.appendChild(copy);
}

function toast(msg) {
  let t = document.getElementById('replies-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'replies-toast';
    t.className = 'replies-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
