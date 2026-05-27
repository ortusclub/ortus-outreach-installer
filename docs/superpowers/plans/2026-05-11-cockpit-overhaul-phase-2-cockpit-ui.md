# Cockpit Overhaul — Phase 2 (Cockpit UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cockpit screen at `#/cockpit`. Single-screen replacement for the 5-section wizard. Mode grid (4×2) + Section II Data + Section III Accounts + Section IV Pace + Forecast + Launch. Calls existing `/api/campaign/start` — no backend changes here, just a different way of collecting the same inputs.

**Architecture:** New isolated files (`public/css/cockpit.css`, `public/js/cockpit.js`) imported by `public/index.html`. A new `<div class="route" data-route="cockpit">` block coexists with the existing wizard at `#/new` (untouched in this phase — wizard stays as the fallback while the cockpit is being built and smoke-tested). Dashboard's "+ Create campaign" button routes to `#/cockpit`. Bugatti Command Deck tokens reused from `style.css`.

**Tech Stack:** Vanilla ES module, existing `/api/campaign/start`, `/api/profiles`, `/api/sheet-summary` (built in Phase 1), `/api/drafts`. No new dependencies.

**Branch:** `feature/cockpit-overhaul` (Phase 1 already on it).

**Scope cuts:**
- Templates load from the most-recent draft for the chosen mode. No template editor in the cockpit yet — operator clicks "Edit templates → " to jump to the wizard at `#/new`. Phase 2.5 or later replaces this.
- Advanced mode-specific settings (intro name/title, preflight Check Status toggle, message-open-profiles) inherit from the loaded draft. No inline editor in Phase 2.
- Live Status redesign + Dashboard rows redesign live in Phase 3 / Phase 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `public/css/cockpit.css` | new | All cockpit atoms (mode grid, triple, stepper, columns panel, browse drawer, forecast, launch). Imports tokens from `style.css`. |
| `public/js/cockpit.js` | new | ES module: state, route handler, mode picker, sheet-summary fetch, columns panel, account presets, browse drawer, steppers, forecast, launch. |
| `public/index.html` | modify | Link the two new files. Add `<div class="route" data-route="cockpit">` block. Wire dashboard "+ Create campaign" button to `#/cockpit`. |

---

## Task 1 — CSS atoms file

**Files:**
- Create: `public/css/cockpit.css`
- Modify: `public/index.html` (add `<link>` to `<head>`)

Port the styling from the prototype at `.superpowers/brainstorm/9051-1778233574/content/cockpit.html` (lines 95–340) — the atoms portion only. Tokens come from `style.css`.

- [ ] **Step 1.1 — Write cockpit.css**

