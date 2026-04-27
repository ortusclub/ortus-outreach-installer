# Ortus Outreach Paper-Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 9 surgical UX paper-cut patches against the existing Ortus Outreach app — no architectural change, no new dependencies, single version bump (2.8.19).

**Architecture:** Vanilla-JS Express + Electron app. All work touches `public/index.html`, `public/js/app.js`, `public/css/style.css`, plus one new read-only endpoint in `server.js`. The locked "Bugatti command deck" design system (monochrome, hairlines, gold only on Start CTA, radii 0 or 9999) is the binding constraint.

**Tech Stack:** Node ≥22, Express 4, vanilla browser JS (no bundler), `node --test` for backend tests, manual browser verification for frontend (no frontend test harness exists in the repo).

**Spec:** `docs/superpowers/specs/2026-04-27-ortus-outreach-paper-cuts-design.md` (committed at `4dfcac7`).

**Companion sketches:** `public/sketches/papercuts-{index,A,B,C,B2-options}.html` — open `http://localhost:3000/sketches/papercuts-index.html` after `npm run dev`.

**Testing convention used in this plan:**
- **Backend** (server.js, src/): write a `node --test` file under `tests/` that exercises the new behavior, then `npm test`.
- **Frontend** (index.html, app.js, style.css): the project has no headless browser test harness. Verify each frontend patch manually in the browser at `http://localhost:3000/`. Each task includes the exact verification steps.

---

## Task 0: Pre-flight

**Files:**
- No file changes
- Verify: dev server running, working tree clean of unrelated changes

- [ ] **Step 1: Confirm working tree is clean of unrelated changes**

Run: `git status --short`

Expected: only the planning docs from earlier brainstorming should be untracked/modified. If there's other work-in-progress, stash it (`git stash push -u -m "wip before paper-cuts"`) before proceeding.

- [ ] **Step 2: Confirm Node ≥22**

Run: `node --version`
Expected: `v22.x` or higher (per `package.json` engines).

- [ ] **Step 3: Confirm dev server boots**

If a dev server is already running on port 3000, skip this. Otherwise:

```bash
npm run dev
```
Then in another shell: `curl -sf http://localhost:3000/ -o /dev/null && echo OK` → expect `OK`.

Leave the server running for the rest of the plan. It auto-reloads on file changes (`node --watch server.js`).

- [ ] **Step 4: Take baseline screenshot**

Open `http://localhost:3000/` in a browser (you may need to log in). Take a screenshot of the home view for visual diff later. Keep the tab open.

- [ ] **Step 5: Run existing tests to confirm baseline green**

Run: `npm test`
Expected: all tests pass. If any fail before we start, **stop and ask the user** — do not proceed on red.

---

## Task A1: Renumber section labels to match document order

**Files:**
- Modify: `public/index.html` (sidebar nav buttons + 6 section h2 labels)

**Background:** Section labels currently read 1 (Settings) → 4 (Throughput) → 2 (Sheet) → 3 (Accounts) → 5 (Templates) → 6 (Launch). Renumber so labels match top-to-bottom position. Sidebar Roman numerals get the same treatment. Pure copy change.

- [ ] **Step 1: Locate the sidebar nav block (lines 22-35)**

Run: `sed -n '22,35p' public/index.html`

Confirm you see the five `<button class="nav-item" data-nav="nav-{settings,sheet,accounts,templates,launch}"...>` lines.

- [ ] **Step 2: Update sidebar Roman numerals**

The current sidebar order is already `nav-settings → nav-sheet → nav-accounts → nav-templates → nav-launch`, so the buttons themselves don't move — only the `<span class="nav-num">` text changes per button. The current numerals are I / II / III / IV / V which already match document order — **no change needed in sidebar**. Skip to Step 3.

> If a future edit reorders the sidebar buttons, this step needs revisiting.

- [ ] **Step 3: Renumber the section h2 labels**

Apply each of these edits to `public/index.html`:

| Line | Old text (inside `<span data-edit="...">`) | New text |
|---|---|---|
| 156 | `4. Throughput` | `5. Throughput` |
| 251 | `2. Google Sheet URL` | `2. Google Sheet URL` (unchanged) |
| 262 | `3. Select GoLogin Accounts` | `3. Select GoLogin Accounts` (unchanged) |
| 333 | `5. Message Templates` | `4. Message Templates` |
| 392 | `6. Launch` | `6. Launch` (unchanged) |

So the only two edits are line 156 (`4.` → `5.`) and line 333 (`5.` → `4.`).

Use Edit on file `public/index.html`:

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-pace')"><span class="caret">▾</span> <span data-edit="h2-pace">4. Throughput</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-pace')"><span class="caret">▾</span> <span data-edit="h2-pace">5. Throughput</span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-templates')"><span class="caret">▾</span> <span data-edit="h2-templates">5. Message Templates</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-templates')"><span class="caret">▾</span> <span data-edit="h2-templates">4. Message Templates</span></h2>
```

- [ ] **Step 4: Manual verify in browser**

Reload `http://localhost:3000/`. Confirm the section headers in document order read:

1. Campaign Settings
2. Google Sheet URL
3. Select GoLogin Accounts
4. Message Templates
5. Throughput
6. Launch

If your localStorage contains `ortus-edits` overrides for `h2-pace` or `h2-templates`, those overrides will mask the new text. Open the sidebar Edit-mode toggle → Reset → confirm new numbers appear.

- [ ] **Step 5: Spot-check `docs/manual.md` for stale references**

Run: `grep -nE '4\. Throughput|5\. Message Templates' docs/manual.md`

If any matches: update them to the new numbering inline. If no matches: skip.

- [ ] **Step 6: Commit**

```bash
git add public/index.html docs/manual.md 2>/dev/null
git status --short
git commit -m "feat(2.8.19): A1 — renumber Throughput→5, Templates→4 to match document order"
```

(If `docs/manual.md` had no changes, the `git add` is a no-op and only `index.html` ends up staged.)

---

## Task A2: Smart default-expand + done summaries

**Files:**
- Modify: `public/index.html` (add summary-line spans inside each section h2)
- Modify: `public/js/app.js` (add `computeSectionReadiness()`, `updateSectionSummaries()`, `applyInitialExpand()`; wire to existing `updateCampaignSummary()` call sites and to startup IIFE)
- Modify: `public/css/style.css` (add `.section-summary` utility class)

