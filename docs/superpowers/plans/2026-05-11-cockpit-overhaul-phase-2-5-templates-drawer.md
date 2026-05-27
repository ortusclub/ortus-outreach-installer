# Cockpit Overhaul — Phase 2.5 (Templates Drawer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline drawer between Forecast and Launch carrying the mode's templates + advanced settings (Preflight, Hyper, Intro mode fields). Session-only edits drive the next launch; explicit `Save as preset` writes back to drafts. Disabled Launch + visible prompt when no draft exists for the chosen mode.

**Architecture:** New `.drawer-strip` + `.drawer-body` atoms in `cockpit.css`. New section in `cockpit.js` with `state.template`, mode-aware renderer, advanced toggle pills, draft save/load. Drawer block inserted between Forecast and Launch in index.html. Backend untouched — existing `/api/drafts` CRUD + existing `/api/campaign/start` payload shape unchanged.

**Tech Stack:** Vanilla JS, existing `/api/drafts` endpoints. No new deps.

**Branch:** `feature/cockpit-overhaul` (continues from Phase 2).

**Scope cuts (locked):**
- Save behavior: session-only by default (Q1=b). Explicit `Save as preset` button on drawer creates/updates a draft.
- No dedicated `/templates` library route (Q2=a) — drawer only. Library can be a follow-up.
- `post_amp` mode template surface deferred — drawer is hidden for post_amp until a follow-up phase.
- `check_status` and `check_dms` modes do not need templates — drawer is hidden.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `public/css/cockpit.css` | modify | Add `.drawer-strip`, `.drawer-body`, `.drawer-row`, `.toggle-pills`, `.empty-state` atoms |
| `public/index.html` | modify | Add drawer block between `#ck-forecast` and `.launch-row` |
| `public/js/cockpit.js` | modify | Drawer state, renderer, advanced toggles, save/load, empty state, launch wiring |

---

## Mode-aware drawer contents

| Mode | Fields | Advanced toggles |
|---|---|---|
| `connect_only` | Connection note | Hyper |
| `check_status` | — (drawer hidden) | — |
| `message_only` | DM body | Preflight, Hyper |
| `introduce_back` | Intro name, Intro title, IC body | Preflight |
| `inmail_only` | InMail subject, InMail body | — |
| `open_profile_only` | OP subject, OP body | — |
| `check_dms` | — (drawer hidden) | — |
| `post_amp` | — (drawer hidden, deferred) | — |

---

## Task 1 — CSS atoms

**Files:**
- Modify: `public/css/cockpit.css` (append at end)

- [ ] **Step 1.1 — Append drawer atoms**

```css
/* ── Templates drawer (Phase 2.5) ──────────────────────────────── */
#cockpit-view .drawer-strip {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border: 1px solid var(--hairline);
  transition: opacity 0.15s;
}
#cockpit-view .drawer-strip .title {
  font-family: var(--display); font-size: 1rem;
  letter-spacing: 0.02em; text-transform: uppercase;
}
#cockpit-view .drawer-strip .sub {
  font-family: var(--mono); font-size: 0.54rem;
  letter-spacing: 0.16em; color: var(--gray); text-transform: uppercase;
}
#cockpit-view .drawer-strip .right {
  margin-left: auto; display: flex; gap: 8px; align-items: center;
}
#cockpit-view .drawer-strip.expanded {
  border-color: var(--ink); background: var(--hairline-soft);
  border-bottom: none;
}

#cockpit-view .drawer-body {
  border: 1px solid var(--ink); border-top: none;
  padding: 18px 22px; display: grid; gap: 14px;
  background: var(--hairline-soft);
}
#cockpit-view .drawer-row {
  display: grid; grid-template-columns: 130px 1fr;
  gap: 12px; align-items: start;
}
#cockpit-view .drawer-row .lbl {
  font-family: var(--mono); font-size: 0.54rem;
  letter-spacing: 0.18em; color: var(--gray);
  text-transform: uppercase; padding-top: 8px;
}
#cockpit-view .drawer-body textarea {
  background: transparent; color: var(--ink);
  border: 1px solid var(--hairline);
  padding: 8px 10px; width: 100%;
  font-family: var(--mono); font-size: 0.78rem; line-height: 1.5;
  resize: vertical; min-height: 72px; outline: none;
}
#cockpit-view .drawer-body textarea:focus { border-color: var(--ink); }
#cockpit-view .drawer-body input.cockpit-input {
  border-bottom: 1px solid var(--hairline);
  padding: 6px 0; font-size: 0.85rem;
}

#cockpit-view .toggle-pills {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
}
#cockpit-view .toggle-pills .help {
  font-family: var(--mono); font-size: 0.5rem;
  letter-spacing: 0.14em; color: var(--gray);
  text-transform: uppercase;
}
#cockpit-view .drawer-strip .pill .dot {
  width: 6px; height: 6px; border-radius: 9999px;
  background: var(--gray); display: inline-block; margin-right: 6px;
}
#cockpit-view .drawer-strip .pill.on .dot { background: var(--green); }
#cockpit-view .drawer-strip .pill.gold .dot { background: var(--gold); }

#cockpit-view .drawer-save-row {
  display: flex; gap: 10px; padding-top: 12px;
  border-top: 1px solid var(--hairline-soft);
}
#cockpit-view .drawer-save-row .meta {
  margin-left: auto; align-self: center;
  font-family: var(--mono); font-size: 0.5rem;
  letter-spacing: 0.14em; color: var(--gray); text-transform: uppercase;
}

#cockpit-view .empty-state {
  padding: 20px; border: 1px dashed var(--hairline);
}
#cockpit-view .empty-state .lbl {
  font-family: var(--mono); font-size: 0.6rem;
  letter-spacing: 0.2em; color: var(--gold);
  text-transform: uppercase; margin-bottom: 8px;
}
#cockpit-view .empty-state .body {
  font-size: 0.78rem; color: var(--gray); line-height: 1.5;
}
#cockpit-view .empty-state-actions {
  margin-top: 12px; display: flex; gap: 8px;
}
```

