# Drafts Isolation — Executable Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-27-drafts-isolation-design.md`
**Branch:** `drafts-isolation-v2.60.1`
**Picked variants (2026-05-27):**
- Editing-header inside the wizard: **B (full-width banner with launch CTA inside it)**
- Resume chip on the dashboard: **A (pill next to "+ Start new campaign")**

**Goal:** Tighten the drafts system so autosave is bulletproof, the active draft id never desyncs, the operator always sees what they're editing, and jumping away preserves state. After this lands: save no longer creates duplicates; jumping to monitoring + back does not lose work; an unfinished draft is one click away from the dashboard.

**Architecture:** Replace the brittle `currentDraftIsNew` localStorage flag with a deterministic `activeDraftId` string. Add debounced autosave on every wizard input. Move the "+ Add to queue" launch CTA into a banner at the top of the wizard. Add a small resume pill to the dashboard header that appears when `activeDraftId` points to an existing draft.

**Tech stack:** Node ≥22, vanilla JS modules, no bundler, `node --test`. Server: Express 4.

---

## Phase 1 — Backend nit: lastEditedAt on drafts

Cheapest task. Adds the field every other task needs.

### Task 1: Add lastEditedAt to drafts on every write

**Files:**
- Modify: `src/drafts.js`
- Test: `tests/drafts-last-edited.test.js`

- [ ] **Step 1: Read the existing drafts.js**

```bash
cat src/drafts.js | wc -l   # ~118 lines, small module
```

Verify the function names exist: `addDraft`, `updateDraft`, `getDrafts`, `getDraft`, `removeDraft`. The plan assumes these names — adjust if reality differs.

- [ ] **Step 2: Write the failing test**

```js
// tests/drafts-last-edited.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-drafts-test-' + process.pid);

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;
});
afterEach(() => {
  delete process.env.ORTUS_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('addDraft sets lastEditedAt to current time', async () => {
  const { addDraft } = await import('../src/drafts.js?lastEdited=' + Date.now());
  const before = Date.now();
  const r = addDraft({ name: 'X', config: {} });
  const after = Date.now();
  const t = new Date(r.draft.lastEditedAt).getTime();
  assert.ok(t >= before && t <= after, `lastEditedAt ${t} not in [${before}, ${after}]`);
});

test('updateDraft bumps lastEditedAt', async () => {
  const { addDraft, updateDraft } = await import('../src/drafts.js?lastEdited=' + Date.now());
  const r = addDraft({ name: 'X', config: {} });
  const initial = new Date(r.draft.lastEditedAt).getTime();
  await new Promise(res => setTimeout(res, 10));
  const u = updateDraft(r.draft.id, { name: 'X-renamed' });
  const updated = new Date(u.lastEditedAt).getTime();
  assert.ok(updated > initial, `updated ${updated} should be > initial ${initial}`);
});

test('getMostRecentDraft returns the most recently edited', async () => {
  const { addDraft, updateDraft, getMostRecentDraft } = await import('../src/drafts.js?lastEdited=' + Date.now());
  const a = addDraft({ name: 'A', config: {} }).draft;
  await new Promise(res => setTimeout(res, 5));
  const b = addDraft({ name: 'B', config: {} }).draft;
  await new Promise(res => setTimeout(res, 5));
  updateDraft(a.id, { name: 'A-updated' }); // now A is most recent
  const recent = getMostRecentDraft();
  assert.strictEqual(recent.id, a.id);
});

test('getMostRecentDraft returns null if no drafts', async () => {
  const { getMostRecentDraft } = await import('../src/drafts.js?lastEdited=' + Date.now());
  assert.strictEqual(getMostRecentDraft(), null);
});

test('getDraft on an existing draft includes lastEditedAt', async () => {
  const { addDraft, getDraft } = await import('../src/drafts.js?lastEdited=' + Date.now());
  const r = addDraft({ name: 'X', config: {} });
  const fetched = getDraft(r.draft.id);
  assert.ok(fetched.lastEditedAt);
});
```