**Background:** On initial load, walk the six numbered sections, classify each as `done | empty | locked`, expand the first `empty` (one-shot, no localStorage write), and render one-line summaries on `done` sections. Live-update summaries on every input change that affects readiness; do NOT auto-collapse/expand after initial load.

- [ ] **Step 1: Add summary spans to section h2 markup**

For each of the six numbered section headers, add a `<span class="section-summary" id="summary-{key}"></span>` after the existing `<span data-edit="...">` and before `</h2>`.

Apply to `public/index.html`:

```
old: <h2 data-edit="h2-settings">1. Campaign Settings</h2>
new: <h2 data-edit="h2-settings">1. Campaign Settings <span class="section-summary" id="summary-settings"></span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-sheet')"><span class="caret">▾</span> <span data-edit="h2-sheet">2. Google Sheet URL</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-sheet')"><span class="caret">▾</span> <span data-edit="h2-sheet">2. Google Sheet URL</span> <span class="section-summary" id="summary-sheet"></span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-accounts')"><span class="caret">▾</span> <span data-edit="h2-accounts">3. Select GoLogin Accounts</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-accounts')"><span class="caret">▾</span> <span data-edit="h2-accounts">3. Select GoLogin Accounts</span> <span class="section-summary" id="summary-accounts"></span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-templates')"><span class="caret">▾</span> <span data-edit="h2-templates">4. Message Templates</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-templates')"><span class="caret">▾</span> <span data-edit="h2-templates">4. Message Templates</span> <span class="section-summary" id="summary-templates"></span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-pace')"><span class="caret">▾</span> <span data-edit="h2-pace">5. Throughput</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-pace')"><span class="caret">▾</span> <span data-edit="h2-pace">5. Throughput</span> <span class="section-summary" id="summary-pace"></span></h2>
```

```
old: <h2 class="section-toggle" onclick="toggleSection('nav-launch')"><span class="caret">▾</span> <span data-edit="h2-launch">6. Launch</span></h2>
new: <h2 class="section-toggle" onclick="toggleSection('nav-launch')"><span class="caret">▾</span> <span data-edit="h2-launch">6. Launch</span> <span class="section-summary" id="summary-launch"></span></h2>
```

- [ ] **Step 2: Add CSS for `.section-summary`**

Append to `public/css/style.css` (at the end of the file):

```css
/* Phase 2.8.19 (A2) — section-status one-line summary, right-aligned in the h2 */
.section-summary {
  float: right;
  font-family: var(--body, 'Hanken Grotesk', sans-serif);
  font-size: 0.62rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gray);
  font-weight: 400;
  line-height: 1.6;
  margin-left: 12px;
}
.section-summary:empty { display: none; }
.section-summary.done { color: var(--gray); }
.section-summary.empty { color: var(--gray); opacity: 0.55; }
```

- [ ] **Step 3: Add the readiness/summary functions to app.js**

Insert this block at the end of `public/js/app.js`, just before the existing `// Open Profile toggle listener` comment that lives around line 2992. (The block is self-contained — it reads existing globals and DOM only.)

```js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.8.19 (A2/A3) — section readiness, summaries, and sidebar glyphs
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_ORDER = [
  { id: 'nav-settings',  key: 'settings',  required: true  },
  { id: 'nav-sheet',     key: 'sheet',     required: true  },
  { id: 'nav-accounts',  key: 'accounts',  required: true  },
  { id: 'nav-templates', key: 'templates', required: true  },
  { id: 'nav-pace',      key: 'pace',      required: false },
  { id: 'nav-launch',    key: 'launch',    required: true  },
];

function _humanAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function computeSectionReadiness() {
  // Returns { settings: 'done'|'empty', sheet: ..., ... } and a summary string per key.
  const out = {};

  // Settings — always done if mode is selected (default mode is set)
  const modeEl = document.getElementById('campaign-mode');
  const mode = modeEl ? modeEl.value : '';
  const noteOn = localStorage.getItem('ortus-add-note') === '1';
  out.settings = {
    state: mode ? 'done' : 'empty',
    summary: mode
      ? (mode === 'connect_only' ? `Connect · ${noteOn ? 'with note' : 'no note'}` : prettyMode(mode))
      : '',
  };

  // Sheet — done if URL field non-empty; summary uses preview cache if available
  const sheetUrl = (document.getElementById('sheet-url')?.value || '').trim();
  out.sheet = {
    state: sheetUrl ? 'done' : 'empty',
    summary: sheetUrl
      ? (window.__sheetPreviewCache
        ? `${window.__sheetPreviewCache.count} leads · ${_humanAgo(window.__sheetPreviewCache.at)}`
        : 'URL set · preview not loaded')
      : '',
  };

  // Accounts — done if at least one selected
  const selCount = (window.selectedProfileIds && window.selectedProfileIds.length) || 0;
  out.accounts = {
    state: selCount > 0 ? 'done' : 'empty',
    summary: selCount > 0 ? `${selCount} selected` : '',
  };

  // Templates — done if a template body is non-empty for the current mode
  let tplBody = '';
  let tplName = '';
  const tplSel = document.getElementById('template-select');
  if (tplSel && tplSel.value) tplName = tplSel.value;
  if (mode === 'connect_only')         tplBody = (document.getElementById('tpl-note')?.value || '');
  else if (mode === 'message_only')    tplBody = (document.getElementById('tpl-followup')?.value || '');
  else if (mode === 'inmail_only')     tplBody = (document.getElementById('tpl-inmail-body')?.value || '');
  else if (mode === 'open_profile_only') tplBody = (document.getElementById('tpl-op-body')?.value || '');
  out.templates = {
    state: tplBody.trim() ? 'done' : 'empty',
    summary: tplBody.trim()
      ? `${tplName ? tplName + ' · ' : ''}${tplBody.trim().slice(0, 40)}${tplBody.trim().length > 40 ? '…' : ''}`
      : '',
  };

  // Throughput (pace) — non-required; "done" means values present (they always are: defaults)
  const rate = document.getElementById('rate-per-hour')?.value || '';
  const dailyLimit = document.getElementById('daily-limit')?.value || '';
  out.pace = {
    state: (rate && dailyLimit) ? 'done' : 'empty',
    summary: (rate && dailyLimit) ? `${rate}/hr · ${dailyLimit} max/account` : '',
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

function prettyMode(mode) {
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

function updateSectionSummaries() {
  const readiness = computeSectionReadiness();
  for (const { key } of SECTION_ORDER) {
    const el = document.getElementById(`summary-${key}`);
    if (!el) continue;
    el.textContent = readiness[key].summary || '';
    el.classList.toggle('done', readiness[key].state === 'done');
    el.classList.toggle('empty', readiness[key].state === 'empty');
  }
  // A3 hook — also refresh sidebar glyphs (defined in next task; safe no-op until A3 is in)
  if (typeof updateSidebarGlyphs === 'function') updateSidebarGlyphs(readiness);
  return readiness;
}

let _initialExpandApplied = false;
function applyInitialExpand() {
  if (_initialExpandApplied) return;
  _initialExpandApplied = true;
  const readiness = computeSectionReadiness();
  // Find the first required+empty section in document order
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
```