- [ ] **Step 1.2 — Commit**

```bash
git add public/css/cockpit.css
git commit -m "cockpit(2.5): add drawer atoms (strip, body, toggle pills, empty state)"
```

---

## Task 2 — HTML drawer block

**Files:**
- Modify: `public/index.html` — add the drawer block immediately after `<div class="forecast" id="ck-forecast">` and before `<div class="launch-row">`.

- [ ] **Step 2.1 — Insert the block**

```html
<!-- Templates + advanced drawer (Phase 2.5) — mode-aware contents -->
<div id="ck-drawer-strip" class="drawer-strip" style="display:none;">
  <span class="title">Templates</span>
  <span class="sub" id="ck-drawer-sub">—</span>
  <div class="right" id="ck-drawer-advanced"><!-- toggle pills rendered by JS --></div>
  <button class="pill" id="ck-drawer-toggle" type="button">Edit ▾</button>
</div>
<div id="ck-drawer-body" class="drawer-body" style="display:none;">
  <!-- mode-aware field rows rendered by JS -->
</div>
<div id="ck-empty-state" class="empty-state" style="display:none;">
  <div class="lbl" id="ck-empty-state-label">No template saved for this mode yet</div>
  <div class="body">Set up the template before launching. Saved templates auto-load on the next campaign of this mode.</div>
  <div class="empty-state-actions">
    <button class="pill" id="ck-empty-setup" type="button">Set up template ▾</button>
    <button class="pill" id="ck-empty-copy" type="button">Copy from another mode →</button>
  </div>
</div>
```

- [ ] **Step 2.2 — Verify + commit**

```bash
git add public/index.html
git commit -m "cockpit(2.5): add drawer + empty-state HTML block (post-forecast)"
```

---

## Task 3 — Drawer state + mode → draft loading

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 3.1 — Extend state shape**

Add to the `state` object at top of cockpit.js:

```js
template: {
  loadedDraftId: null,
  loadedDraftName: '',
  fields: {},          // mode-specific keys (connectionNote, dmBody, icBody, intro*, inmail*, op*)
  toggles: {
    preflightCheckStatus: false,
    hyperPersonalise: false,
  },
  dirty: false,        // edited but not saved
},
drawerExpanded: false,
```

- [ ] **Step 3.2 — Define mode → field schemas**