Note: the `?lastEdited=` cache-buster on the import URL is to defeat ESM caching across tests. If your repo uses a different import pattern, mirror it.

- [ ] **Step 3: Run to confirm failure**

```bash
node --test tests/drafts-last-edited.test.js
```

Expected: tests fail (getMostRecentDraft not exported; lastEditedAt missing).

- [ ] **Step 4: Implement in src/drafts.js**

Add `lastEditedAt: new Date().toISOString()` to both `addDraft` and `updateDraft` write paths. Add a `getMostRecentDraft()` export that returns the draft with the latest `lastEditedAt`, or `null` if no drafts.

If `addDraft` and `updateDraft` use a shared write helper, add the timestamp there. Otherwise add to both. Match the existing atomic .tmp+rename pattern.

For backward compat: when reading a draft that lacks `lastEditedAt` (existing data), default to `createdAt` if present, else to `Date.now()` — and write back the inferred value on the next update.

- [ ] **Step 5: Run tests**

```bash
node --test tests/drafts-last-edited.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 6: Full suite to confirm no regressions**

```bash
npm test
```

Expected: pre-existing pass count + 5. (3 pre-existing failures in `post-launch-tips.test.js` are unrelated — see dashboard-v3 history.)

- [ ] **Step 7: Commit**

```bash
git add src/drafts.js tests/drafts-last-edited.test.js
git commit -m "add: lastEditedAt timestamp + getMostRecentDraft helper on drafts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Wizard state machine: activeDraftId + autosave

The biggest phase. Touches multiple sections of app.js. Multiple sub-tasks committed atomically.

### Task 2: Audit and remove currentDraftIsNew references

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Inventory all callsites**

```bash
grep -n "currentDraftIsNew" public/js/app.js
```

Expected (from prior research): ~5–7 callsites near lines 34, 45, 3046, 7101, 7109, 8966, 9037.

Read each callsite and classify into one of these categories:
- **Replaceable**: code that checks "is this a new draft?" — replace with `!activeDraftId` or `activeDraftId === null`
- **Removable**: code that sets the flag — remove (replaced by `activeDraftId` setter elsewhere)
- **Keep**: code that uses the flag for a legacy concern unrelated to draft identity (probably zero, but verify)

Document each callsite's category in the commit message.

- [ ] **Step 2: Add the new state primitive at the top of app.js (or near initTheme)**

```js
// ─────────────────────────────────────────────────────────────────────────
// Draft state: activeDraftId is the single source of truth for which draft
// the wizard is currently editing. Set by startNewCampaign(), editDraft(),
// or by clicking the resume pill. Cleared by launching the draft (via
// /api/campaign/queue-only) or by explicit cancel.
// ─────────────────────────────────────────────────────────────────────────

const ACTIVE_DRAFT_KEY = 'ortus.activeDraftId';

function getActiveDraftId() {
  try { return localStorage.getItem(ACTIVE_DRAFT_KEY) || null; } catch { return null; }
}

function setActiveDraftId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_DRAFT_KEY, id);
    else localStorage.removeItem(ACTIVE_DRAFT_KEY);
  } catch {}
}

function clearActiveDraft() {
  setActiveDraftId(null);
}
```

- [ ] **Step 3: Replace each currentDraftIsNew callsite with activeDraftId logic**

For each callsite identified in Step 1:
- Lines around `34, 45`: `if (localStorage.getItem('currentDraftIsNew') === '1') return true;` → `if (!getActiveDraftId()) return true;` (the function probably returns true when no draft is loaded; verify the meaning)
- Lines around `3046, 7101, 7109`: `localStorage.removeItem('currentDraftIsNew');` → `clearActiveDraft();`
- Lines around `8966, 9037`: `try { isNewCampaign = localStorage.getItem('currentDraftIsNew') === '1'; } catch {}` → `const isNewCampaign = !getActiveDraftId();`

Each change is small. Do them one at a time, restart dev:app between groups if you want to verify nothing breaks.

- [ ] **Step 4: Restart dev:app and smoke test**