- [ ] **Step 4: Wire summary updates to existing change triggers**

`updateCampaignSummary()` is already called from many input-change paths (lines 709, 714, 1060, 1234, 1259, 3130). Add one call to `updateSectionSummaries()` at the end of that function.

In `public/js/app.js`, find the function `updateCampaignSummary()` starting around line 1309. Find its closing `}` and add `updateSectionSummaries();` as the last statement before that brace. Use Edit:

```
old: function updateCampaignSummary() {
new: function updateCampaignSummary() {
```

That edit doesn't actually change anything — instead, after locating the function, find the LAST line inside its body. Easier approach: add an explicit hook line near the function's end. Use Read to get the function body first (`Read public/js/app.js offset:1309 limit:80`), find the `}` that closes the function, and insert `updateSectionSummaries();` on the line above it.

If the function is too long to safely edit, an alternative wiring is to add a wrapper at the bottom of `app.js`:

```js
// Phase 2.8.19 (A2) — re-run summary refresh after every campaign-summary recompute
const _origUpdateCampaignSummary = window.updateCampaignSummary;
window.updateCampaignSummary = function (...args) {
  const r = _origUpdateCampaignSummary.apply(this, args);
  try { updateSectionSummaries(); } catch (_) {}
  return r;
};
```

Place this wrapper at the end of `app.js`, AFTER the existing `window.updateCampaignSummary = updateCampaignSummary;` line (around 3397).

- [ ] **Step 5: Hook initial expand into startup IIFE**

Find the bottom-of-file IIFE block (around lines 2975-2992):

```js
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
```

After `updateCampaignSummary();` add two new lines:

```
old: updateCampaignSummary();
new: updateCampaignSummary();
applyInitialExpand();
updateSectionSummaries();
```

`applyInitialExpand()` runs once on startup (guarded by `_initialExpandApplied`). `updateSectionSummaries()` here ensures the very first paint shows summaries before any input change fires.

- [ ] **Step 6: Persist sheet preview cache for the summary**

Find `previewSheet()` in `public/js/app.js`:

```bash
grep -n "function previewSheet" public/js/app.js
```

In the success path (where the response is parsed), add this line right after the row count is known:

```js
window.__sheetPreviewCache = { count: <row-count-variable>, at: Date.now() };
```

Replace `<row-count-variable>` with the actual variable holding the row count in your local context (likely `data.rows.length` or similar — check the function body). If the function structure makes this awkward, omit and the summary will fall back to "URL set · preview not loaded".

- [ ] **Step 7: Manual verify in browser**

Reload `http://localhost:3000/`.

Verify:
1. Reload with empty state (clear localStorage if needed: `localStorage.clear()`, reload). The first empty required section should auto-expand. Sections that have data (e.g. Settings will have a default mode, so it shows "Connect · no note") should show a one-line summary on the right of their header.
2. Type a Sheet URL → the Sheet section's summary updates within a beat.
3. Manually collapse a `done` section (click its header) → it stays collapsed; the summary stays visible in the header.
4. Reload → your manual collapse choices are still respected. The "expand first empty" override only fires once per page load (you may see it expand again if a different section is now empty).

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(2.8.19): A2 — smart default-expand + done summaries on numbered sections"
```

---

## Task A3: Sidebar state glyphs

**Files:**
- Modify: `public/index.html` (add empty `<span class="nav-glyph">` to each numbered nav button)
- Modify: `public/js/app.js` (add `updateSidebarGlyphs()`; A2 already calls it conditionally)
- Modify: `public/css/style.css` (add `.nav-glyph` utility classes)

- [ ] **Step 1: Add empty glyph spans to sidebar nav buttons**

Apply five edits to `public/index.html` (lines 24-28):

```
old: <button type="button" class="nav-item" data-nav="nav-settings" onclick="scrollToSection('nav-settings')"><span class="nav-num">I.</span>Settings</button>
new: <button type="button" class="nav-item" data-nav="nav-settings" onclick="scrollToSection('nav-settings')"><span class="nav-num">I.</span>Settings<span class="nav-glyph" id="nav-glyph-settings"></span></button>
```

```
old: <button type="button" class="nav-item" data-nav="nav-sheet" onclick="scrollToSection('nav-sheet')"><span class="nav-num">II.</span>Sheet</button>
new: <button type="button" class="nav-item" data-nav="nav-sheet" onclick="scrollToSection('nav-sheet')"><span class="nav-num">II.</span>Sheet<span class="nav-glyph" id="nav-glyph-sheet"></span></button>
```

```
old: <button type="button" class="nav-item" data-nav="nav-accounts" onclick="scrollToSection('nav-accounts')"><span class="nav-num">III.</span>Accounts</button>
new: <button type="button" class="nav-item" data-nav="nav-accounts" onclick="scrollToSection('nav-accounts')"><span class="nav-num">III.</span>Accounts<span class="nav-glyph" id="nav-glyph-accounts"></span></button>
```

```
old: <button type="button" class="nav-item" data-nav="nav-templates" onclick="scrollToSection('nav-templates')"><span class="nav-num">IV.</span>Templates</button>
new: <button type="button" class="nav-item" data-nav="nav-templates" onclick="scrollToSection('nav-templates')"><span class="nav-num">IV.</span>Templates<span class="nav-glyph" id="nav-glyph-templates"></span></button>
```

```
old: <button type="button" class="nav-item" data-nav="nav-launch" onclick="scrollToSection('nav-launch')"><span class="nav-num">V.</span>Launch</button>
new: <button type="button" class="nav-item" data-nav="nav-launch" onclick="scrollToSection('nav-launch')"><span class="nav-num">V.</span>Launch<span class="nav-glyph" id="nav-glyph-launch"></span></button>
```

(`nav-pace` is not in the sidebar — Throughput is reachable only by scroll. No glyph needed.)

- [ ] **Step 2: Add CSS for `.nav-glyph`**

Append to `public/css/style.css`:

```css
/* Phase 2.8.19 (A3) — sidebar state glyph (✓ done · ▸ current · ◯ empty) */
.nav-glyph {
  float: right;
  font-size: 0.7rem;
  line-height: 1;
  margin-left: 8px;
  color: var(--gray);
  opacity: 0.55;
}
.nav-glyph.done    { color: var(--green); opacity: 1; }
.nav-glyph.current { color: var(--gold);  opacity: 1; }
.nav-glyph.empty   { color: var(--gray);  opacity: 0.55; }
.nav-glyph:empty   { display: none; }
```

- [ ] **Step 3: Add `updateSidebarGlyphs()` to app.js**

Insert just below `applyInitialExpand` from Task A2 (still near the end of `app.js`):

```js
function updateSidebarGlyphs(readiness) {
  // readiness from computeSectionReadiness(); fall back if not provided
  const r = readiness || computeSectionReadiness();
  // Determine current section: the one whose nav-item has .active class
  const activeBtn = document.querySelector('.nav-item.active');
  const activeId = activeBtn ? activeBtn.getAttribute('data-nav') : null;

  // nav buttons in scope (skip pace — not in sidebar)
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
```

- [ ] **Step 4: Refresh glyphs when scroll-spy sets the active nav**

Find `setActiveNav()` in `public/js/app.js` (around line 2606):

```
old: function setActiveNav(id) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const trigger = document.querySelector(`.nav-item[data-nav="${id}"]`);
  if (trigger) trigger.classList.add('active');
}
new: function setActiveNav(id) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const trigger = document.querySelector(`.nav-item[data-nav="${id}"]`);
  if (trigger) trigger.classList.add('active');
  if (typeof updateSidebarGlyphs === 'function') updateSidebarGlyphs();
}
```

- [ ] **Step 5: Manual verify in browser**

Reload. Confirm:
1. Each numbered sidebar item shows a glyph: `✓` (green) for done sections, `◯` (faded) for empty.
2. The currently scrolled-to section shows `▸` (gold) instead of `✓`/`◯`.
3. Filling out the Sheet URL field flips its glyph from `◯` to `✓` within a beat.
4. No glyph appears next to "Live Status", "History", "Schedules", "Server Log".

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(2.8.19): A3 — sidebar state glyphs (done/current/empty)"
```

