# Pre-flight Linter UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four operator-reported UX issues on the pre-flight linter overlay and blocklist panel without touching the lint engine.

**Architecture:** All changes are confined to the vanilla-JS frontend: `public/index.html` (markup), `public/js/app.js` (behaviour around `renderPreflight`, `openBlocklistPanel`, `_pfState`), and `public/css/style.css` (layout/size tokens). No server or engine code is touched.

**Tech Stack:** Vanilla JS (no bundler), Express 4, `node --test` for tests, monochrome Bugatti design system (CSS custom properties).

## Global Constraints

- Never touch `src/preflight-lint.js`, `src/linkedin/`, server gate logic, or tests.
- Never git-add `data/monitoring-campaign.json` or `.env`.
- Files in scope ONLY: `public/index.html`, `public/js/app.js`, `public/css/style.css`.
- Design system: monochrome, hairlines, gold only on Start CTA, radii 0 or 9999. No new accent colours.
- `node --check public/js/app.js server.js` must pass after every task.
- All 27 tests in `tests/preflight-lint.test.js tests/preflight-gate.test.js tests/blocklist.test.js` must stay green — do not run them in-browser; run via `node --test`.
- Do NOT restart the running app (`npm run dev:app`); note at end that a relaunch is needed.
- Branch: `preflight-linter-2135`.

---

### Task 1: CSS legibility overhaul — pf-row grid + bl-row sizes

**Files:**
- Modify: `public/css/style.css` lines ~7738–7780

**Interfaces:**
- Produces: new `.pf-row` grid columns `56px 160px 1fr`, gap `14px`, min row height via padding; `.pf-row.pf-sheet-level` that spans cols 1–2; `.pf-group-head` bumped to `≥0.8rem`; `.pf-tally span` bumped to `≥0.8rem`; `.bl-row` font bumped to `≥0.85rem`.

- [ ] **Step 1: Open the CSS file and read the pf/bl block (lines 7710–7780)** to confirm exact text before editing. (Already done in planning — proceed to edits.)

- [ ] **Step 2: Replace the `.pf-row` rule and related size rules**

In `public/css/style.css`, find and replace:

```css
.pf-row { display: grid; grid-template-columns: 92px 190px 1fr; gap: 18px; align-items: baseline;
  padding: 12px 4px; border-bottom: 1px solid var(--hairline-soft); font-family: var(--mono); }
```
with:
```css
.pf-row { display: grid; grid-template-columns: 56px 160px 1fr; gap: 14px; align-items: baseline;
  padding: 14px 4px; border-bottom: 1px solid var(--hairline-soft); font-family: var(--mono); font-size: 0.85rem; }
```

- [ ] **Step 3: Bump `.pf-row .rowno` size**

Find:
```css
.pf-row .rowno { font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gray); }
```
Replace with:
```css
.pf-row .rowno { font-size: 0.8rem; letter-spacing: 0.06em; color: var(--gray); }
```

- [ ] **Step 4: Bump `.pf-row .lead` and `.pf-row .reason` sizes**

Find:
```css
.pf-row .lead { font-size: 0.78rem; color: var(--ink); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-row .reason { font-size: 0.72rem; color: var(--gray); line-height: 1.55; }
```
Replace with:
```css
.pf-row .lead { font-size: 0.88rem; color: var(--ink); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-row .reason { font-size: 0.85rem; color: var(--gray); line-height: 1.5; }
```

- [ ] **Step 5: Add `.pf-row.pf-sheet-level` rule for null-rowIndex findings**

After the `.pf-passed .pf-row .rowno` rule, insert:
```css
/* Sheet-level findings (rowIndex null) — span row# + lead columns */
.pf-row.pf-sheet-level { grid-template-columns: 1fr; }
.pf-row.pf-sheet-level .rowno { display: none; }
.pf-row.pf-sheet-level .lead { display: none; }
```
(The JS in Task 2 will apply this class and collapse the detail into a single `reason` span.)

- [ ] **Step 6: Bump `.pf-group-head` font size and padding**