```bash
pkill -f "npm.*dev:app" 2>/dev/null
pkill -f "Electron.*ortus" 2>/dev/null
sleep 2
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 8
tail -50 /tmp/dev-app.log | grep -iE "error|undefined" | head -10
```

Expected: 0 errors. Open the app, navigate `#/` ↔ `#/new`, confirm no console errors. The Save/Launch flows are likely broken at this point — that's fine; the next task fixes them.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "refactor(drafts): replace currentDraftIsNew flag with activeDraftId

Replaces the boolean 'is this a new draft' flag with a deterministic string
that holds the active draft id (or null). Removes desync risk between flag
and actual draft state. Backward compat: legacy localStorage key
'currentDraftIsNew' is no longer read or written.

Callsites updated (5 total): <line numbers from grep>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Implement debounced autosave

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Locate the wizard input listeners**

```bash
grep -n "wizardDirtyOnInput\|initWizardDirtyTracking" public/js/app.js
```

Expected: around lines 9077, 9084, 9098. Read the full function `initWizardDirtyTracking()` — it wires `input` and `change` listeners on every form element under the wizard.

- [ ] **Step 2: Add the autosave function**

Right after `initWizardDirtyTracking`, add:

```js
/* ─────────────────────────────────────────────────────────────
 * Debounced draft autosave.
 * Called on every wizard input. Serializes pending saves so a
 * later PATCH cancels an earlier one. Returns a Promise that
 * resolves when the active save completes — callers like
 * launchFromWizard() use this to FLUSH the queue before launching.
 * ─────────────────────────────────────────────────────────────*/

const AUTOSAVE_DEBOUNCE_MS = 500;
let _autosaveTimer = null;
let _autosavePending = null;
let _lastAutosavedAt = null;

function debouncedAutosave() {
  const id = getActiveDraftId();
  if (!id) return; // No draft → nothing to save
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => { _autosaveTimer = null; _flushAutosave(); }, AUTOSAVE_DEBOUNCE_MS);
}

async function flushAutosaveImmediate() {
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  if (_autosavePending) await _autosavePending;
  await _flushAutosave();
}

async function _flushAutosave() {
  const id = getActiveDraftId();
  if (!id) return;
  const config = collectWizardConfig();          // existing helper, returns the wizard's form values as an object
  const name = (document.getElementById('wizName')?.value || '').trim() || undefined;
  // Serialize: if a previous save is in-flight, await it before starting a new one
  if (_autosavePending) {
    try { await _autosavePending; } catch {}
  }
  _autosavePending = fetch('/api/drafts/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  }).then(async (r) => {
    if (r.ok) {
      _lastAutosavedAt = Date.now();
      updateSavePip();
    } else {
      const body = await r.json().catch(() => ({}));
      console.warn('[drafts] autosave failed:', body);
    }
  }).catch((err) => {
    console.warn('[drafts] autosave error:', err);
  }).finally(() => {
    _autosavePending = null;
  });
  return _autosavePending;
}
```