```js
const MODE_TEMPLATE_SCHEMAS = {
  connect_only:      { fields: ['connectionNote'], toggles: ['hyper'] },
  check_status:      null,                          // drawer hidden
  message_only:      { fields: ['dmBody'], toggles: ['preflight', 'hyper'] },
  introduce_back:    { fields: ['introName', 'introTitle', 'icBody'], toggles: ['preflight'] },
  inmail_only:       { fields: ['inmailSubject', 'inmailBody'], toggles: [] },
  open_profile_only: { fields: ['opSubject', 'opBody'], toggles: [] },
  check_dms:         null,                          // drawer hidden
  post_amp:          null,                          // deferred
};

const FIELD_LABELS = {
  connectionNote: 'Connection note',
  dmBody:         'DM body',
  icBody:         'IC body',
  introName:      'Intro from',
  introTitle:     'Intro title',
  inmailSubject:  'InMail subject',
  inmailBody:     'InMail body',
  opSubject:      'OP subject',
  opBody:         'OP body',
};

const FIELD_PLACEHOLDERS = {
  connectionNote: 'Hi {first name}, …',
  dmBody:         'Hi {first name}, …',
  icBody:         'Hi {first name}, meet {intro name} — …',
  introName:      'Your name (e.g. Antonio Varlese)',
  introTitle:     'Introduction: {first name} <> {intro name}',
  inmailSubject:  'Quick thought',
  inmailBody:     '…',
  opSubject:      'Quick thought',
  opBody:         '…',
};
```

- [ ] **Step 3.3 — Mode → draft loader**

```js
// Drafts use the existing wizard schema. Map cockpit field keys to draft
// keys (preserve wizard's exact field names so the same draft works in
// both surfaces).
const COCKPIT_TO_DRAFT_KEY = {
  connectionNote: 'connectionNote',
  dmBody:         'followUpMessage',
  icBody:         'icBody',
  introName:      'introName',
  introTitle:     'introTitle',
  inmailSubject:  'inmailSubject',
  inmailBody:     'inmailBody',
  opSubject:      'openProfileSubject',
  opBody:         'openProfileBody',
};

async function loadTemplateForMode(mode) {
  state.template.fields = {};
  state.template.loadedDraftId = null;
  state.template.loadedDraftName = '';
  state.template.dirty = false;
  const schema = MODE_TEMPLATE_SCHEMAS[mode];
  if (!schema) return;
  try {
    const r = await fetch('/api/drafts');
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.drafts || []);
    const draft = list
      .filter(d => d.mode === mode)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!draft) return;
    state.template.loadedDraftId = draft.id;
    state.template.loadedDraftName = draft.name || `${mode} default`;
    const t = draft.templates || draft;
    for (const f of schema.fields) {
      const draftKey = COCKPIT_TO_DRAFT_KEY[f];
      state.template.fields[f] = (t[draftKey] || draft[f] || '').toString();
    }
    // Toggles from draft (if present) — defaults false
    state.template.toggles.preflightCheckStatus = !!draft.preflightCheckStatus;
    state.template.toggles.hyperPersonalise = !!draft.hyperPersonalise;
  } catch (err) {
    console.warn('[cockpit] template load failed', err);
  }
}
```

- [ ] **Step 3.4 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): state + mode→draft loader + field schemas"
```

---

## Task 4 — Drawer renderer (collapsed strip + expanded body)

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 4.1 — Render functions**

```js
function renderDrawer() {
  const strip = $('#ck-drawer-strip');
  const body  = $('#ck-drawer-body');
  const empty = $('#ck-empty-state');
  const schema = MODE_TEMPLATE_SCHEMAS[state.mode];

  // Hide everything when the mode doesn't take templates
  if (!schema) {
    strip.style.display = 'none';
    body.style.display = 'none';
    empty.style.display = 'none';
    return;
  }
  // Empty state when there's a schema but no loaded draft
  if (!state.template.loadedDraftId && !state.template.fields.connectionNote && !state.template.fields.dmBody && !state.template.fields.icBody && !state.template.fields.inmailBody && !state.template.fields.opBody) {
    strip.style.display = 'none';
    body.style.display = 'none';
    empty.style.display = '';
    $('#ck-empty-state-label').textContent = `No template saved for ${state.mode.replace('_', ' ')} yet`;
    return;
  }

  empty.style.display = 'none';
  strip.style.display = '';
  strip.classList.toggle('expanded', state.drawerExpanded);
  body.style.display = state.drawerExpanded ? '' : 'none';

  $('#ck-drawer-sub').textContent = state.template.loadedDraftName +
    (state.template.dirty ? ' · edited (not saved)' : '');
  $('#ck-drawer-toggle').textContent = state.drawerExpanded ? 'Edit ▴' : 'Edit ▾';

  renderAdvancedPills(schema);
  if (state.drawerExpanded) renderDrawerBody(schema);
}