Find:
```css
.pf-group-head { display: flex; align-items: baseline; gap: 12px; font-family: var(--mono);
  font-size: 0.74rem; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 14px; }
```
Replace with:
```css
.pf-group-head { display: flex; align-items: baseline; gap: 12px; font-family: var(--mono);
  font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 14px; padding-top: 4px; }
```

- [ ] **Step 7: Bump `.pf-tally span` size**

Find:
```css
.pf-tally span { font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.06em;
  border: 1px solid var(--hairline); border-radius: 9999px; padding: 6px 14px; color: var(--gray); }
```
Replace with:
```css
.pf-tally span { font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.06em;
  border: 1px solid var(--hairline); border-radius: 9999px; padding: 6px 14px; color: var(--gray); }
```

- [ ] **Step 8: Bump `.bl-row` and child sizes**

Find:
```css
.bl-row { display: grid; grid-template-columns: 190px 1fr 150px 70px; gap: 14px; align-items: baseline;
  padding: 12px 4px; border-bottom: 1px solid var(--hairline-soft); font-family: var(--mono); }
.bl-entry { font-size: 0.78rem; font-weight: 500; color: var(--ink); }
.bl-reason-cell { font-size: 0.7rem; color: var(--gray); }
.bl-meta { font-size: 0.62rem; color: var(--gray); }
```
Replace with:
```css
.bl-row { display: grid; grid-template-columns: 190px 1fr 150px 70px; gap: 14px; align-items: baseline;
  padding: 14px 4px; border-bottom: 1px solid var(--hairline-soft); font-family: var(--mono); font-size: 0.85rem; }
.bl-entry { font-size: 0.88rem; font-weight: 600; color: var(--ink); }
.bl-reason-cell { font-size: 0.85rem; color: var(--gray); }
.bl-meta { font-size: 0.72rem; color: var(--gray); }
```

- [ ] **Step 9: Syntax-check**

```bash
node --check public/js/app.js server.js
```
Expected: no output (clean).

- [ ] **Step 10: Run tests**

```bash
node --test tests/preflight-lint.test.js tests/preflight-gate.test.js tests/blocklist.test.js
```
Expected: 27 passing, 0 failing.

- [ ] **Step 11: Commit**

```bash
git add public/css/style.css
git commit -m "fix(preflight): legibility overhaul — larger grid, readable fonts, tally chip sizes"
```

---

### Task 2: renderPreflight — sheet-level row class + blocklist detail untruncated

**Files:**
- Modify: `public/js/app.js` lines ~4896–4922