The `collectWizardConfig()` function must exist (it's called by the existing Save flow). If it doesn't, find the equivalent in the existing save code (probably inline inside `startCampaign` or `submitStartCampaign`) and extract it.

- [ ] **Step 3: Hook autosave into the input listeners**

Find `wizardDirtyOnInput` (around line 9077). After it flips `wizardDirty = true`, add:

```js
function wizardDirtyOnInput() {
  if (wizardDirty) return; // already flagged — no need to re-check
  wizardDirty = true;
  debouncedAutosave();
}
```

Wait — this only triggers autosave on the FIRST input, then never again (because the early return). The autosave must fire on EVERY input. Restructure:

```js
function wizardDirtyOnInput() {
  wizardDirty = true;
  debouncedAutosave();
}
```

Remove the `if (wizardDirty) return;` early-return. The dirty flag is for the legacy code paths that read it; autosave needs every keystroke.

- [ ] **Step 4: Add updateSavePip() helper**

```js
function updateSavePip() {
  const pip = document.getElementById('wiz-save-pip');
  if (!pip) return;
  if (!_lastAutosavedAt) { pip.textContent = '— not saved yet'; return; }
  const sec = Math.round((Date.now() - _lastAutosavedAt) / 1000);
  if (sec < 5) pip.textContent = 'saved just now';
  else if (sec < 60) pip.textContent = `saved ${sec}s ago`;
  else pip.textContent = `saved ${Math.round(sec/60)}m ago`;
}

// Tick the pip every 5s so "saved 30s ago" doesn't stay stale at "5s ago"
setInterval(updateSavePip, 5000);
```

- [ ] **Step 5: Restart dev:app, smoke test**

Verify: no console errors. The wizard isn't visually updated yet (no banner markup) — that's task 4. But you can confirm via DevTools Network tab that typing in fields produces debounced PATCH `/api/drafts/<id>` requests.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "feat(drafts): debounced autosave on every wizard input

Every input/change event on the wizard form triggers a debounced PATCH
/api/drafts/<activeDraftId> after 500ms. Serialized: a later save awaits
the previous in-flight save. flushAutosaveImmediate() exposed for the
launch path to call before reading wizard values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Move "+ Add to queue" button into editing-banner (variant B)

**Files:**
- Modify: `public/index.html` (add banner markup, remove old section-VI button)
- Modify: `public/js/app.js` (hook the banner button)
- Modify: `public/css/style.css` (banner styles)

- [ ] **Step 1: Locate the wizard markup**

```bash
grep -n 'id="wiz-body"\|id="ws-launch"\|class="launch-start"' public/index.html
```

Find the wizard body container and the section-VI launch button. Document line numbers.

- [ ] **Step 2: Add the editing-banner markup**

Inside `.wiz-body` (top of it, before any `.wiz-section`), add:

```html
<div id="wiz-editing-banner" class="wiz-editing-banner" style="display:none;">
  <div class="wiz-editing-banner-left">
    <span class="wiz-editing-banner-lbl">Editing</span>
    <span class="wiz-editing-banner-name" id="wiz-editing-name">Untitled draft</span>
  </div>
  <div class="wiz-editing-banner-right">
    <span class="wiz-save-pip" id="wiz-save-pip">— not saved yet</span>
    <button type="button" class="wiz-editing-launch" onclick="window.launchFromBanner()">+ Add to queue</button>
  </div>
</div>
```

Set `display:none` initially — the banner only shows when `activeDraftId` is set.

- [ ] **Step 3: Remove the old launch-start button at the bottom of section VI**

Find the `<button class="launch-start" onclick="startFromWizard()">+ Add to queue</button>` (or similar) inside `#ws-launch`. Delete the button and the `.launch-row` wrapping it (if the wrapper has no other content). Keep `#ws-launch` itself — the section may still exist as a "review your settings before launching" surface, just without the button.

If the section becomes empty, leave a placeholder comment or a small "Review your config above, then click Add to queue at the top" note.

- [ ] **Step 4: Add window.launchFromBanner**

In app.js, near `startFromWizard` (the existing launch handler):

```js
window.launchFromBanner = async function() {
  // 1. Flush any pending autosave so the queued config matches what's on screen
  await flushAutosaveImmediate();
  // 2. Delegate to the existing launch flow
  if (typeof startFromWizard === 'function') startFromWizard();
  else if (typeof submitStartCampaign === 'function') submitStartCampaign({ queueOnly: true });
};
```

The existing launch flow (`startFromWizard` / `submitStartCampaign`) already handles draft cleanup. Confirm it does by reading those functions — if it does NOT delete the draft on successful queue, add `await fetch('/api/drafts/' + getActiveDraftId(), { method:'DELETE' });` + `clearActiveDraft();` after the queue POST succeeds.

- [ ] **Step 5: Show/hide the banner based on activeDraftId**

Add `window.updateEditingBanner()`:

```js
window.updateEditingBanner = function() {
  const banner = document.getElementById('wiz-editing-banner');
  if (!banner) return;
  const id = getActiveDraftId();
  if (!id) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  // Pull the current draft name from the wizName input (it's the canonical source)
  const nameInput = document.getElementById('wizName');
  const nameEl = document.getElementById('wiz-editing-name');
  if (nameEl) nameEl.textContent = (nameInput?.value || '').trim() || 'Untitled draft';
  updateSavePip();
};
```

Call `updateEditingBanner()` from:
- `startNewCampaign()` after the draft is created
- `editDraft(id)` after the draft is loaded
- Inside the wizard's name input change listener (so the banner name updates live as the operator edits the field)
- On route entry to `#/new`

- [ ] **Step 6: Add the CSS**

Append to `public/css/style.css`:

```css
.wiz-editing-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 28px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.025);
}
body.theme-light .wiz-editing-banner { background: rgba(0, 0, 0, 0.025); }
.wiz-editing-banner-left { display: flex; align-items: baseline; gap: 14px; }
.wiz-editing-banner-lbl { font-family: var(--mono); font-size: 0.56rem; letter-spacing: 0.24em; text-transform: uppercase; color: var(--gray); }
.wiz-editing-banner-name { font-family: var(--display); font-size: 1.4rem; letter-spacing: 0.02em; color: var(--ink); }
.wiz-editing-banner-right { display: flex; align-items: center; gap: 18px; }
.wiz-save-pip { font-family: var(--mono); font-size: 0.62rem; color: var(--gray); display: inline-flex; align-items: center; gap: 6px; }
.wiz-save-pip::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 9999px; background: var(--green); }
.wiz-editing-launch {
  background: var(--ink); color: var(--gold);
  border: 1px solid var(--ink); border-radius: 9999px;
  padding: 9px 22px; font-family: var(--mono); font-size: 0.64rem;
  font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
  cursor: pointer;
}
.wiz-editing-launch:hover { opacity: 0.85; }
```

- [ ] **Step 7: Restart, verify**

Open Electron, navigate to `#/new`, confirm:
- Banner visible at top of wizard body
- Name updates live when you type in wizName
- Save pip updates within 500ms-1s of typing
- "+ Add to queue" button works (queues a campaign, banner disappears, draft is gone)

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(drafts): editing-banner with autosave pip + launch CTA (variant B)

Replaces the bottom-of-section-VI '+ Add to queue' button with a banner
pinned to the top of the wizard body. Banner shows draft name + save pip
+ launch CTA. Visible only when activeDraftId is set. Launch flushes
pending autosave first, then queues, then deletes the draft.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Dashboard resume chip (variant A)

### Task 5: Add the resume pill to dashboard header

**Files:**
- Modify: `public/index.html` (chip markup in dashboard-header-right)
- Modify: `public/js/app.js` (render + click handler)
- Modify: `public/css/style.css` OR `public/css/dashboard-v0.3.css` (styles)

- [ ] **Step 1: Locate dashboard header markup**

```bash
grep -n 'class="dashboard-header-right"\|class="slots-pill"' public/index.html
```

The pill should sit between any existing left-side header content and the slots-pill / Start button.

- [ ] **Step 2: Add chip markup**

Inside `.dashboard-header-right`, BEFORE the `.slots-pill`:

```html
<button type="button" class="resume-draft-pill" id="resume-draft-pill" style="display:none;" onclick="window.dashResumeDraft()" title="Resume editing">
  <svg class="resume-draft-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
  <span class="resume-draft-lbl">Resume</span>
  <span class="resume-draft-name" id="resume-draft-name"></span>
</button>
```

Hidden by default. Shown by the renderer when an unfinished draft exists.

- [ ] **Step 3: Add render + handler in app.js**

In the v3 dashboard renderers section (after `renderPastSection`):

```js
window.renderResumeDraftPill = async function() {
  const pill = document.getElementById('resume-draft-pill');
  const nameEl = document.getElementById('resume-draft-name');
  if (!pill || !nameEl) return;
  const id = getActiveDraftId();
  if (!id) { pill.style.display = 'none'; return; }
  // Verify the draft still exists server-side; if not, clear the stale id
  try {
    const r = await fetch('/api/drafts/' + encodeURIComponent(id));
    if (!r.ok) { clearActiveDraft(); pill.style.display = 'none'; return; }
    const draft = await r.json();
    nameEl.textContent = (draft.name || 'Untitled draft').slice(0, 32);
    pill.style.display = 'inline-flex';
  } catch (err) {
    console.warn('[drafts] resume pill fetch:', err);
    pill.style.display = 'none';
  }
};

window.dashResumeDraft = function() {
  window.location.hash = '#/new';
  // editDraft (existing function) hydrates the wizard form from the draft id
  setTimeout(() => {
    const id = getActiveDraftId();
    if (id && typeof editDraft === 'function') editDraft(id);
  }, 50);
};
```

If `editDraft` doesn't exist by that name, find the equivalent — there's a flow somewhere that loads a draft into the wizard form by id (look for `getDraft` callers in app.js).

- [ ] **Step 4: Wire into dashboard refresh**

Find `refreshDashboard()` (around line 6943 in pre-v0.3 line numbering — adjust after the dashboard-v3 commits). Add `window.renderResumeDraftPill();` next to the other `render*` calls.

Also hook into the 5s `_dashboardPollTimer` for live updates if the draft is edited from another path. Or simpler: only re-render the pill when the user navigates to `#/` or when a draft action completes. Either is fine; simpler is better.

- [ ] **Step 5: Add styles**

Append to `public/css/style.css`:

```css
.resume-draft-pill {
  display: inline-flex; align-items: center; gap: 10px;
  border: 1px solid var(--hairline);
  border-radius: 9999px;
  padding: 8px 16px;
  background: transparent;
  color: var(--ink);
  font-family: var(--mono); font-size: 0.62rem;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.resume-draft-pill:hover { border-color: var(--ink); background: rgba(255,255,255,0.05); }
body.theme-light .resume-draft-pill:hover { background: rgba(0,0,0,0.04); }
.resume-draft-icon { width: 12px; height: 12px; color: var(--gold); }
.resume-draft-lbl { letter-spacing: 0.22em; text-transform: uppercase; color: var(--gray); }
.resume-draft-name { color: var(--ink); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 6: Restart, verify**

- Start a new draft in the wizard, navigate back to `#/` → pill visible, name correct
- Launch the draft → pill disappears
- Manually delete `activeDraftId` from localStorage → pill disappears on next render
- Click the pill → returns to wizard with that draft loaded

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(drafts): resume-draft pill in dashboard header (variant A)

Shows when activeDraftId is set and the draft exists server-side. Click
navigates to #/new and hydrates the wizard with that draft. Sits next to
the slots pill in the dashboard header. Self-cleans stale ids (if the
draft was deleted from another path, the pill stays hidden).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Multi-draft coexistence + section preservation polish

### Task 6: Ensure switching drafts retargets autosave correctly

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Locate the existing draft-switch flow**

```bash
grep -n "editDraft\|function loadDraft\|switchDraft" public/js/app.js
```

Find the function that hydrates the wizard from a clicked draft (in the drafts list panel). This is the entry point for switching A → B.

- [ ] **Step 2: Wrap it with autosave-flush**

```js
const origEditDraft = window.editDraft; // capture existing
window.editDraft = async function(newId) {
  // Flush any pending save for the CURRENT active draft
  await flushAutosaveImmediate();
  // Switch the active draft id
  setActiveDraftId(newId);
  // Delegate to the original loader (which hydrates form fields from the new draft)
  await origEditDraft(newId);
  // Update the banner + save pip
  if (typeof window.updateEditingBanner === 'function') window.updateEditingBanner();
};
```

If `editDraft` doesn't exist, find the actual function name + wrap it analogously.

- [ ] **Step 3: Verify**

Manual test:
- Open Draft A. Type "X" in the name field. Wait for "saved 1s ago".
- Switch to Draft B in the drafts list. Type "Y" in B's name field.
- Switch back to A. → Name field should show "X" (preserved). Save pip should show A's `lastEditedAt`.
- Drafts list count should not have changed (no duplicates created).

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "fix(drafts): flush pending autosave before switching drafts

Prevents the race where switching A → B mid-save lands A's changes on B.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Verification

### Task 7: Manual click-through against the 10 guarantees

Each numbered check from the spec gets a manual pass. The agent shouldn't fake this — the operator (Antonio) clicks through.

- [ ] **Restart dev:app fresh**

```bash
pkill -f "npm.*dev:app" 2>/dev/null
pkill -f "Electron.*ortus" 2>/dev/null
sleep 2
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 8
```

- [ ] **Run the 10 checks** (see spec for full text; abbreviated here):

1. **Autosave fires** — type in any wizard field, watch the save pip update within ~1s. Network tab shows PATCH /api/drafts/<id>.
2. **Single draft id** — type in 3 different fields. All 3 PATCHes target same id.
3. **Editing context visible** — banner shows "Editing: <name>". Name updates live.
4. **Jump-and-return** — type in field, navigate to `#/`, return to `#/new`. Field still populated.
5. **Resume chip** — after step 4, while on `#/`, pill visible. Click → returns to wizard with form populated.
6. **Launch deletes draft** — click "+ Add to queue" in banner. Draft row removed from drafts.json. activeDraftId cleared.
7. **Multi-draft switch** — open Draft A, edit field, switch to Draft B, switch back to A. A's field still has its value.
8. **Hard guard** — set `activeDraftId=<existing-id>` manually in localStorage. Type in field. PATCH (not POST) fires.
9. **Close-and-reopen** — type "XYZ" in name, quit app (Cmd+Q), reopen. Resume pill shows "XYZ".
10. **Section preservation** — fill Settings (daily limit = 25), switch to Templates, edit a template, switch back. Daily limit still 25.

Plus **regression checks** (must still work after the changes):
- All v0.3 dashboard buttons (Active card, Monitoring, Up Next, Calendar, Past)
- Wizard launch via banner button → real campaign queued
- Multiple existing drafts in `data/drafts.json` still listed correctly
- Existing campaigns (running, queued, past) unchanged
- Console clean

- [ ] **If any check fails:** STOP. Document the failure (which check, what you saw, what you expected). Open a fix in a follow-up commit on the same branch.

- [ ] **When all 10 pass + regressions clean:** ready to merge to main.

---

## Self-review checklist (pre-execution)

- [ ] All file paths are exact
- [ ] Every code block shows actual code (no "implement appropriate logic" placeholders)
- [ ] Every test step has its expected outcome
- [ ] Each commit message is real (not generic "fix bug")
- [ ] Phase 1 (Backend) is independent → can dispatch as first subagent
- [ ] Phase 2 (state machine refactor) MUST run before Phase 3 (autosave) and Phase 4 (banner)
- [ ] Phase 3 + Phase 4 inside Task 2-3-4 can be in one subagent (all touch app.js + index.html + style.css together)
- [ ] Phase 3 (resume chip) is independent of Phase 2's autosave — could parallelize, but cleaner to serialize for verification
- [ ] Phase 5 is the manual gate, not an agent task

## Parallelism plan

- **Agent A (Phase 1):** Task 1 (backend lastEditedAt). Self-contained.
- **Agent B (Phase 2):** Tasks 2 + 3 + 4 (state machine + autosave + banner). All touch app.js / index.html / style.css together; serialize within one agent to avoid merge conflicts.
- **Agent C (Phase 3):** Task 5 (resume chip). Can start as soon as Agent B finishes Task 2 (needs `getActiveDraftId` defined).
- **Agent D (Phase 4):** Task 6 (multi-draft switch). After Agent C.

Or simpler: one agent does all of Phase 1–4 sequentially, ~6 atomic commits.

Manual verification (Phase 5) is the user's gate.

---

**Status:** Plan drafted 2026-05-27. Awaiting Antonio's review. Once approved → execute via subagent-driven-development.