function renderDrawerBody(schema) {
  const body = $('#ck-drawer-body');
  body.innerHTML = `
    ${schema.fields.map(f => `
      <div class="drawer-row">
        <span class="lbl">${FIELD_LABELS[f] || f}</span>
        ${isShortField(f)
          ? `<input type="text" class="cockpit-input" data-field="${f}" placeholder="${FIELD_PLACEHOLDERS[f] || ''}" value="${escapeHtml(state.template.fields[f] || '')}" />`
          : `<textarea data-field="${f}" placeholder="${FIELD_PLACEHOLDERS[f] || ''}">${escapeHtml(state.template.fields[f] || '')}</textarea>`}
      </div>`).join('')}
    <div class="drawer-save-row">
      <button class="pill" id="ck-save-changes" type="button" ${state.template.loadedDraftId ? '' : 'disabled'}>Save changes</button>
      <button class="pill" id="ck-save-as-preset" type="button">Save as new preset</button>
      <span class="meta">Edits stay session-only until you save</span>
    </div>`;

  body.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('input', e => {
      state.template.fields[e.target.dataset.field] = e.target.value;
      state.template.dirty = true;
      $('#ck-drawer-sub').textContent = state.template.loadedDraftName + ' · edited (not saved)';
    });
  });
  $('#ck-save-changes')?.addEventListener('click', () => saveDraftChanges());
  $('#ck-save-as-preset')?.addEventListener('click', () => saveDraftAsNew());
}

function isShortField(f) {
  return f === 'introName' || f === 'introTitle' || f === 'inmailSubject' || f === 'opSubject';
}

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 4.2 — Wire drawer toggle**

```js
function initDrawer() {
  $('#ck-drawer-toggle').addEventListener('click', () => {
    state.drawerExpanded = !state.drawerExpanded;
    renderDrawer();
  });
  $('#ck-empty-setup').addEventListener('click', () => {
    // Operator wants to create a template inline: pretend a stub draft exists
    // so the body renders, drawer expands, and Save as preset becomes the
    // commit path.
    state.template.loadedDraftName = `${state.mode.replace('_', ' ')} · new`;
    state.drawerExpanded = true;
    state.template.dirty = true;
    renderDrawer();
  });
  $('#ck-empty-copy').addEventListener('click', () => {
    alert('Copy from another mode — coming in a follow-up. For now: switch modes, edit the template, then return.');
  });
}
```

- [ ] **Step 4.3 — Wire mode-change to refresh drawer**

In the mode picker click handler (`renderModeGrid` button listener), after setting `state.mode` and refreshing summary/forecast, also:

```js
await loadTemplateForMode(state.mode);
state.drawerExpanded = false;
renderDrawer();
updateLaunchEnabled();
```

Make the click handler async if it isn't already.

- [ ] **Step 4.4 — Call from init**

In `init()`, after `applyModeVisibility()`:

```js
await loadTemplateForMode(state.mode);
renderDrawer();
initDrawer();
```

- [ ] **Step 4.5 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): drawer renderer + empty state + mode-change handler"
```

---

## Task 5 — Advanced toggle pills (Preflight / Hyper)

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 5.1 — Render pills**

```js
const TOGGLE_LABELS = {
  preflight: 'Preflight',
  hyper:     'Hyper',
};
const TOGGLE_STATE_KEY = {
  preflight: 'preflightCheckStatus',
  hyper:     'hyperPersonalise',
};

function renderAdvancedPills(schema) {
  const host = $('#ck-drawer-advanced');
  if (!host) return;
  if (!schema.toggles || schema.toggles.length === 0) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = schema.toggles.map(t => {
    const stateKey = TOGGLE_STATE_KEY[t];
    const on = !!state.template.toggles[stateKey];
    return `<button class="pill ${on ? 'on' : ''}" data-toggle="${t}" type="button"><span class="dot"></span>${TOGGLE_LABELS[t]}</button>`;
  }).join('');
  host.querySelectorAll('button[data-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation(); // don't toggle the drawer below
      const t = btn.dataset.toggle;
      const stateKey = TOGGLE_STATE_KEY[t];
      state.template.toggles[stateKey] = !state.template.toggles[stateKey];
      state.template.dirty = true;
      renderDrawer();
    });
  });
}
```

- [ ] **Step 5.2 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): advanced toggle pills (Preflight, Hyper)"
```