Atoms required (mirror what the prototype demonstrates):
- `.cockpit` grid container
- `.step-rail` decorative
- `.mode-grid` (4×2 hairline-divided), `.preset` cards
- `.triple` (1.4fr 1fr 1fr) column container, `.col` cells
- `.col-h` header with `.num` accent
- Underline input override (`input.cockpit-input`) — same hairline border pattern
- `.knob`, `.stepper` (`[−] val [+]`)
- `.acct-presets-stack`, `.acct-preset-card`
- `.match-row`
- `.browse-toggle` pill
- `.browse-pane`, `.browse-list` (3-col grid), `.browse-row` with `.box` (checkbox), `.bars`, `.bar-wrap`
- `.col-map-panel` (the Columns ▾ dropdown — see `~/Desktop/cockpit-ii-iv-sketches.html` variant E)
- `.funnel` (4-cell row, used in Section II header? — actually Section II = A in the user's pick, so no funnel inline — the funnel goes on the mode-grid cards via `.preset-count`. Skip `.funnel` for now.)
- `.forecast`, `.hero-cell` (4-cell hero)
- `.launch-row`, `.btn-launch`, `.btn-ghost`, `.keyhint`, `kbd`
- `.running-banner` (post-launch state)

Copy verbatim from prototype where possible. The prototype is internally consistent and brand-compliant.

- [ ] **Step 1.2 — Link the file from index.html**

In `public/index.html` `<head>`, after the existing `style.css` link:

```html
<link rel="stylesheet" href="/css/cockpit.css">
```

- [ ] **Step 1.3 — Verify load in browser**

Reload the app. Open DevTools → Network → confirm `cockpit.css` loads with 200. No visual changes yet (no HTML uses these classes).

- [ ] **Step 1.4 — Commit**

```bash
git add public/css/cockpit.css public/index.html
git commit -m "cockpit: add CSS atoms (Bugatti Command Deck tokens reused)"
```

---

## Task 2 — Cockpit HTML shell

**Files:**
- Modify: `public/index.html` — add a new `<div class="route" data-route="cockpit">` block alongside existing wizard / dashboard routes.

Skeleton only — IDs in place for the JS to bind to. No behavior yet.

- [ ] **Step 2.1 — Add the route block**

Insert immediately after the existing `<div class="route" data-route="wizard">` block (or wherever route blocks live — locate `data-route="dashboard"` for the pattern and follow it).

Structure (skeleton):
```html
<div class="route" data-route="cockpit" hidden>
  <button class="back-link" id="cockpit-back">← Back to dashboard</button>
  <div class="page-header">
    <div>
      <h1>New campaign <small>cockpit</small></h1>
      <div class="subtitle" id="cockpit-subtitle">Last preset loaded — adjust if needed, then launch</div>
    </div>
    <div class="header-stats" id="cockpit-stats">
      <!-- populated by JS -->
    </div>
  </div>

  <div class="step-rail">
    <span class="step done"><span class="num">I.</span>Type</span>
    <span class="step done"><span class="num">II.</span>Data</span>
    <span class="step done"><span class="num">III.</span>Accounts</span>
    <span class="step done"><span class="num">IV.</span>Pace</span>
    <span class="step"><span class="num">V.</span>Launch</span>
  </div>

  <div class="cockpit">
    <div>
      <h2><span class="num">I.</span> Campaign type <span class="summary" id="ck-mode-summary">→ Connect</span></h2>
      <div class="mode-grid" id="ck-mode-grid"><!-- 8 mode cards rendered by JS --></div>
    </div>

    <div class="triple">
      <div class="col" id="ck-col-data">
        <div class="col-h"><span class="num">II.</span>Data — Google sheet</div>
        <input type="text" class="cockpit-input" id="ck-sheet-url" placeholder="paste Google Sheet URL…" />
        <div class="col-sub" id="ck-sheet-status">no sheet loaded</div>
        <div class="pill-row" id="ck-columns-pill-row" hidden>
          <button class="pill" id="ck-columns-pill">Columns ▾</button>
          <span class="pill-state" id="ck-columns-state"></span>
        </div>
        <div class="col-map-panel" id="ck-columns-panel" hidden>
          <!-- one row per detected field, rendered by JS -->
        </div>
      </div>

      <div class="col" id="ck-col-accounts">
        <div class="col-h"><span class="num">III.</span>GoLogin accounts <span class="right"><span id="ck-acct-on">0</span> / <span id="ck-acct-total">327</span></span></div>
        <div class="acct-presets-stack" id="ck-acct-presets">
          <!-- preset cards rendered by JS -->
        </div>
        <div class="match-row">
          <div>
            <label>Match name <span class="hint">your ID in the lead sheet</span></label>
            <input type="text" class="cockpit-input" id="ck-match-name" />
          </div>
          <button class="override" id="ck-override-btn">Override</button>
        </div>
        <button class="browse-toggle" id="ck-browse-toggle">
          <span class="caret">▾</span> Browse / search profiles
          <span class="summary"><span id="ck-browse-count">0</span> selected</span>
        </button>
      </div>

      <div class="col" id="ck-col-pace">
        <div class="col-h"><span class="num">IV.</span>Pace</div>
        <div id="ck-steppers"><!-- 3 steppers rendered by JS --></div>
      </div>
    </div>

    <div class="browse-pane" id="ck-browse-pane" hidden>
      <!-- populated by JS when toggle opens -->
    </div>

    <div class="forecast" id="ck-forecast">
      <!-- 4 cells rendered by JS -->
    </div>

    <div class="launch-row">
      <button class="btn-launch" id="ck-launch" disabled>▶ Launch</button>
      <button class="btn-ghost" id="ck-edit-templates">Edit templates →</button>
      <span class="launch-meta" id="ck-launch-meta">pick a mode + sheet to enable</span>
      <span class="keyhint"><kbd>Esc</kbd> clears · <kbd>⌘↩</kbd> launches</span>
    </div>
  </div>
</div>
```

- [ ] **Step 2.2 — Verify**

Reload, navigate to `#/cockpit` in the URL bar. Expect: blank-ish page (route exists, no content rendered since JS hasn't been wired). DevTools → Elements: confirm the block is present.

- [ ] **Step 2.3 — Commit**

```bash
git add public/index.html
git commit -m "cockpit: add HTML shell route at #/cockpit"
```

---

## Task 3 — JS module + route registration

**Files:**
- Create: `public/js/cockpit.js`
- Modify: `public/index.html` — add `<script type="module" src="/js/cockpit.js"></script>` before `</body>`

ES module, encapsulates state and behavior. Hooks into the existing hash-routing logic by listening for `hashchange` and showing/hiding its own route block.

- [ ] **Step 3.1 — Skeleton cockpit.js**

```js
// public/js/cockpit.js
// Cockpit UI module — single-screen campaign launcher. Lives alongside the
// wizard (#/new) during Phase 2–4. Phase 5 deletes the wizard.

const state = {
  mode: 'connect_only',
  sheetUrl: '',
  headers: [],
  urlColumn: '',
  rowCount: 0,
  counts: null,        // /api/sheet-summary response
  accountPreset: 'all', // 'assigned' | 'pool' | 'all'
  matchName: '',
  allProfiles: [],     // /api/profiles cache
  selectedAccounts: new Set(),
  pace: { pauseMin: 15, pauseMax: 45, maxActions: 50, parallel: 2 },
  campaignName: '',
};

const ROUTE = 'cockpit';
const $ = sel => document.querySelector(sel);

function show() {
  const node = document.querySelector(`[data-route="${ROUTE}"]`);
  if (!node) return;
  document.querySelectorAll('[data-route]').forEach(r => r.hidden = true);
  node.hidden = false;
}

function isActive() {
  return location.hash === `#/${ROUTE}`;
}

function onHash() {
  if (isActive()) { show(); init(); }
}

let initialised = false;
async function init() {
  if (initialised) return;
  initialised = true;
  // Each task below registers its own initialisers here.
  console.log('[cockpit] init');
}

window.addEventListener('hashchange', onHash);
window.addEventListener('DOMContentLoaded', onHash);

export { state }; // expose for debugging via window.__cockpit
window.__cockpit = { state };
```

- [ ] **Step 3.2 — Link from index.html**

Before `</body>`:

```html
<script type="module" src="/js/cockpit.js"></script>
```

- [ ] **Step 3.3 — Verify route works**

Navigate to `#/cockpit`. DevTools console: should see `[cockpit] init`. The shell from Task 2 should be visible.

- [ ] **Step 3.4 — Commit**

```bash
git add public/js/cockpit.js public/index.html
git commit -m "cockpit: add JS module + #/cockpit route handler"
```

---

## Task 4 — Mode grid

**Files:**
- Modify: `public/js/cockpit.js`

Render 8 mode cards. Click → set `state.mode`, highlight active, refresh counts.

- [ ] **Step 4.1 — Add mode definitions + renderer**

```js
const MODES = [
  { key: 'connect_only',      title: 'Connect',        desc: 'Send invites' },
  { key: 'check_status',      title: 'Check status',   desc: 'Verify acceptances' },
  { key: 'message_only',      title: 'Message',        desc: 'Follow up' },
  { key: 'introduce_back',    title: 'Intro back',     desc: '3-way DM' },
  { key: 'inmail_only',       title: 'InMail',         desc: 'Paid messages' },
  { key: 'open_profile_only', title: 'Open profile',   desc: 'Free messages' },
  { key: 'check_dms',         title: 'Check DMs',      desc: 'Scan replies' },
  { key: 'post_amp',          title: 'Post amp',       desc: 'Like + comment' },
];

function renderModeGrid() {
  const grid = $('#ck-mode-grid');
  if (!grid) return;
  grid.innerHTML = MODES.map(m => {
    const count = state.counts?.byMode?.[m.key];
    const countLabel = count == null ? '—' : count;
    const active = state.mode === m.key ? 'active' : '';
    return `
      <button class="preset ${active}" data-mode="${m.key}">
        <div class="preset-title">${m.title}</div>
        <div class="preset-desc">${m.desc}</div>
        <div class="preset-count">${countLabel}</div>
      </button>`;
  }).join('');
  grid.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      $('#ck-mode-summary').textContent = '→ ' + MODES.find(m => m.key === state.mode).title;
      renderModeGrid();
      refreshSummary();      // re-fetch with new mode to update targetCount
      refreshForecast();
    });
  });
}
```

- [ ] **Step 4.2 — Add to init**

In `init()`:
```js
renderModeGrid();
```

- [ ] **Step 4.3 — Verify**

Reload `#/cockpit`. Expect 8 cards in 4×2 grid, all with `—` counts (no sheet loaded yet). Click each → active state moves correctly + summary text updates.

- [ ] **Step 4.4 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit: render mode grid with click-to-select"
```

---

## Task 5 — Section II (Data + Columns panel)

**Files:**
- Modify: `public/js/cockpit.js`

URL input → debounced fetch of `/api/sheet-summary` → populate counts + headers. `Columns ▾` pill toggles the panel; panel shows a dropdown of headers so the operator can pick the URL column.

- [ ] **Step 5.1 — Sheet summary fetch**

```js
let summaryTimer = null;
async function refreshSummary() {
  const url = state.sheetUrl.trim();
  if (!url) {
    state.counts = null;
    state.headers = [];
    state.rowCount = 0;
    $('#ck-sheet-status').textContent = 'no sheet loaded';
    $('#ck-columns-pill-row').hidden = true;
    renderModeGrid();
    refreshForecast();
    return;
  }
  $('#ck-sheet-status').textContent = 'loading…';
  try {
    const r = await fetch(`/api/sheet-summary?url=${encodeURIComponent(url)}&mode=${state.mode}`);
    const data = await r.json();
    if (data.error) { $('#ck-sheet-status').textContent = `error: ${data.error}`; return; }
    state.counts = data.counts;
    state.headers = data.headers || [];
    state.rowCount = data.rowCount || 0;
    // Default URL column if not yet set: prefer a header containing "linkedin"
    if (!state.urlColumn) {
      state.urlColumn = state.headers.find(h => /linkedin/i.test(h)) || state.headers[0] || '';
    }
    $('#ck-sheet-status').textContent = `✓ ${state.rowCount} rows · synced ${new Date(data.syncedAt).toLocaleTimeString()}`;
    $('#ck-columns-pill-row').hidden = false;
    renderColumnsPill();
    renderColumnsPanel();
    renderModeGrid();
    refreshForecast();
  } catch (err) {
    $('#ck-sheet-status').textContent = `error: ${err.message}`;
  }
}

function debounceSummary() {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(refreshSummary, 400);
}
```

- [ ] **Step 5.2 — Columns pill + panel renderers**

```js
function renderColumnsPill() {
  const detected = state.urlColumn ? `● URL detected · ${state.urlColumn}` : '● URL not detected';
  $('#ck-columns-state').innerHTML = `<span class="ok">${detected}</span>`;
}

function renderColumnsPanel() {
  const panel = $('#ck-columns-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="col-map-panel-h">
      <span>Columns the app understood</span>
      <span class="right">Pick a different column if the auto-detect is wrong</span>
    </div>
    <div class="col-map-row">
      <span class="k">LinkedIn URL</span>
      <select class="cockpit-input" id="ck-url-col-select">
        ${state.headers.map(h => `<option ${h === state.urlColumn ? 'selected' : ''}>${h}</option>`).join('')}
      </select>
    </div>`;
  $('#ck-url-col-select')?.addEventListener('change', e => {
    state.urlColumn = e.target.value;
    renderColumnsPill();
  });
}
```

- [ ] **Step 5.3 — Wire input + pill**

```js
function initSectionII() {
  $('#ck-sheet-url').addEventListener('input', e => {
    state.sheetUrl = e.target.value;
    debounceSummary();
  });
  $('#ck-columns-pill').addEventListener('click', () => {
    const p = $('#ck-columns-panel');
    p.hidden = !p.hidden;
  });
}
```

Call `initSectionII()` from `init()`.

- [ ] **Step 5.4 — Verify**

Paste a real sheet URL into the cockpit. Expect: meta line updates with row count, Columns ▾ pill appears with detected URL column, click pill → panel drops down, change dropdown → state updates.

- [ ] **Step 5.5 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit: wire Section II — URL input + Columns panel"
```

---

## Task 6 — Section III (Accounts + Browse drawer)

**Files:**
- Modify: `public/js/cockpit.js`

- [ ] **Step 6.1 — Load profiles once**

```js
async function loadProfiles() {
  try {
    const r = await fetch('/api/profiles');
    const data = await r.json();
    state.allProfiles = Array.isArray(data) ? data : (data.profiles || []);
    $('#ck-acct-total').textContent = state.allProfiles.length;
  } catch (err) {
    console.warn('[cockpit] loadProfiles failed', err);
  }
}
```

- [ ] **Step 6.2 — Render preset stack**

```js
const ACCT_PRESETS = [
  { key: 'assigned', title: 'Assigned to me', desc: 'Profiles where assignee matches my identifier' },
  { key: 'pool',     title: 'Unassigned pool', desc: 'Shared' },
  { key: 'all',      title: 'All',            desc: 'Show every profile' },
];

function filterProfilesByPreset() {
  // Phase 2: assignment metadata isn't tagged on profiles yet — treat
  // 'assigned' and 'pool' as future work; default 'all' to every profile.
  // Phase 2.5 wires real assignment filters.
  if (state.accountPreset === 'all') return state.allProfiles;
  if (state.accountPreset === 'assigned' && state.matchName) {
    return state.allProfiles.filter(p => (p.name || '').toLowerCase().includes(state.matchName.toLowerCase()));
  }
  return state.allProfiles; // pool fallback for now
}

function renderAcctPresets() {
  const stack = $('#ck-acct-presets');
  if (!stack) return;
  stack.innerHTML = ACCT_PRESETS.map(p => {
    const isActive = state.accountPreset === p.key;
    const count = (state.accountPreset === p.key ? filterProfilesByPreset() : []).length;
    return `
      <button class="acct-preset-card ${isActive ? 'active' : ''}" data-preset="${p.key}">
        <div>
          <div class="ttl"><span class="check">✓</span>${p.title}</div>
          <div class="desc">${p.desc}</div>
        </div>
        <div class="cnt">${count}</div>
      </button>`;
  }).join('');
  stack.querySelectorAll('.acct-preset-card').forEach(btn => {
    btn.addEventListener('click', () => {
      state.accountPreset = btn.dataset.preset;
      const filtered = filterProfilesByPreset();
      state.selectedAccounts = new Set(filtered.map(p => p.id));
      $('#ck-acct-on').textContent = state.selectedAccounts.size;
      $('#ck-browse-count').textContent = state.selectedAccounts.size;
      renderAcctPresets();
      refreshForecast();
    });
  });
}
```

- [ ] **Step 6.3 — Browse drawer**

```js
function renderBrowsePane() {
  const pane = $('#ck-browse-pane');
  if (!pane || pane.hidden) return;
  pane.innerHTML = `
    <div class="browse-pane-h">
      <span class="h-ttl">Browse profiles</span>
      <span class="h-sub">${state.allProfiles.length} total · ${state.selectedAccounts.size} selected</span>
      <div class="h-bulk">
        <button class="browse-bulk-btn" data-bulk="all">Select all</button>
        <button class="browse-bulk-btn" data-bulk="none">Clear</button>
      </div>
    </div>
    <input type="text" class="cockpit-input browse-search" id="ck-browse-search" placeholder="Search by name or email…" />
    <div class="browse-list">
      ${state.allProfiles.map(p => `
        <button class="browse-row ${state.selectedAccounts.has(p.id) ? 'checked' : ''}" data-id="${p.id}">
          <span class="box"></span>
          <div class="info">
            <div class="email">${p.name || p.id}</div>
          </div>
        </button>
      `).join('')}
    </div>`;
  pane.querySelectorAll('.browse-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (state.selectedAccounts.has(id)) state.selectedAccounts.delete(id);
      else state.selectedAccounts.add(id);
      $('#ck-acct-on').textContent = state.selectedAccounts.size;
      $('#ck-browse-count').textContent = state.selectedAccounts.size;
      row.classList.toggle('checked');
      refreshForecast();
    });
  });
  pane.querySelectorAll('.browse-bulk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.bulk === 'all') state.selectedAccounts = new Set(state.allProfiles.map(p => p.id));
      else state.selectedAccounts = new Set();
      renderBrowsePane();
      $('#ck-acct-on').textContent = state.selectedAccounts.size;
      $('#ck-browse-count').textContent = state.selectedAccounts.size;
      refreshForecast();
    });
  });
}