**Interfaces:**
- Consumes: `.pf-row.pf-sheet-level` CSS class from Task 1.
- Produces: updated `renderPreflight` that (a) emits `class="pf-row pf-sheet-level"` when `f.rowIndex == null`, (b) shows "Sheet" label in `.rowno` for sheet-level findings, (c) ensures `.reason` text is NOT truncated (no `white-space:nowrap` on `.reason` — already correct in CSS; `.lead` has it but reason doesn't — verify only), (d) blocklist detail renders fully in the reason column.

- [ ] **Step 1: Read `renderPreflight` (app.js ~4896–4922)** to confirm exact text. (Done in planning.)

- [ ] **Step 2: Update the `fill` function inside `renderPreflight`**

Find this exact block in `public/js/app.js`:
```javascript
  const fill = (id, list, isFinding) => {
    const el = document.getElementById(id);
    el.innerHTML = list.map((f) => isFinding
      ? `<div class="pf-row"><span class="rowno">${escapeHtml(String(f.rowIndex ?? '—'))}</span><span class="lead">${escapeHtml(f.leadName || '')}</span><span class="reason">${escapeHtml(f.detail)}</span></div>`
      : `<div class="pf-row pf-pass"><span class="rowno">✓</span><span class="reason">${escapeHtml(f.detail)}</span></div>`
    ).join('') || '<div class="pf-row" style="color:var(--gray);font-size:0.72rem">none</div>';
  };
```

Replace with:
```javascript
  const fill = (id, list, isFinding) => {
    const el = document.getElementById(id);
    el.innerHTML = list.map((f) => {
      if (!isFinding) {
        return `<div class="pf-row pf-pass"><span class="rowno">✓</span><span class="reason">${escapeHtml(f.detail)}</span></div>`;
      }
      const isSheetLevel = f.rowIndex == null;
      if (isSheetLevel) {
        return `<div class="pf-row pf-sheet-level"><span class="rowno">Sheet</span><span class="lead"></span><span class="reason">${escapeHtml(f.detail)}</span></div>`;
      }
      return `<div class="pf-row"><span class="rowno">Row ${escapeHtml(String(f.rowIndex))}</span><span class="lead">${escapeHtml(f.leadName || '')}</span><span class="reason">${escapeHtml(f.detail)}</span></div>`;
    }).join('') || '<div class="pf-row pf-sheet-level"><span class="rowno">—</span><span class="lead"></span><span class="reason" style="color:var(--gray)">none</span></div>';
  };
```

Key changes:
- Row number now reads "Row 5" instead of bare "5" for clarity.
- Sheet-level findings (rowIndex null) get `pf-sheet-level` class — CSS hides rowno+lead cols, single column layout.
- `detail` (which includes "Company matches blocklist entry 'IBM' (Client)") renders in `.reason` span — already wraps, not truncated.

- [ ] **Step 3: Syntax-check**

```bash
node --check public/js/app.js server.js
```
Expected: no output.

- [ ] **Step 4: Run tests**

```bash
node --test tests/preflight-lint.test.js tests/preflight-gate.test.js tests/blocklist.test.js
```
Expected: 27 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "fix(preflight): row labels 'Row N', sheet-level findings span full width, reason wraps"
```

---

### Task 3: Blocklist panel — fix header copy

**Files:**
- Modify: `public/index.html` line 3332

**Interfaces:**
- Produces: `bl-eyebrow` text changed from "Settings · shared across all operators" to "Settings · local to this app".

- [ ] **Step 1: Fix the eyebrow copy**

In `public/index.html`, find:
```html
    <div class="bl-eyebrow">Settings · shared across all operators</div>
```
Replace with:
```html
    <div class="bl-eyebrow">Settings · local to this app</div>
```

- [ ] **Step 2: Syntax-check**

```bash
node --check public/js/app.js server.js
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "fix(blocklist): correct header copy — local to this app, not shared"
```

---

### Task 4: Add Blocklist button in the wizard Launch section

**Files:**
- Modify: `public/index.html` lines ~2293–2298 (the `launch-actions--four` div)

**Interfaces:**
- Produces: a `<button>` with class `btn btn-secondary btn-sm` labeled "Blocklist" that calls `openBlocklistPanel()`, placed after the `btn-save-draft` button inside `#launch-actions`. Must work without a preflight having run (openBlocklistPanel is standalone — confirmed in planning).

- [ ] **Step 1: Insert the Blocklist button after `btn-save-draft`**

In `public/index.html`, find:
```html
            <button type="button" id="btn-save-draft" class="btn btn-secondary" onclick="window.launchSaveAsDraft()" title="Save current configuration as a draft and return to the dashboard">Save as draft</button>
          </div>
```
Replace with:
```html
            <button type="button" id="btn-save-draft" class="btn btn-secondary" onclick="window.launchSaveAsDraft()" title="Save current configuration as a draft and return to the dashboard">Save as draft</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="openBlocklistPanel()" title="View and edit the company/domain blocklist">Blocklist</button>
          </div>
```

- [ ] **Step 2: Syntax-check**

```bash
node --check public/js/app.js server.js
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(preflight): add Blocklist button in wizard Launch section"
```

---

### Task 5: Auto-recheck preflight when blocklist panel closes

This is the most complex change. When the blocklist panel closes (Close button OR after any add/remove) AND `_pfState` holds results from a prior preflight run, automatically re-run the preflight and update the overlay.

**Files:**
- Modify: `public/js/app.js` lines ~4977–5005 (the `DOMContentLoaded` block and `openBlocklistPanel`)

**Interfaces:**
- Consumes: `_pfState` (already module-scoped at line 4884), `runPreflight(payload)`, `renderPreflight({ findings })`, `showCampaignToast(msg, ms)`.
- Produces: `_closeBlocklistAndMaybeRecheck()` async function; updated `blClose` onclick handler; updated `blAdd` onclick to call `_closeBlocklistAndMaybeRecheck` instead of just `openBlocklistPanel`; updated `bl-remove` buttons to call `_closeBlocklistAndMaybeRecheck` after the DELETE; a `_setPfActionsDisabled(disabled)` helper; a brief "re-checking…" indicator on the overlay while re-lint runs.

- [ ] **Step 1: Add `_setPfActionsDisabled` helper**

In `public/js/app.js`, immediately after the `closePreflight` function (line ~4924), insert:

```javascript
function _setPfActionsDisabled(disabled) {
  ['pf-fix', 'pf-exclude', 'pf-anyway', 'pf-cancel'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const sub = document.getElementById('pf-sub');
  if (sub) {
    if (disabled) {
      sub.setAttribute('data-prev-text', sub.innerHTML);
      sub.innerHTML = '<span style="color:var(--gray);font-style:italic">re-checking…</span>';
    } else {
      const prev = sub.getAttribute('data-prev-text');
      if (prev != null) { sub.innerHTML = prev; sub.removeAttribute('data-prev-text'); }
    }
  }
}
```

- [ ] **Step 2: Add `_closeBlocklistAndMaybeRecheck` async helper**

Immediately after `_setPfActionsDisabled`, insert:

```javascript
async function _closeBlocklistAndMaybeRecheck() {
  document.getElementById('bl-scrim').style.display = 'none';
  if (!_pfState) return;               // no preflight open — nothing to recheck
  if (document.getElementById('pf-scrim').style.display === 'none') return; // overlay also closed
  _setPfActionsDisabled(true);
  try {
    const fresh = await runPreflight(_pfState.payload);
    _pfState = { findings: fresh.findings, ack: fresh.ack, payload: _pfState.payload, opts: _pfState.opts };
    renderPreflight(fresh);
  } catch (err) {
    showCampaignToast('Blocklist saved — pre-flight re-check failed: ' + (err.message || 'unknown error'), 6000);
  } finally {
    _setPfActionsDisabled(false);
  }
}
```

- [ ] **Step 3: Update `blClose` onclick to call the new helper**

Find in the `DOMContentLoaded` listener:
```javascript
  if (blClose) blClose.onclick = () => { document.getElementById('bl-scrim').style.display = 'none'; };
```
Replace with:
```javascript
  if (blClose) blClose.onclick = _closeBlocklistAndMaybeRecheck;
```

- [ ] **Step 4: Update `blAdd` onclick to call the new helper after adding**

Find:
```javascript
  if (blAdd) blAdd.onclick = async () => {
    const value = document.getElementById('bl-value').value.trim();
    if (!value) return;
    await fetch('/api/blocklist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, reason: document.getElementById('bl-reason').value.trim(), addedBy: (window.operatorEmail || '') }),
    });
    document.getElementById('bl-value').value = '';
    document.getElementById('bl-reason').value = '';
    openBlocklistPanel();
  };
```
Replace with:
```javascript
  if (blAdd) blAdd.onclick = async () => {
    const value = document.getElementById('bl-value').value.trim();
    if (!value) return;
    await fetch('/api/blocklist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, reason: document.getElementById('bl-reason').value.trim(), addedBy: (window.operatorEmail || '') }),
    });
    document.getElementById('bl-value').value = '';
    document.getElementById('bl-reason').value = '';
    // Refresh the list in the panel, then trigger recheck when operator closes
    await openBlocklistPanel();
  };
```
(Note: `openBlocklistPanel` already shows the updated panel. The recheck happens on Close, not immediately after Add — this avoids re-running for every keystroke when the operator adds multiple entries before closing.)

- [ ] **Step 5: Update `.bl-remove` onclick handlers inside `openBlocklistPanel` to call the new helper**

Find in `openBlocklistPanel`:
```javascript
  list.querySelectorAll('.bl-remove').forEach((btn) => btn.onclick = async () => {
    await fetch('/api/blocklist', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: btn.dataset.v }) });
    openBlocklistPanel();
  });
```
Replace with:
```javascript
  list.querySelectorAll('.bl-remove').forEach((btn) => btn.onclick = async () => {
    await fetch('/api/blocklist', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: btn.dataset.v }) });
    _closeBlocklistAndMaybeRecheck();
  });
```

- [ ] **Step 6: Syntax-check**

```bash
node --check public/js/app.js server.js
```
Expected: no output.

- [ ] **Step 7: Run tests**

```bash
node --test tests/preflight-lint.test.js tests/preflight-gate.test.js tests/blocklist.test.js
```
Expected: 27 passing.

- [ ] **Step 8: Commit**

```bash
git add public/js/app.js
git commit -m "feat(preflight): auto-recheck when blocklist panel closes while overlay is open"
```

---

### Task 6: Clarify action-button semantics (FIX 5)

**Files:**
- Modify: `public/index.html` pf-actions block (~3318–3325)
- Modify: `public/js/app.js` conditional label in `renderPreflight` (~4916)

- [ ] **Step 1:** pf-exclude label → "Exclude all flagged &amp; launch"; rewrite `.pf-count-note` fine-print explaining both paths.
- [ ] **Step 2:** `anyway.textContent = hasBl ? 'Keep flagged, launch anyway (blocklisted still excluded)' : 'Launch anyway';` (default HTML label stays "Launch anyway"; IDs unchanged).
- [ ] **Step 3:** syntax-check, tests, commit `fix(preflight): clarify exclude/launch-anyway button semantics`.

---

## Self-Review

### Spec coverage check

| Requirement | Task |
|---|---|
| 1. Stale results — rerun preflight on blocklist close | Task 5 |
| 1a. "re-checking…" inline state, disable 4 buttons | Task 5 (`_setPfActionsDisabled`) |
| 1b. Toast on recheck failure, keep old findings | Task 5 (`catch` branch) |
| 2. Blocklist button in wizard Launch section | Task 4 |
| 2a. Works without prior preflight | Task 4 (calls `openBlocklistPanel` directly) |
| 2b. Fix "SETTINGS · SHARED ACROSS ALL OPERATORS" copy | Task 3 |
| 3. pf-row grid `56px 160px 1fr`, gap 14px | Task 1 step 2 |
| 3a. Row # reads "Row 5" mono | Task 2 step 2 |
| 3b. Lead name 600 weight | Task 1 step 4 (600 weight on `.lead`) |
| 3c. Reason wraps, ≥0.85rem | Task 1 step 4, CSS `.reason` has no nowrap |
| 3d. Base font ≥0.85rem | Task 1 step 2 (font-size: 0.85rem on `.pf-row`) |
| 3e. Group headers ≥0.8rem | Task 1 step 6 |
| 3f. Tally chips ≥0.8rem | Task 1 step 7 |
| 3g. 14–16px padding per row | Task 1 step 2 (padding: 14px 4px) |
| 3h. Sheet-level findings span first two cols | Task 1 step 5 + Task 2 step 2 |
| 3i. bl-list grid ≥0.85rem | Task 1 step 8 |
| 4. Blocklist detail in reason col, untruncated | Task 2 step 2 (`.reason` has no truncation) |

No gaps found.

### Placeholder scan

No TBD, TODO, or placeholder patterns present.

### Type consistency

- `_pfState` object shape `{ findings, ack, payload, opts }` used identically in Task 5 and existing code (line 5437, line 4940).
- `runPreflight(payload)` called with `_pfState.payload` — same as existing `startCampaign` path (line 5431 calls it with the same `body` object shape).
- `renderPreflight({ findings })` called with `fresh` object from `runPreflight` — already matches (line 5439 does the same).
- `showCampaignToast(msg, ms)` — grep confirms it exists: `grep -n "function showCampaignToast" public/js/app.js`.
- `_setPfActionsDisabled` and `_closeBlocklistAndMaybeRecheck` are defined before their first use (inserted before `DOMContentLoaded` block).

All consistent.