---

## Task 6 — Disabled Launch + empty-state gating

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 6.1 — Extend `updateLaunchEnabled`**

```js
function updateLaunchEnabled() {
  const btn = $('#ck-launch');
  if (!btn) return;
  const sheetDriven = SHEET_DRIVEN_MODES.has(state.mode);
  const accountsOk = sheetDriven || state.selectedAccounts.size > 0;
  // Templates required for any mode that has a schema. check_status /
  // check_dms / post_amp don't need templates (schema is null).
  const schema = MODE_TEMPLATE_SCHEMAS[state.mode];
  const templatesOk = !schema || schema.fields.some(f => (state.template.fields[f] || '').trim());
  const ready = state.mode && state.sheetUrl && state.urlColumn && accountsOk && templatesOk;
  btn.disabled = !ready;
  if (!ready) {
    if (!templatesOk) $('#ck-launch-meta').textContent = 'templates required for this mode';
    else if (sheetDriven) $('#ck-launch-meta').textContent = 'paste a sheet to enable';
    else $('#ck-launch-meta').textContent = 'pick mode + sheet + accounts to enable';
  } else {
    $('#ck-launch-meta').textContent = 'ready · ⌘↩ to launch';
  }
}
```

- [ ] **Step 6.2 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): require templates for template-mode launches"
```

---

## Task 7 — Save as preset / Save changes

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 7.1 — Save handlers**

```js
function buildDraftPayloadFromState() {
  const draftTemplates = {};
  for (const [cockpitKey, draftKey] of Object.entries(COCKPIT_TO_DRAFT_KEY)) {
    if (state.template.fields[cockpitKey] !== undefined) {
      draftTemplates[draftKey] = state.template.fields[cockpitKey];
    }
  }
  return {
    mode: state.mode,
    templates: draftTemplates,
    introName: state.template.fields.introName || '',
    introTitle: state.template.fields.introTitle || '',
    preflightCheckStatus: !!state.template.toggles.preflightCheckStatus,
    hyperPersonalise: !!state.template.toggles.hyperPersonalise,
  };
}