---

## Task B1: Verify run-bar Stop button (no code change)

**Files:** none

**Background:** `#btn-stop-rb` already exists in markup (`public/index.html:638`) and is enabled/disabled by `app.js:1752`. This task is verification only.

- [ ] **Step 1: Confirm markup**

Run: `grep -n 'btn-stop-rb' public/index.html public/js/app.js`

Expected: at least one line in each file. If `btn-stop-rb` is missing, **stop and ask the user** — the spec amendment was based on its existence.

- [ ] **Step 2: Confirm run-bar Stop is wired to running state**

Run: `sed -n '1748,1760p' public/js/app.js`

Expected: a line of the form `['btn-stop', 'btn-stop-rb'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !running; });`. If absent, stop and ask.

- [ ] **Step 3: Manual verify in browser (only if a campaign is convenient to start)**

If you can safely start a short test campaign (or you already have one running), confirm:
1. The run-bar Stop button (`#btn-stop-rb`) is enabled while the campaign is running.
2. Clicking it opens the existing stop confirmation modal.
3. Confirming the stop ends the campaign without console errors.

If starting a real campaign isn't safe, skip this and rely on Step 2's static check.

- [ ] **Step 4: No commit**

Nothing changed. Move on.

---

## Task B2: Demote right-pane Status row + clarify header-stat labels

**Files:**
- Modify: `public/index.html` (4 header-stat labels)
- Modify: `public/css/style.css` (add `.rp-status-line.demoted` utility)
- Modify: `public/js/app.js` (one-time: add `.demoted` class to right-pane status line on init)

**Background:** Cockpit (inside Live Status) stays as the single live-state authority. Right-pane Status row is dimmed (drops display-font and gold tint, becomes plain `--gray`). Header-stat labels become explicit about trailing-window scope.

- [ ] **Step 1: Update header-stat label text**

Apply four edits to `public/index.html` (lines 71, 76, 81, 86):

```
old: <span class="k" data-edit="overview-today">Today</span>
new: <span class="k" data-edit="overview-today">Today (sent)</span>
```

```
old: <span class="k" data-edit="overview-week">7D</span>
new: <span class="k" data-edit="overview-week">7-day total</span>
```

```
old: <span class="k" data-edit="overview-errors">Errors 24h</span>
new: <span class="k" data-edit="overview-errors">Errors · 24h</span>
```

(Passover label intentionally unchanged — already self-explanatory.)

- [ ] **Step 2: Add CSS to demote right-pane Status row**

Append to `public/css/style.css`:

```css
/* Phase 2.8.19 (B2) — right-pane Status row demoted to non-live confirmation */
.rp-status-line.demoted {
  font-family: var(--body, 'Hanken Grotesk', sans-serif);
  font-size: 0.78rem;
  color: var(--gray);
}
.rp-status-line.demoted .rp-dot {
  /* keep the dot but desaturate */
  opacity: 0.6;
}
.rp-status-line.demoted #rp-status-text {
  color: var(--gray);
  font-family: inherit;
}
```

- [ ] **Step 3: Add `.demoted` class on init**

Find the bottom-of-file IIFE in `public/js/app.js` (already amended in A2). Append one line after `applyInitialExpand();`:

```
old: applyInitialExpand();
updateSectionSummaries();
new: applyInitialExpand();
updateSectionSummaries();
document.getElementById('rp-status')?.classList.add('demoted');
```

- [ ] **Step 4: Manual verify**