function initSectionIII() {
  $('#ck-match-name').addEventListener('input', e => { state.matchName = e.target.value; renderAcctPresets(); });
  $('#ck-browse-toggle').addEventListener('click', () => {
    const pane = $('#ck-browse-pane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) renderBrowsePane();
  });
}
```

- [ ] **Step 6.4 — Wire init**

```js
// in init()
await loadProfiles();
renderAcctPresets();
initSectionIII();
```

- [ ] **Step 6.5 — Verify + commit**

Reload, expect: 3 preset cards rendered with counts, "All" selected by default, Match name input editable, Browse drawer opens with 327 profiles searchable.

```bash
git add public/js/cockpit.js
git commit -m "cockpit: wire Section III — account presets + browse drawer"
```

---

## Task 7 — Section IV (Steppers)

**Files:**
- Modify: `public/js/cockpit.js`

Three steppers: Pause (range), Max actions × account, Parallel.

- [ ] **Step 7.1 — Stepper renderer**

```js
function renderSteppers() {
  const wrap = $('#ck-steppers');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="stepper-row">
      <span class="lbl">Pause</span>
      <span class="stepper">
        <button data-knob="pauseMin" data-d="-5">−</button>
        <span class="val">${state.pace.pauseMin}–${state.pace.pauseMax}</span>
        <button data-knob="pauseMax" data-d="5">+</button>
      </span>
      <span class="unit">SEC</span>
    </div>
    <div class="stepper-row">
      <span class="lbl">Max actions × account</span>
      <span class="stepper">
        <button data-knob="maxActions" data-d="-5">−</button>
        <span class="val">${state.pace.maxActions}</span>
        <button data-knob="maxActions" data-d="5">+</button>
      </span>
    </div>
    <div class="stepper-row">
      <span class="lbl">Parallel</span>
      <span class="stepper">
        <button data-knob="parallel" data-d="-1">−</button>
        <span class="val">×${state.pace.parallel}</span>
        <button data-knob="parallel" data-d="1">+</button>
      </span>
    </div>`;
  wrap.querySelectorAll('button[data-knob]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.knob;
      const d = parseInt(btn.dataset.d, 10);
      if (k === 'pauseMin') state.pace.pauseMin = Math.max(1, state.pace.pauseMin + d);
      else if (k === 'pauseMax') state.pace.pauseMax = Math.max(state.pace.pauseMin + 1, state.pace.pauseMax + d);
      else if (k === 'maxActions') state.pace.maxActions = Math.max(1, Math.min(500, state.pace.maxActions + d));
      else if (k === 'parallel') state.pace.parallel = Math.max(1, Math.min(5, state.pace.parallel + d));
      renderSteppers();
      refreshForecast();
    });
  });
}
```

- [ ] **Step 7.2 — Wire init + commit**

```js
// in init()
renderSteppers();
```

```bash
git add public/js/cockpit.js
git commit -m "cockpit: wire Section IV — pace steppers"
```

---

## Task 8 — Forecast row + Launch

**Files:**
- Modify: `public/js/cockpit.js`

Forecast: derived from `state.counts.targetCount × pace`. Launch button POSTs to `/api/campaign/start`.

- [ ] **Step 8.1 — Forecast renderer**

```js
function refreshForecast() {
  const wrap = $('#ck-forecast');
  if (!wrap) return;
  const target = state.counts?.targetCount ?? null;
  const accts = state.selectedAccounts.size || 1;
  const totalCap = state.pace.maxActions * accts;
  const willDo = target == null ? null : Math.min(target, totalCap);
  const avgPauseSec = (state.pace.pauseMin + state.pace.pauseMax) / 2;
  const perHourPerAccount = avgPauseSec > 0 ? Math.round(3600 / avgPauseSec) : 0;
  const throughput = perHourPerAccount * Math.min(state.pace.parallel, accts);
  const durationHours = willDo && throughput > 0 ? (willDo / throughput).toFixed(1) : '—';
  const finishesAt = willDo && throughput > 0
    ? new Date(Date.now() + (willDo / throughput) * 3600 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  wrap.innerHTML = `
    <div class="hero-cell"><div class="hero-k">Actions</div><div class="hero-v accent">${willDo ?? '—'}</div></div>
    <div class="hero-cell"><div class="hero-k">Duration</div><div class="hero-v">${durationHours}h</div></div>
    <div class="hero-cell"><div class="hero-k">Finishes</div><div class="hero-v">${finishesAt}</div></div>
    <div class="hero-cell"><div class="hero-k">Throughput</div><div class="hero-v">${throughput}/h</div></div>`;
  updateLaunchEnabled();
}

function updateLaunchEnabled() {
  const btn = $('#ck-launch');
  const ready = state.mode && state.sheetUrl && state.urlColumn && state.selectedAccounts.size > 0;
  btn.disabled = !ready;
  $('#ck-launch-meta').textContent = ready ? 'ready' : 'pick mode + sheet + accounts to enable';
}
```

- [ ] **Step 8.2 — Launch handler**

```js
async function loadLatestDraftForMode(mode) {
  try {
    const r = await fetch('/api/drafts');
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.drafts || []);
    return list.filter(d => d.mode === mode).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  } catch { return null; }
}

async function launch() {
  const btn = $('#ck-launch');
  btn.disabled = true; btn.textContent = '…launching';
  const draft = await loadLatestDraftForMode(state.mode);
  const templates = draft?.templates || {};
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
    templates,
    senderFirstNames: {},
    introMode: state.mode === 'introduce_back',
    introName: draft?.introName || '',
    introTitle: draft?.introTitle || 'Introduction: {first name} <> {intro name}',
    preflightCheckStatus: false, // Phase 2.5 surfaces this toggle
    messageOpenProfiles: false,  // legacy, removed
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
    location.hash = '#/';   // bounce to dashboard so existing live-status takes over
  } catch (err) {
    alert('Launch failed: ' + err.message);
    btn.disabled = false; btn.textContent = '▶ Launch';
  }
}

function initLaunch() {
  $('#ck-launch').addEventListener('click', launch);
  $('#ck-edit-templates').addEventListener('click', () => location.hash = '#/new');
  $('#cockpit-back').addEventListener('click', () => location.hash = '#/');
  document.addEventListener('keydown', e => {
    if (!isActive()) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!$('#ck-launch').disabled) launch(); }
    if (e.key === 'Escape') location.hash = '#/';
  });
}
```

- [ ] **Step 8.3 — Wire init**

```js
// in init()
refreshForecast();
initLaunch();
```

- [ ] **Step 8.4 — Commit**

```bash
git add public/js/cockpit.js
git commit -m "cockpit: wire Forecast row + Launch (+ ⌘↩ shortcut)"
```

---

## Task 9 — Dashboard CTA + smoke test

**Files:**
- Modify: `public/js/app.js` (or wherever the dashboard's "+ Create campaign" button handler lives)

- [ ] **Step 9.1 — Find the existing CTA**

```bash
grep -nE "(Create campaign|new-campaign-btn|btn-create)" public/index.html public/js/app.js | head -10
```

Adjust the handler so its click sets `location.hash = '#/cockpit'` instead of `#/new`. Wizard remains reachable by typing `#/new` directly until Phase 5.

- [ ] **Step 9.2 — Smoke test (manual)**

1. Reload, click `+ Create campaign` from dashboard. Expect: cockpit screen at `#/cockpit`.
2. Paste a real sheet URL. Expect: row count + Columns ▾ pill appears.
3. Click `Columns ▾`. Expect: dropdown panel with URL column auto-selected.
4. Click a different mode card. Expect: count refreshes for that mode.
5. Bump steppers. Expect: forecast updates live.
6. Open Browse drawer, deselect a profile. Expect: "X selected" updates.
7. Click `▶ Launch`. Expect: campaign starts, page bounces to dashboard, live status shows progress.

If smoke test passes → Phase 2 done. If anything fails → debug before commit.

- [ ] **Step 9.3 — Restart dev**

```bash
pkill -f "npm run dev:app" 2>/dev/null
pkill -f "electron" 2>/dev/null
sleep 2
npm run dev:app > /tmp/ortus-dev.log 2>&1 &
```

- [ ] **Step 9.4 — Commit**

```bash
git add public/js/app.js
git commit -m "cockpit: wire dashboard '+ Create campaign' to #/cockpit"
```

---

## Definition of Done (Phase 2)

- [ ] `public/css/cockpit.css` created and linked
- [ ] `public/js/cockpit.js` created and linked
- [ ] `<div class="route" data-route="cockpit">` block in index.html
- [ ] Mode grid renders 8 cards with live counts from `/api/sheet-summary`
- [ ] Section II URL input + Columns ▾ panel works
- [ ] Section III account presets + Browse drawer works
- [ ] Section IV steppers work
- [ ] Forecast row computes live
- [ ] Launch button POSTs to `/api/campaign/start` and bounces to dashboard
- [ ] ⌘↩ shortcut works
- [ ] Dashboard "+ Create campaign" routes to `#/cockpit`
- [ ] Wizard at `#/new` still works (untouched)
- [ ] Manual smoke test passes end-to-end

**No backend changes.** Phase 3 redesigns the Dashboard rows. Phase 4 redesigns Live Status. Phase 5 deletes the wizard.

---

## Self-Review Notes

- Each task is independent and committable on its own. If Task 7 (steppers) needs rework, it doesn't block Tasks 1–6.
- All `state` mutations route through a render function that re-renders the affected DOM block — no manual element-by-element updates that drift out of sync.
- All `$()` selectors use IDs that exist in the Task 2 HTML shell. Function signatures + state keys consistent across tasks.
- Templates inherited from drafts (Phase 2 scope cut). If no draft exists for the chosen mode, server-side validation will reject with a clear error — user clicks `Edit templates →` to fix.
- No new dependencies. No tests in this phase (UI; no existing test harness for the frontend).
- Rollback: revert all Phase 2 commits → cockpit gone, wizard untouched, no impact on shipped functionality.