async function saveDraftChanges() {
  if (!state.template.loadedDraftId) return;
  const payload = buildDraftPayloadFromState();
  try {
    const r = await fetch('/api/drafts/' + encodeURIComponent(state.template.loadedDraftId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.template.dirty = false;
    renderDrawer();
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function saveDraftAsNew() {
  const name = prompt('Name this preset:', state.template.loadedDraftName || `${state.mode} v1`);
  if (!name) return;
  const payload = { ...buildDraftPayloadFromState(), name };
  try {
    const r = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    state.template.loadedDraftId = data.id || data.draft?.id || null;
    state.template.loadedDraftName = name;
    state.template.dirty = false;
    renderDrawer();
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}
```

- [ ] **Step 7.2 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): Save as preset + Save changes — drafts CRUD"
```

---

## Task 8 — Launch payload pulls drawer state

**Files:**
- Modify: `public/js/cockpit.js` (the `launch()` function)

- [ ] **Step 8.1 — Replace the launch payload's `templates` / `introName` / `introTitle` / `preflightCheckStatus` keys with drawer state**

```js
async function launch() {
  const btn = $('#ck-launch');
  btn.disabled = true; btn.textContent = '…launching';
  const senderFirstNames = {};
  const profilesById = new Map(state.allProfiles.map(p => [p.id, p]));
  for (const id of state.selectedAccounts) {
    const p = profilesById.get(id);
    const name = p ? (p.name || id) : id;
    senderFirstNames[id] = typeof window.resolveSenderFirstName === 'function'
      ? (window.resolveSenderFirstName(id, name) || '')
      : '';
  }
  // Map cockpit field keys to wizard template keys for the campaign payload
  const wizardTemplates = {};
  for (const [cockpitKey, draftKey] of Object.entries(COCKPIT_TO_DRAFT_KEY)) {
    if (state.template.fields[cockpitKey] !== undefined) {
      wizardTemplates[draftKey] = state.template.fields[cockpitKey];
    }
  }
  const payload = {
    mode: state.mode,
    sheetUrl: state.sheetUrl,
    profileIds: [...state.selectedAccounts],
    linkedinColumn: state.urlColumn,
    dailyLimit: state.pace.maxActions,
    delayMin: state.pace.pauseMin,
    delayMax: state.pace.pauseMax,
    concurrency: state.pace.parallel,
    name: state.campaignName || '',
    templates: wizardTemplates,
    senderFirstNames,
    introMode: state.mode === 'introduce_back',
    introName: state.template.fields.introName || '',
    introTitle: state.template.fields.introTitle || 'Introduction: {first name} <> {intro name}',
    preflightCheckStatus: !!state.template.toggles.preflightCheckStatus,
    messageOpenProfiles: false,
  };
  try {
    const r = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) { alert('Error: ' + data.error); btn.disabled = false; btn.textContent = '▶ Launch'; return; }
    if (!data.ok) { alert(data.message || 'Could not start.'); btn.disabled = false; btn.textContent = '▶ Launch'; return; }
    window.location.hash = '#/';
  } catch (err) {
    alert('Launch failed: ' + err.message);
    btn.disabled = false; btn.textContent = '▶ Launch';
  }
}
```

(Remove the now-unused `loadLatestDraftForMode` call from inside `launch()` — its job is now done by `loadTemplateForMode()` on mode change.)

- [ ] **Step 8.2 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit(2.5): launch payload reads drawer state instead of last draft"
```

---

## Task 9 — Smoke test + restart

- [ ] **Step 9.1 — Restart dev:app**

```bash
pkill -f "npm run dev:app" 2>/dev/null
pkill -f "electron" 2>/dev/null
sleep 2
npm run dev:app > /tmp/ortus-dev.log 2>&1 &
```

- [ ] **Step 9.2 — Manual smoke**

1. Open `#/cockpit`. Pick **Connect** mode. Drawer should appear with the latest Connect draft loaded; if no draft exists, empty-state card shows + Launch disabled.
2. Click **Edit ▾**. Drawer expands. Edit the connection note. Strip subtitle shows `… · edited (not saved)`.
3. Toggle **Hyper** pill. Strip shows the dot turning green. Closing/opening drawer preserves state.
4. Click **Save as new preset**. Prompt → enter a name → check `/api/drafts` returned a new id, strip subtitle drops `edited`.
5. Switch to **Intro back** mode. Drawer reloads with intro-back draft (or empty state). Intro from / Intro title / IC body fields appear.
6. Toggle **Preflight** pill. Launch a campaign and watch the log — `preflightCheckStatus: true` should be honored server-side.
7. Switch to **Check Status**. Drawer hides entirely. Launch enables off sheet URL alone.
8. Switch to **Check DMs**. Same — drawer hidden.

- [ ] **Step 9.3 — Commit (if anything else needs tweaks)**

---

## Definition of Done (Phase 2.5)

- [ ] Drawer atoms in `cockpit.css`
- [ ] Drawer HTML block in `index.html`
- [ ] State + mode→draft loader wired
- [ ] Drawer renderer (collapsed strip + expanded body) mode-aware
- [ ] Advanced toggle pills (Preflight, Hyper) wired into launch payload
- [ ] Empty-state card with disabled Launch when no template exists
- [ ] `Save as new preset` POST /api/drafts works
- [ ] `Save changes` PUT /api/drafts/:id works
- [ ] Launch payload reads from `state.template`, not from a fresh draft fetch
- [ ] check_status / check_dms / post_amp modes show no drawer + launch enables without templates
- [ ] Manual smoke test passes end-to-end

**No backend changes.** Phase 3 (Dashboard rows redesign) comes next.

---

## Self-Review Notes

- Field keys and label maps are defined once at the top of cockpit.js — adding a new mode = adding one schema entry + one label.
- `COCKPIT_TO_DRAFT_KEY` keeps cockpit's field names independent of the wizard's draft schema (compatibility shim). Same draft works in both surfaces.
- Session-only behavior: `state.template.dirty` flag drives the "edited (not saved)" badge; nothing writes to drafts unless the operator clicks Save.
- Empty state heuristic uses `loadedDraftId || any non-empty field` — covers both "no draft on server" and "operator clicked Setup ▾ to start from scratch."
- Toggle pills bubble: `e.stopPropagation()` on the toggle click prevents the drawer-strip click handler from also firing.
- No new dependencies. No new tests (UI; matches Phase 2 convention).
- Rollback: revert the Phase 2.5 commits → drawer disappears, cockpit launches with empty templates again (matching Phase 2 behavior).