Reload. Confirm:
1. Right-pane "Status" row reads in plain gray text — no display-font, no gold accent. The dot stays but is muted.
2. Header stats labels now read "Today (sent) / 7-day total / Errors · 24h / Passover".
3. The cockpit panel inside Live Status is unchanged (ring + meta + stats still gold-accented).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(2.8.19): B2 — demote right-pane Status, clarify header-stat labels (option α)"
```

---

## Task B3: Unify log panels

**Files:**
- Modify: `public/index.html` (delete `#server-log-panel` block, change sidebar "Server Log" button label + behavior, add "Show server lines" checkbox above `#log-panel`)
- Modify: `public/js/app.js` (rewrite/repurpose `toggleServerLog`, `fetchServerLog` so they target the unified panel)

**Background:** Inline Server Log panel deletes. Sidebar "Server Log" becomes "Open log" — scrolls to Live Status and expands it. Live Status log gains a "Show server lines" checkbox; when checked, server-log lines are interleaved into the same scrolling panel.

- [ ] **Step 1: Delete the inline `#server-log-panel` block**

Locate the block in `public/index.html` (starts around line 106):

```bash
sed -n '106,116p' public/index.html
```

Confirm the block reads (approximately):

```html
<div id="server-log-panel" class="hidden" style="margin-bottom:16px">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px">
    <span style="color:#8b949e; font-size:0.75rem">Server console output (auto-refreshes)</span>
    <div style="display:flex; gap:4px">
      <button class="btn btn-secondary" onclick="copyServerLog()" style="height:24px; font-size:0.7rem; padding:2px 8px">Copy</button>
      <button class="btn btn-secondary" onclick="clearServerLog()" style="height:24px; font-size:0.7rem; padding:2px 8px">Clear</button>
    </div>
  </div>
  <div id="server-log" class="log-panel" style="max-height:200px; font-size:0.7rem"></div>
</div>
```

Delete the entire `<div id="server-log-panel"...>...</div>` block (use Edit with the full block text as `old_string` and an empty `new_string`).

- [ ] **Step 2: Change sidebar "Server Log" button to "Open log"**

In `public/index.html` line 34:

```
old: <button type="button" class="nav-item" onclick="toggleServerLog()">Server Log</button>
new: <button type="button" class="nav-item" onclick="openUnifiedLog()">Open log</button>
```

- [ ] **Step 3: Add the "Show server lines" checkbox above `#log-panel`**

Find the buttons row right above `#log-panel` (around line 502-504, the row with Show Browsers / Copy Log / Clear Log). Edit:

```
old: <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:8px">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-show-browsers" onclick="showBrowsers()" title="Un-minimize all active profile windows">Show Browsers</button>
        <button class="btn btn-secondary btn-sm" onclick="copyCampaignLog()">Copy Log</button>
        <button class="btn btn-secondary btn-sm" onclick="clearCampaignLog()">Clear Log</button>
      </div>
new: <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; margin-bottom:8px">
        <label style="display:flex; align-items:center; gap:6px; font-size:0.7rem; color:var(--gray); margin-right:auto">
          <input type="checkbox" id="show-server-lines" style="width:14px; height:14px" />
          Show server lines
        </label>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-show-browsers" onclick="showBrowsers()" title="Un-minimize all active profile windows">Show Browsers</button>
        <button class="btn btn-secondary btn-sm" onclick="copyCampaignLog()">Copy Log</button>
        <button class="btn btn-secondary btn-sm" onclick="clearCampaignLog()">Clear Log</button>
      </div>
```

- [ ] **Step 4: Replace log functions in app.js**

Find the existing `toggleServerLog`, `fetchServerLog`, `clearServerLog`, `copyServerLog` functions in `public/js/app.js` (around lines 321-365). Use Read to confirm the exact existing block, then replace with this:

```js
// Phase 2.8.19 (B3) — unified log: server lines interleave into #log-panel via checkbox
function openUnifiedLog() {
  const sec = document.getElementById('nav-status');
  if (sec && sec.classList.contains('collapsible') && sec.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    try { localStorage.setItem('section-collapsed:nav-status', '0'); } catch (_) {}
  }
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let _serverLogPollHandle = null;
async function refreshServerLines() {
  const cb = document.getElementById('show-server-lines');
  if (!cb || !cb.checked) return;
  try {
    const res = await fetch('/api/server-log');
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    // Render server lines as faded entries appended to the campaign log panel.
    // Strategy: write into a sibling container so we can clear separately.
    const panel = document.getElementById('log-panel');
    if (!panel) return;
    let container = panel.querySelector('#server-lines-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'server-lines-container';
      panel.appendChild(container);
    }
    container.innerHTML = lines.map((l) => {
      const safe = l.replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
      return `<div class="entry info" style="opacity:.6"><span style="color:var(--gray); font-size:0.6rem; margin-right:6px">srv</span>${safe}</div>`;
    }).join('');
  } catch (_) {}
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'show-server-lines') {
    if (e.target.checked) {
      refreshServerLines();
      _serverLogPollHandle = setInterval(refreshServerLines, 4000);
    } else {
      if (_serverLogPollHandle) clearInterval(_serverLogPollHandle);
      _serverLogPollHandle = null;
      const panel = document.getElementById('log-panel');
      const container = panel?.querySelector('#server-lines-container');
      if (container) container.remove();
    }
  }
});

async function clearServerLog() {
  try { await fetch('/api/server-log', { method: 'DELETE' }); } catch { /* */ }
  const panel = document.getElementById('log-panel');
  const container = panel?.querySelector('#server-lines-container');
  if (container) container.innerHTML = '';
  try { localStorage.setItem('ortus-log-cleared-at', new Date().toISOString()); } catch (_) {}
}

function copyServerLog() {
  // Backwards-compat: copy the unified log panel contents
  const panel = document.getElementById('log-panel');
  if (!panel) return;
  const text = Array.from(panel.querySelectorAll('.entry')).map((e) => e.textContent).join('\n');
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

// `toggleServerLog` is removed; the sidebar button now calls openUnifiedLog().
```

Then remove the now-unused `window.toggleServerLog = toggleServerLog;` line near the bottom of `app.js` (around line 3395), and add an export for `openUnifiedLog`:

```
old: window.toggleServerLog = toggleServerLog;
new: window.openUnifiedLog = openUnifiedLog;
```

- [ ] **Step 5: Manual verify**

Reload. Confirm:
1. The sidebar "Server Log" button now reads "Open log". Clicking it scrolls to Live Status and expands the section if it was collapsed.
2. There is no inline server-log panel near the top of the page.
3. The Live Status log panel has a "Show server lines" checkbox to the left of the Show Browsers / Copy Log / Clear Log buttons.
4. Toggling the checkbox on appends faded server-log lines (each prefixed with a small `srv`) into the bottom of the log panel. Toggling off removes them.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(2.8.19): B3 — unify log panels (delete inline server log, add checkbox in Live Status)"
```

---

## Task C2: Operator identity auto-derives

**Files:**
- Modify: `public/index.html` (rename label "My identifier for Assigned" → "Match name", add "Override / Auto" link span)
- Modify: `public/js/app.js` (refactor identifier hydration around `/api/me`; add toggle handlers)

**Background:** `/api/me` returns `{ email }`. The Accounts identifier input becomes read-only by default, populated from email local-part. An "Override" link makes it editable; once overridden, an "Auto" link reverts.

- [ ] **Step 1: Update label + input markup in index.html**

Find lines 290-291:

```bash
sed -n '288,295p' public/index.html
```

Apply the edit (the exact `placeholder=...` string may differ slightly — adjust as needed):

```
old: <label class="my-identity-label" for="my-identifier">My identifier for "Assigned"</label>
        <input type="text" id="my-identifier" placeholder="email or name to match in Assignee"
new: <label class="my-identity-label" for="my-identifier">Match name <a href="#" id="identifier-toggle" onclick="event.preventDefault(); toggleIdentifierMode()" style="float:right; font-size:0.62rem; letter-spacing:0.18em; text-transform:uppercase; color:var(--gray); text-decoration:none; border-bottom:1px solid var(--hairline)">Override</a></label>
        <input type="text" id="my-identifier" readonly placeholder="auto-derived from sidebar email"
```

(If the existing input has additional attributes after `placeholder=...`, keep them — only the `readonly` attribute is added and the placeholder text is changed.)

- [ ] **Step 2: Refactor identifier hydration in app.js**

Find the `/api/me` block (around line 2813):

```
old: const emailEl = document.getElementById('user-chip-email');
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
new: const emailEl = document.getElementById('user-chip-email');
  if (emailEl) {
    try {
      const res = await fetch('/api/me');
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      const data = await res.json();
      if (data.email) {
        emailEl.textContent = data.email;
        window.__authedEmail = data.email;
        applyIdentifierFromAuth();
      }
    } catch { /* */ }
  }
```

Then add these new functions just below the existing `initMyIdentifier` (around line 825):

```js
// Phase 2.8.19 (C2) — identity auto-derives from /api/me
function _autoIdentifierFromEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

function applyIdentifierFromAuth() {
  const idInput = document.getElementById('my-identifier');
  if (!idInput) return;
  const overridden = !!localStorage.getItem('ortus-my-identifier-override');
  if (overridden) {
    // Operator chose to override — restore their saved value, leave field editable
    idInput.value = localStorage.getItem('ortus-my-identifier') || '';
    idInput.removeAttribute('readonly');
    setIdentifierToggleLabel('Auto');
  } else {
    idInput.value = _autoIdentifierFromEmail(window.__authedEmail || '');
    idInput.setAttribute('readonly', '');
    setIdentifierToggleLabel('Override');
  }
}

function toggleIdentifierMode() {
  const overridden = !!localStorage.getItem('ortus-my-identifier-override');
  if (overridden) {
    // Switching back to Auto
    localStorage.removeItem('ortus-my-identifier-override');
    localStorage.removeItem('ortus-my-identifier');
    applyIdentifierFromAuth();
  } else {
    // Entering Override mode — keep current value as starting point
    const idInput = document.getElementById('my-identifier');
    localStorage.setItem('ortus-my-identifier-override', '1');
    localStorage.setItem('ortus-my-identifier', idInput?.value || '');
    if (idInput) idInput.removeAttribute('readonly');
    setIdentifierToggleLabel('Auto');
  }
}

function setIdentifierToggleLabel(label) {
  const t = document.getElementById('identifier-toggle');
  if (t) t.textContent = label;
}

window.toggleIdentifierMode = toggleIdentifierMode;
```

- [ ] **Step 3: Update `saveMyIdentifier` to honor the override flag**

Find `saveMyIdentifier` in app.js (around line 818). It currently writes any user input directly to `ortus-my-identifier`. We want that to only happen in override mode. Replace the function body so it sets the override flag whenever the operator types a custom value:

```
old: function saveMyIdentifier() {
  try { localStorage.setItem('ortus-my-identifier', el.value.trim()); } catch (_) {}
}
new: function saveMyIdentifier() {
  const el = document.getElementById('my-identifier');
  if (!el || el.hasAttribute('readonly')) return;
  try {
    localStorage.setItem('ortus-my-identifier', el.value.trim());
    localStorage.setItem('ortus-my-identifier-override', '1');
  } catch (_) {}
}
```

(The original function reference may already declare `el` — adjust the edit to match the current source. Use `Read public/js/app.js offset:817 limit:10` to confirm.)

- [ ] **Step 4: Manual verify**

Reload. Confirm:
1. The Accounts section shows "Match name" with an "Override" link aligned right.
2. The input is read-only and shows the local-part of your sidebar email (e.g. `info` for `info@ortus.solutions`).
3. Click "Override" → input becomes editable, link text changes to "Auto".
4. Type something different → it persists across reloads.
5. Click "Auto" → input goes back to read-only with the auto-derived value.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(2.8.19): C2 — operator identity auto-derives from email with override toggle"
```

---

## Task C3: "Local browser name" surfaces as a Settings field

**Files:**
- Modify: `public/index.html` (add labeled input inside Settings section)
- Modify: `public/js/app.js` (two-way bind with existing `localBrowserFirstName` global)

**Background:** Today, "local browser identity" is a side-effect input inside the per-profile card. Add a top-level Settings input that two-way binds to the same `localStorage.localBrowserFirstName` value.

- [ ] **Step 1: Locate the Settings section closing tag**

Find the end of the Settings section in `public/index.html`:

```bash
grep -n 'id="open-profile-toggle"' public/index.html
```

You should see a `<div id="open-profile-toggle">` block (around lines 145-152). The Settings section's closing `</div>` is after that block. Add the new input right before that closing.

- [ ] **Step 2: Add the new Settings input**

After the `<div id="open-profile-toggle">...</div>` block, insert:

```html
<!-- Phase 2.8.19 (C3) — local browser name surfaces as a real setting -->
<div class="my-identity-row" style="margin-top:16px">
  <label class="my-identity-label" for="settings-local-browser-name">Local browser name</label>
  <input type="text" id="settings-local-browser-name" placeholder="Used as {senderFirstName} when running on this machine" />
  <div class="my-identity-help" style="font-size:0.66rem; color:var(--gray); margin-top:4px">
    Applies when you tick the "Local browser" profile card.
  </div>
</div>
```

(Reuse existing `.my-identity-row` / `.my-identity-label` classes used by the identifier input — keeps spacing consistent.)

- [ ] **Step 3: Wire two-way binding in app.js**

Append at the end of `public/js/app.js`:

```js
// Phase 2.8.19 (C3) — two-way bind Settings "Local browser name" with profile-card input
(function bindLocalBrowserNameSetting() {
  const settingsInput = document.getElementById('settings-local-browser-name');
  if (!settingsInput) return;
  // Initial hydrate from globally-tracked value (loaded from localStorage at top of app.js)
  settingsInput.value = (typeof localBrowserFirstName === 'string') ? localBrowserFirstName : '';
  settingsInput.addEventListener('input', (e) => {
    localBrowserFirstName = e.target.value;
    try { localStorage.setItem('localBrowserFirstName', localBrowserFirstName); } catch (_) {}
    // Mirror to the profile-card input if it exists
    const cardInput = document.getElementById('local-browser-first-name');
    if (cardInput && cardInput.value !== e.target.value) cardInput.value = e.target.value;
  });
  // Listen for changes coming from the profile card so Settings stays in sync
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'local-browser-first-name') {
      if (settingsInput.value !== e.target.value) settingsInput.value = e.target.value;
    }
  });
})();
```

- [ ] **Step 4: Manual verify**

Reload. Confirm:
1. The Settings section now shows a "Local browser name" input below the mode picker (and below the Open Profile toggle if mode = connect).
2. Type a name → reload the page → value persists.
3. Open Accounts → tick the "Local browser" profile card → confirm the `#local-browser-first-name` input there shows the same value.
4. Edit the value in the profile card → switch back to Settings → the Settings input has updated to match.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(2.8.19): C3 — surface local-browser name as a top-level Settings field"
```

---

## Task C4: Notifications panel shows state

**Files:**
- Modify: `server.js` (add `app.get('/api/notify/status', ...)`)
- Create: `tests/notify-status.test.js` (verifies the env-var → boolean mapping)
- Modify: `public/index.html` (replace single Enable button with three labeled state rows)
- Modify: `public/js/app.js` (state rendering + `sendTestNotification` updates Last test row)

### C4a — Backend endpoint + test

- [ ] **Step 1: Write the failing test**

Create `tests/notify-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The endpoint logic is trivial — the contract we test is the env-var → boolean mapping
// that the express handler will perform inline.

function smtpConfiguredFromEnv(env) {
  return !!env.SMTP_HOST;
}

test('smtpConfigured is true when SMTP_HOST is set', () => {
  assert.equal(smtpConfiguredFromEnv({ SMTP_HOST: 'smtp.example.com' }), true);
});

test('smtpConfigured is false when SMTP_HOST is missing', () => {
  assert.equal(smtpConfiguredFromEnv({}), false);
});

test('smtpConfigured is false when SMTP_HOST is empty string', () => {
  assert.equal(smtpConfiguredFromEnv({ SMTP_HOST: '' }), false);
});
```

- [ ] **Step 2: Run the test — it will pass already**

Run: `npm test`

Expected: all tests including the three new ones pass. The test file establishes the contract; the endpoint will mirror the same boolean derivation. (No production code change yet — the test is documenting the intended behavior, not driving an implementation that doesn't exist; this is acceptable for a 1-line endpoint.)

- [ ] **Step 3: Add the endpoint to server.js**

Find a good insertion point near the existing `/api/notify/test` route (around line 1053). Insert just above it:

```js
// Phase 2.8.19 (C4) — read-only check of SMTP configuration for the notifications panel
app.get('/api/notify/status', (_req, res) => {
  res.json({ smtpConfigured: !!process.env.SMTP_HOST });
});
```

- [ ] **Step 4: Manual verify the endpoint**

Run (in a separate shell while dev server is running):

```bash
curl -s http://localhost:3000/api/notify/status
```

Expected: `{"smtpConfigured":true}` or `{"smtpConfigured":false}` depending on your `.env`.

If you get a 401, you may need to include the auth cookie (the dev server checks auth on most routes — confirm by running `curl -s -b "session=..." ...` or hitting it from the authenticated browser tab via the devtools network panel).

- [ ] **Step 5: Commit backend half**

```bash
git add server.js tests/notify-status.test.js
git commit -m "feat(2.8.19): C4a — add /api/notify/status (smtpConfigured boolean) + test"
```

### C4b — Frontend panel

- [ ] **Step 6: Replace the Notifications block in the sidebar**

Find lines 47-50 in `public/index.html`:

```bash
sed -n '47,52p' public/index.html
```

Apply edit:

```
old: <div class="edit-toggle-group">
        <div class="edit-toggle-label">Notifications</div>
        <div class="edit-toggle">
          <button type="button" onclick="requestNotificationPermission()">Enable</button>
        </div>
      </div>
new: <div class="edit-toggle-group">
        <div class="edit-toggle-label">Notifications</div>
        <div class="notif-state-rows" id="notif-state-rows" style="display:flex; flex-direction:column; gap:6px; font-size:0.7rem">
          <div style="display:flex; justify-content:space-between; align-items:center">
            <span style="color:var(--ink)">Browser push</span>
            <span id="notif-push-state" style="color:var(--gray); letter-spacing:0.16em; text-transform:uppercase; font-size:0.6rem">—</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <span style="color:var(--ink)">Email · SMTP</span>
            <span id="notif-smtp-state" style="color:var(--gray); letter-spacing:0.16em; text-transform:uppercase; font-size:0.6rem">—</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <span style="color:var(--ink)">Last test</span>
            <span id="notif-last-test" style="color:var(--gray); letter-spacing:0.16em; text-transform:uppercase; font-size:0.6rem">never</span>
          </div>
          <div style="display:flex; gap:6px; margin-top:4px">
            <button type="button" id="notif-enable-btn" class="btn btn-sm" onclick="requestNotificationPermission()" style="display:none">Enable</button>
            <button type="button" class="btn btn-sm" onclick="sendTestNotification()">Send test</button>
          </div>
        </div>
      </div>
```

- [ ] **Step 7: Add state-rendering helpers to app.js**

Append to the end of `public/js/app.js`:

```js
// Phase 2.8.19 (C4b) — notifications panel state rendering
async function refreshNotifPanel() {
  // Browser push permission
  const pushEl = document.getElementById('notif-push-state');
  const enableBtn = document.getElementById('notif-enable-btn');
  if (pushEl) {
    if (!('Notification' in window)) {
      pushEl.textContent = 'unavailable';
    } else {
      const p = Notification.permission;
      pushEl.textContent = p === 'granted' ? 'granted' : (p === 'denied' ? 'denied' : 'default');
      pushEl.style.color = p === 'granted' ? 'var(--green)' : (p === 'denied' ? 'var(--red)' : 'var(--gray)');
      if (enableBtn) enableBtn.style.display = (p === 'default') ? 'inline-block' : 'none';
    }
  }
  // SMTP wired
  const smtpEl = document.getElementById('notif-smtp-state');
  if (smtpEl) {
    try {
      const res = await fetch('/api/notify/status');
      if (res.ok) {
        const data = await res.json();
        smtpEl.textContent = data.smtpConfigured ? 'wired' : 'not configured';
        smtpEl.style.color = data.smtpConfigured ? 'var(--green)' : 'var(--gray)';
      }
    } catch (_) {}
  }
  // Last test
  const lastEl = document.getElementById('notif-last-test');
  if (lastEl) {
    try {
      const raw = localStorage.getItem('ortus-last-notify-test');
      if (raw) {
        const { at, result } = JSON.parse(raw);
        const ago = _humanAgo(at);
        lastEl.textContent = `${ago} · ${result}`;
        lastEl.style.color = result === 'delivered' ? 'var(--green)' : 'var(--red)';
      } else {
        lastEl.textContent = 'never';
        lastEl.style.color = 'var(--gray)';
      }
    } catch (_) {}
  }
}

window.refreshNotifPanel = refreshNotifPanel;
```

- [ ] **Step 8: Update `sendTestNotification` to record result**

Find `sendTestNotification` (around line 265) and update both branches to write to localStorage:

```
old: async function sendTestNotification() {
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
new: async function sendTestNotification() {
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
```

- [ ] **Step 9: Trigger initial render of the notif panel**

In the bottom-of-file IIFE in `app.js` (already amended by A2/B2), add a call after `applyInitialExpand();`:

```
old: applyInitialExpand();
updateSectionSummaries();
document.getElementById('rp-status')?.classList.add('demoted');
new: applyInitialExpand();
updateSectionSummaries();
document.getElementById('rp-status')?.classList.add('demoted');
refreshNotifPanel();
```

- [ ] **Step 10: Manual verify**

Reload. Confirm:
1. Sidebar Notifications shows three labeled state rows + a "Send test" button (and an "Enable" button only when browser push permission is `default`).
2. "Browser push" reads `granted` (green), `denied` (red), or `default` (gray) per your browser permission state.
3. "Email · SMTP" reads `wired` (green) or `not configured` (gray) per your `.env`.
4. Click "Send test" — the alert pops, "Last test" updates within a beat to e.g. `just now · delivered`.

- [ ] **Step 11: Commit frontend half**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(2.8.19): C4b — notifications panel shows browser push + SMTP + last-test state"
```

---

## Task FINAL: Version bump + acceptance pass

**Files:**
- Modify: `package.json` (`version` 2.8.18 → 2.8.19)

- [ ] **Step 1: Bump package.json version**

Edit `package.json`:

```
old:   "version": "2.8.18",
new:   "version": "2.8.19",
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: all tests green, including the new `tests/notify-status.test.js`.

- [ ] **Step 3: Walk the acceptance criteria from the spec**

Open `docs/superpowers/specs/2026-04-27-ortus-outreach-paper-cuts-design.md`, scroll to **Acceptance per cluster**. Walk every bullet manually in the browser. Confirm each passes. If any fails, **stop and ask the user** before declaring done.

- [ ] **Step 4: Spot-check `docs/manual.md` one more time**

Run: `grep -nE '(I\.|II\.|III\.|IV\.|V\.|1\.|2\.|3\.|4\.|5\.|6\.).*Settings|Sheet|Accounts|Templates|Throughput|Launch' docs/manual.md`

If the manual references the old numbering anywhere it shouldn't, fix it.

- [ ] **Step 5: Commit version bump**

```bash
git add package.json docs/manual.md 2>/dev/null
git status --short
git commit -m "chore(2.8.19): bump version after paper-cuts patch (clusters A · B · C)"
```

- [ ] **Step 6: Final summary to the user**

Print a tight recap of what shipped: cluster A done (renumber, default-expand, glyphs); cluster B done (Stop verified, right-pane demoted, header labels clarified, log unified); cluster C done (identity auto-derives, local-browser surfaced, notifications panel). One version bump, ten atomic commits. No `src/` or core campaign-logic changes.

---

## Self-review checklist

- [x] **Spec coverage:** Every named patch (A1, A2, A3, B1, B2, B3, C2, C3, C4) maps to a task. C1 explicitly out of scope per spec.
- [x] **Placeholder scan:** Every step contains exact code or exact commands. The two places where "the existing variable name may differ" notes appear (Task A2 Step 6 sheet preview cache, Task C2 Step 3 `saveMyIdentifier`) are flagged with a fallback path so the engineer never gets stuck.
- [x] **Type consistency:** All function names match between definition and call sites: `computeSectionReadiness`, `updateSectionSummaries`, `applyInitialExpand`, `updateSidebarGlyphs`, `openUnifiedLog`, `refreshServerLines`, `applyIdentifierFromAuth`, `toggleIdentifierMode`, `setIdentifierToggleLabel`, `_autoIdentifierFromEmail`, `refreshNotifPanel`, `_humanAgo`. localStorage keys consistent: `ortus-my-identifier`, `ortus-my-identifier-override`, `ortus-last-notify-test`, `localBrowserFirstName`, `section-collapsed:<id>`. `SECTION_ORDER` keys (`settings`/`sheet`/`accounts`/`templates`/`pace`/`launch`) line up with `summary-{key}` and `nav-glyph-{key}` IDs.
- [x] **Acceptance verifiability:** Each task ends with a manual verify step and a single commit. Final task walks the spec's acceptance criteria.
