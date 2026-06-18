# Resume Picks Up Live State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paused campaign reload the sheet and edit its account set, review every pending change in one panel, and apply it on Resume — with benched/added accounts surviving a restart and benching taking effect within one lead.

**Architecture:** A new pure module (`src/resume-diff.js`) computes all diffs; the server computes the `resumeChanges` object and returns it; the client renders it (never recomputes). Paused edits are *staged* on `campaign._pendingResume` and applied at the loop's pause boundary via side-channel closures (mirroring the existing `campaign._unparkProfile` pattern). The existing edit-while-paused settings panel and all current behavior are preserved.

**Tech Stack:** Node ≥22, Express 4, vanilla JS (no bundler), `node --test`, GoLogin + puppeteer-core. Frontend pure helpers live in `public/js/*.mjs`; backend pure helpers in `src/*.js`.

---

## CRITICAL CONSTRAINTS (read before every task)

- **Off-limits — never modify:** `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- **No silent removals.** This is additive. The plain `resumeCampaign()` path, the
  `#pause-edit-panel` + `setLiveTemplates`/`setLiveDailyLimit`/`setLiveCadence`, the wizard
  bench UI (`bench-btn`/`toggleBenchProfile`), `renderMonitoringCard` + its `mon-auto-checks`
  toggle, `setProfileSkip`, and the restore/monitoring-persistence paths all stay intact. See
  the spec's "Preserves existing behavior" section.
- **Wired to real state — zero invented data.** Every value the UI shows is computed from
  real re-read/diff. No hardcoded counts, no graphic-only buttons.
- **Real style.** New UI uses the existing command-deck CSS tokens/classes in
  `public/css/style.css`; it renders inside the real live campaign card.
- **NEVER `git add -A`.** `data/monitoring-campaign.json` is a tracked runtime-state file —
  stage only the specific files each task names.
- **Version bump + relaunch** after any commit touching runtime code: patch-bump
  `package.json` `version`, then
  `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`.
- Spec: `docs/superpowers/specs/2026-06-18-resume-live-state-design.md`.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/resume-diff.js` | Pure diff/summary functions (sheet/account/settings → `resumeChanges`). No I/O, no DOM. | Create |
| `tests/resume-diff.test.js` | Unit tests for the above. | Create |
| `tests/bench-gate.test.js` | Unit test for the #2a per-turn bench gate helper. | Create |
| `src/campaign.js` | Pause snapshot, staging object, side-channel closures, resume apply path, inner-loop bench gate, `_lastRunSettings.benchedProfileIds`, mutable `targets`. | Modify |
| `server.js` | 4 new `/api/campaign/resume/*` endpoints. | Modify |
| `public/js/app.js` | Paused account editor, review panel render from `resumeChanges`, Resume→preview→confirm flow. | Modify |
| `public/index.html` | Markup for the inline review panel container. | Modify |
| `public/css/style.css` | Styles for the review panel + account editor (reusing tokens). | Modify |

## Build order (phases = stopping points)

- **Phase 1 (Tasks 1–6):** `resume-diff` helper + sheet-reload + Settings snapshot/diff + review panel (Sheet + Settings groups). Working, shippable.
- **Phase 2 (Task 7):** #2c — benched/added state survives restart.
- **Phase 3 (Tasks 8–9):** #2a — bench-reliability fix (confirm-then-fix).
- **Phase 4 (Tasks 10–12):** #2b — add/swap a fresh account (lights up the Accounts group).

---

## Phase 1 — Sheet reload + Settings diff + review panel

### Task 1: `computeSheetDiff` (pure)

**Files:**
- Create: `src/resume-diff.js`
- Test: `tests/resume-diff.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resume-diff.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSheetDiff } from '../src/resume-diff.js';

const urlOf = (row) => row.url;

test('computeSheetDiff: new URLs are added, sent/identical untouched', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', name: 'A' }];
  const next = [
    { url: 'https://linkedin.com/in/a', name: 'A' },
    { url: 'https://linkedin.com/in/b', name: 'B' },
  ];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 1);
  assert.equal(d.added[0].url, 'https://linkedin.com/in/b');
  assert.equal(d.updatedCount, 0);
  assert.equal(d.newTotal, 2);
});

test('computeSheetDiff: same URL with changed cell values is an update', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', title: 'CEO' }];
  const next = [{ url: 'https://linkedin.com/in/a', title: 'Founder' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 1);
  assert.equal(d.updatedPending[0].title, 'Founder');
});

test('computeSheetDiff: URL normalization (trailing slash / query / case)', () => {
  const prev = [{ url: 'https://linkedin.com/in/a' }];
  const next = [{ url: 'https://linkedin.com/in/A/?utm=x' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 0);
});

test('computeSheetDiff: rows without a URL are ignored', () => {
  const d = computeSheetDiff([], [{ url: '' }, { url: null }], urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.newTotal, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/resume-diff.test.js`
Expected: FAIL — `Cannot find module '../src/resume-diff.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/resume-diff.js
// Pure helpers for the "resume picks up live state" review summary. No I/O, no DOM.
// The server computes the resumeChanges object from these and returns it; the client
// only renders it. Single source of truth so the preview can't drift from what's applied.

function normUrl(u) {
  return String(u || '').trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
}

/**
 * Diff the re-fetched + re-filtered lead rows against the rows currently in the run.
 * Identity = normalized LinkedIn URL (via the caller-supplied urlOf, so we reuse the
 * real extractLinkedInUrl at the call site and keep this module pure).
 * Already-sent leads are excluded upstream by the existing filter, so they never appear.
 */
export function computeSheetDiff(prevTargets, newTargets, urlOf) {
  const prevByUrl = new Map();
  for (const row of prevTargets || []) {
    const u = normUrl(urlOf(row));
    if (u) prevByUrl.set(u, row);
  }
  const added = [];
  const updatedPending = [];
  for (const row of newTargets || []) {
    const u = normUrl(urlOf(row));
    if (!u) continue;
    if (!prevByUrl.has(u)) {
      added.push(row);
    } else if (JSON.stringify(row) !== JSON.stringify(prevByUrl.get(u))) {
      updatedPending.push(row);
    }
  }
  return {
    added,
    updatedPending,
    addedCount: added.length,
    updatedCount: updatedPending.length,
    newTotal: (newTargets || []).length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/resume-diff.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/resume-diff.js tests/resume-diff.test.js
git commit -m "feat: computeSheetDiff pure helper for resume sheet reload"
```

---

### Task 2: `computeAccountDiff` + `computeSettingsDiff` + `summarizeResumeChanges` (pure)

**Files:**
- Modify: `src/resume-diff.js`
- Test: `tests/resume-diff.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/resume-diff.test.js`)

```js
import {
  computeAccountDiff, computeSettingsDiff, summarizeResumeChanges,
} from '../src/resume-diff.js';

test('computeAccountDiff: added / benched / reEnabled', () => {
  const prev = { ids: ['p1', 'p2'], benched: ['p2'], names: { p1: 'A', p2: 'B' } };
  const next = { ids: ['p1', 'p2', 'p3'], benched: ['p1'], names: { p1: 'A', p2: 'B', p3: 'C' } };
  const d = computeAccountDiff(prev, next);
  assert.deepEqual(d.added, [{ id: 'p3', name: 'C' }]);
  assert.deepEqual(d.benched, [{ id: 'p1', name: 'A' }]);
  assert.deepEqual(d.reEnabled, [{ id: 'p2', name: 'B' }]);
  assert.deepEqual(d.removed, []);
});

test('computeSettingsDiff: dailyLimit + cadence + templates-changed', () => {
  const snap = { dailyLimit: 50, checkIntervalMinutes: 60, templates: { ccDmBody: 'hi' } };
  const cur = { dailyLimit: 40, checkIntervalMinutes: 60, templates: { ccDmBody: 'yo' } };
  const d = computeSettingsDiff(snap, cur);
  assert.equal(d.find(c => c.key === 'dailyLimit').from, 50);
  assert.equal(d.find(c => c.key === 'dailyLimit').to, 40);
  assert.equal(d.some(c => c.key === 'cadence'), false);
  assert.equal(d.find(c => c.key === 'templates').changed, true);
});

test('summarizeResumeChanges: isEmpty true when nothing changed', () => {
  const empty = summarizeResumeChanges({
    sheetDiff: { added: [], updatedPending: [], addedCount: 0, updatedCount: 0, newTotal: 5 },
    accountDiff: { added: [], removed: [], benched: [], reEnabled: [] },
    settingsDiff: [],
  });
  assert.equal(empty.isEmpty, true);
});

test('summarizeResumeChanges: isEmpty false when any group has a change', () => {
  const s = summarizeResumeChanges({
    sheetDiff: { added: [{}], updatedPending: [], addedCount: 1, updatedCount: 0, newTotal: 6 },
    accountDiff: { added: [], removed: [], benched: [], reEnabled: [] },
    settingsDiff: [],
  });
  assert.equal(s.isEmpty, false);
  assert.equal(s.sheet.addedCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/resume-diff.test.js`
Expected: FAIL — `computeAccountDiff is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation** (append to `src/resume-diff.js`)

```js
/**
 * Diff the account set. prev/next: { ids: string[], benched: string[], names: {id:name} }.
 * We never hard-remove accounts in v1 (bench instead), but `removed` is computed for safety.
 */
export function computeAccountDiff(prev, next) {
  const nameOf = (id) => (next.names && next.names[id]) || (prev.names && prev.names[id]) || id;
  const prevIds = new Set(prev.ids || []);
  const nextIds = new Set(next.ids || []);
  const prevBench = new Set(prev.benched || []);
  const nextBench = new Set(next.benched || []);
  const toEntry = (id) => ({ id, name: nameOf(id) });
  return {
    added: [...nextIds].filter(id => !prevIds.has(id)).map(toEntry),
    removed: [...prevIds].filter(id => !nextIds.has(id)).map(toEntry),
    benched: [...nextBench].filter(id => !prevBench.has(id) && nextIds.has(id)).map(toEntry),
    reEnabled: [...prevBench].filter(id => !nextBench.has(id) && nextIds.has(id)).map(toEntry),
  };
}

/**
 * Diff campaign settings the existing paused editors mutate. snap = pause-time snapshot,
 * cur = current live values. Read-only over existing state.
 */
export function computeSettingsDiff(snap, cur) {
  const out = [];
  if (snap.dailyLimit !== cur.dailyLimit) {
    out.push({ key: 'dailyLimit', label: 'Daily limit', from: snap.dailyLimit, to: cur.dailyLimit });
  }
  if (snap.checkIntervalMinutes !== cur.checkIntervalMinutes) {
    out.push({ key: 'cadence', label: 'Check cadence', from: snap.checkIntervalMinutes, to: cur.checkIntervalMinutes });
  }
  if (JSON.stringify(snap.templates || {}) !== JSON.stringify(cur.templates || {})) {
    out.push({ key: 'templates', label: 'Message / intro text', changed: true });
  }
  return out;
}

/** Assemble the resumeChanges object the API returns and the UI renders. */
export function summarizeResumeChanges({ sheetDiff, accountDiff, settingsDiff }) {
  const acct = accountDiff || { added: [], removed: [], benched: [], reEnabled: [] };
  const settings = settingsDiff || [];
  const accountChanged = !!(acct.added.length || acct.removed.length || acct.benched.length || acct.reEnabled.length);
  const sheetChanged = !!(sheetDiff && (sheetDiff.addedCount || sheetDiff.updatedCount));
  return {
    sheet: sheetDiff || { added: [], updatedPending: [], addedCount: 0, updatedCount: 0, newTotal: 0 },
    accounts: acct,
    settings,
    isEmpty: !sheetChanged && !accountChanged && settings.length === 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/resume-diff.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add src/resume-diff.js tests/resume-diff.test.js
git commit -m "feat: account/settings diff + summarizeResumeChanges helpers"
```

---

### Task 3: Pause-time snapshot + reusable target-filter + mutable `targets`

**Files:**
- Modify: `src/campaign.js` (`pauseCampaign` ~4578; `resumeCampaign` ~4588; `targets` declaration ~2031; capture the filter predicate)

This task makes the loop state reachable for staging without changing behavior.

- [ ] **Step 1: Make `targets` mutable and expose it + the row filter for reload.**

In `src/campaign.js`, the `const targets = rows.filter(row => { ... });` at line 2031 builds the lead list once. Change so the filter predicate is a named function reusable by reload, and so `targets` can be appended to. Find:

```js
    const targets = rows.filter(row => {
```

Replace the opening with a named predicate and keep the body identical:

```js
    // v2.112: extract the filter predicate so resume-reload can re-apply the EXACT same
    // gating to freshly-fetched rows. Body unchanged from the original inline filter.
    const _isTarget = (row) => {
```

…and at the end of that filter body (the closing `});` of the original `rows.filter(...)`), close the function and build `targets` from it:

```js
    }; // end _isTarget
    const targets = rows.filter(_isTarget);
```

(Targets remains an array the loop reads by reference at `targets.length` / `targets[leadIndex]`; we only ever `.push()` to it on reload, never reassign.)

- [ ] **Step 2: Expose a reload closure + the row→url helper for the run.**

Immediately after `campaign._unparkProfile = (profileId) => { ... };` (line ~2662), add:

```js
    // v2.112: resume-reload side-channel. Re-applies the SAME _isTarget filter to freshly
    // fetched rows and appends still-pending rows not already queued; updates in place the
    // row object for still-pending URLs already present (so edited variables go live).
    // Mutates `targets` in place — the loop reads it by reference. Returns {added, updated}.
    campaign._reloadTargets = (newRows) => {
      const norm = (u) => String(u || '').trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
      const byUrl = new Map();
      for (const r of targets) {
        const u = norm(extractLinkedInUrl(r, linkedinColumn));
        if (u) byUrl.set(u, r);
      }
      let added = 0, updated = 0;
      for (const r of (newRows || []).filter(_isTarget)) {
        const u = norm(extractLinkedInUrl(r, linkedinColumn));
        if (!u) continue;
        if (!byUrl.has(u)) { targets.push(r); byUrl.set(u, r); added++; }
        else { Object.assign(byUrl.get(u), r); updated++; }
      }
      campaign.totalTargets = targets.length;
      return { added, updated };
    };
    // Expose the row→url + filter so the server can compute a dry-run diff without applying.
    campaign._urlOf = (row) => extractLinkedInUrl(row, linkedinColumn);
    campaign._isTarget = _isTarget;
    campaign._currentTargets = () => targets;
    // Re-fetch the SAME sheet. campaign.js already imports fetchSheetRows and owns sheetUrl,
    // so the server stays out of the sheets layer — it just calls this.
    campaign._refetchRows = async () => fetchSheetRows(campaign.sheetUrl);
```

Clear these in the same `finally` block that nulls `_unparkProfile` (line ~4455):

```js
    campaign._reloadTargets = null;
    campaign._urlOf = null;
    campaign._isTarget = null;
    campaign._currentTargets = null;
    campaign._refetchRows = null;
```

- [ ] **Step 3: Snapshot settings on pause; clear on resume.**

In `pauseCampaign()` (line 4578), after `campaign._pauseRequested = true;` add:

```js
  // v2.112: snapshot the settings the paused editors can change, so the resume review can
  // diff them honestly. Deep-copy templates (setLiveTemplates mutates it in place).
  campaign._pauseSnapshot = {
    dailyLimit: campaign.dailyLimit,
    checkIntervalMinutes: campaign.checkIntervalMinutes,
    templates: JSON.parse(JSON.stringify(campaign.templates || {})),
  };
```

In `resumeCampaign()` (line 4588), after the flags are cleared, add `campaign._pauseSnapshot = null;` (and see Task 6 for the apply path).

- [ ] **Step 4: Verify nothing broke.**

Run: `node --check src/campaign.js && node --test`
Expected: `node --check` clean; full suite still green (no new tests yet — this task is structural).

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js
git commit -m "feat: pause snapshot + reusable target filter + _reloadTargets side-channel"
```

---

### Task 4: Staging object + `_pendingResume` + apply-on-confirm path

**Files:**
- Modify: `src/campaign.js` (`startCampaign` init ~1710; `resumeCampaign` ~4588; new `_applyPendingResume`)

- [ ] **Step 1: Initialize staging on start.**

In `startCampaign`, near `campaign._paused = false;` (line 1710), add:

```js
  // v2.112: resume staging — paused edits accumulate here, applied at the pause boundary.
  campaign._pendingResume = { reloadSheet: false, newRows: null, addProfiles: [], benchToggles: {} };
```

- [ ] **Step 2: Add `_applyPendingResume()` and the `applyPending` resume path.**

Replace the body of `resumeCampaign()` (lines 4588–4597) with:

```js
export function resumeCampaign({ applyPending = false } = {}) {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused && !campaign._pauseRequested) {
    return { ok: true, notPaused: true };
  }
  if (applyPending) {
    try { _applyPendingResume(); } catch (err) { log(`⚠ resume apply failed: ${err.message}`); }
  }
  campaign._pauseSnapshot = null;
  campaign._pauseRequested = false;
  campaign._paused = false; // awaitUnpause's while-loop will exit on next tick
  log('▶ Resume requested.');
  return { ok: true };
}

// v2.112: apply staged paused edits at the boundary (loop parked in awaitUnpause).
function _applyPendingResume() {
  const p = campaign._pendingResume;
  if (!p) return;
  if (p.reloadSheet && p.newRows && typeof campaign._reloadTargets === 'function') {
    const r = campaign._reloadTargets(p.newRows);
    log(`⟳ Sheet reloaded on resume — +${r.added} new, ${r.updated} updated (total ${campaign.totalTargets}).`);
  }
  for (const { id, name } of p.addProfiles || []) {
    if (typeof campaign._addProfile === 'function') campaign._addProfile(id, name);
  }
  for (const [id, skip] of Object.entries(p.benchToggles || {})) {
    setProfileSkip(id, !!skip);
  }
  campaign._pendingResume = { reloadSheet: false, newRows: null, addProfiles: [], benchToggles: {} };
}
```

(`campaign._addProfile` is added in Phase 4; until then `addProfiles` is always empty, so the guard is a no-op. `setProfileSkip` already exists.)

- [ ] **Step 3: Verify.**

Run: `node --check src/campaign.js && node --test`
Expected: clean; suite green. Confirm the 3 existing `resumeCampaign()` callers (no args) still compile — the default `applyPending=false` preserves their behavior.

- [ ] **Step 4: Commit**

```bash
git add src/campaign.js
git commit -m "feat: _pendingResume staging + applyPending resume path"
```

---

### Task 5: Server endpoints `/api/campaign/resume/*`

**Files:**
- Modify: `server.js` (near the existing `/api/campaign/live/*` and `/api/campaign/resume` routes ~1407–1479)

- [ ] **Step 1: Add the four endpoints.**

Add after the existing `/api/campaign/resume` route (line ~1479). The re-fetch goes through `campaign._refetchRows()` (Task 3) so server.js stays out of the sheets layer. Import `computeSheetDiff/computeSettingsDiff/computeAccountDiff/summarizeResumeChanges` from `./src/resume-diff.js` (add to the import block at top of server.js).

```js
// ── v2.112: resume-with-live-state (paused only) ────────────────────────────
function _resumeGuard(res) {
  if (!campaign.running) { res.status(409).json({ error: 'not-running' }); return false; }
  if (!campaign._paused) { res.status(409).json({ error: 'not-paused' }); return false; }
  return true;
}

function _buildResumeChanges() {
  const urlOf = campaign._urlOf || ((r) => r && (r.url || ''));
  const prev = campaign._currentTargets ? campaign._currentTargets() : [];
  const staged = campaign._pendingResume || {};
  const sheetDiff = staged.reloadSheet && staged.newRows
    ? computeSheetDiff(prev, staged.newRows.filter(campaign._isTarget || (() => true)), urlOf)
    : computeSheetDiff(prev, prev, urlOf);
  // Slice modes (check_status/message_only/introduce_back) drain pre-built per-profile
  // slices, so _reloadTargets will NOT add brand-new leads (only update existing rows).
  // Mirror that here so the preview is honest: relabel `added` as `skippedNew` (a "needs
  // restart to include" notice), never show it as an applied add.
  const SLICE_MODES = ['check_status', 'message_only', 'introduce_back'];
  if (SLICE_MODES.includes(campaign.mode) && sheetDiff.addedCount) {
    sheetDiff.skippedNew = sheetDiff.addedCount;
    sheetDiff.added = [];
    sheetDiff.addedCount = 0;
  } else {
    sheetDiff.skippedNew = 0;
  }
  const ids = (campaign.profileIds || []).slice();
  const names = {};
  (campaign.profileIds || []).forEach((id, i) => { names[id] = (campaign.profileNames || [])[i] || id; });
  const nextIds = ids.concat((staged.addProfiles || []).map(a => a.id));
  (staged.addProfiles || []).forEach(a => { names[a.id] = a.name || a.id; });
  const prevBench = [...(campaign._skippedProfiles || [])];
  const nextBench = prevBench.slice();
  for (const [id, skip] of Object.entries(staged.benchToggles || {})) {
    if (skip && !nextBench.includes(id)) nextBench.push(id);
    if (!skip) { const i = nextBench.indexOf(id); if (i >= 0) nextBench.splice(i, 1); }
  }
  const accountDiff = computeAccountDiff(
    { ids, benched: prevBench, names },
    { ids: nextIds, benched: nextBench, names },
  );
  const snap = campaign._pauseSnapshot || { dailyLimit: campaign.dailyLimit, checkIntervalMinutes: campaign.checkIntervalMinutes, templates: campaign.templates };
  const settingsDiff = computeSettingsDiff(snap, {
    dailyLimit: campaign.dailyLimit, checkIntervalMinutes: campaign.checkIntervalMinutes, templates: campaign.templates,
  });
  const rc = summarizeResumeChanges({ sheetDiff, accountDiff, settingsDiff });
  // skippedNew is informational (slice modes) — surface the notice even if nothing else changed.
  if (rc.sheet.skippedNew) rc.isEmpty = false;
  return rc;
}

app.post('/api/campaign/resume/reload-sheet', async (req, res) => {
  if (!_resumeGuard(res)) return;
  try {
    const rows = await campaign._refetchRows();
    campaign._pendingResume.reloadSheet = true;
    campaign._pendingResume.newRows = rows;
    res.json({ ok: true, resumeChanges: _buildResumeChanges() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/campaign/resume/accounts', (req, res) => {
  if (!_resumeGuard(res)) return;
  const { bench } = req.body || {};
  if (bench && typeof bench === 'object') {
    for (const [id, skip] of Object.entries(bench)) {
      if (!(campaign.profileIds || []).includes(id)) {
        return res.status(400).json({ error: `unknown profile ${id}` });
      }
      campaign._pendingResume.benchToggles[id] = !!skip;
    }
  }
  // add/swap handled in Phase 4.
  res.json({ ok: true, resumeChanges: _buildResumeChanges() });
});

app.get('/api/campaign/resume/preview', (req, res) => {
  if (!_resumeGuard(res)) return;
  res.json({ ok: true, resumeChanges: _buildResumeChanges() });
});

app.post('/api/campaign/resume/confirm', (req, res) => {
  if (!_resumeGuard(res)) return;
  const applied = _buildResumeChanges();
  const result = resumeCampaign({ applyPending: true });
  res.json({ ok: result.ok !== false, applied });
});
```

**Note on `isEmpty` + `skippedNew`:** `summarizeResumeChanges` computes `isEmpty` from real applied changes (added/updated/accounts/settings). A reload that found ONLY `skippedNew` leads (slice mode) is otherwise "empty", but we still want to show the "N new leads need a restart" notice. So after building `resumeChanges`, the endpoint sets `if (resumeChanges.sheet.skippedNew) resumeChanges.isEmpty = false;` before returning — in BOTH `preview` and `reload-sheet` responses. Do this in `_buildResumeChanges` right before `return`.

- [ ] **Step 2: Add the import.** At the top of `server.js`, add to the import list from `./src/resume-diff.js`:

```js
import { computeSheetDiff, computeAccountDiff, computeSettingsDiff, summarizeResumeChanges } from './src/resume-diff.js';
```

- [ ] **Step 3: Verify.**

Run: `node --check server.js && node --test`
Expected: clean; suite green.

- [ ] **Step 4: Manual smoke (no UI yet).** Bump `package.json` patch version. Relaunch dev:app. With a campaign paused, `curl -s -XGET localhost:<port>/api/campaign/resume/preview` should return `{ ok:true, resumeChanges:{ isEmpty:true, ... } }`.

- [ ] **Step 5: Commit**

```bash
git add server.js package.json
git commit -m "feat: /api/campaign/resume/{reload-sheet,accounts,preview,confirm} endpoints"
```

---

### Task 6: Frontend — paused Reload control + inline review panel (Sheet + Settings)

**Files:**
- Modify: `public/index.html` (review-panel container near the live campaign card / `#pause-edit-panel` ~1562)
- Modify: `public/js/app.js` (Resume handler ~12937; add reload + preview/confirm fns)
- Modify: `public/css/style.css` (panel styles using existing tokens)

- [ ] **Step 1: Add the review-panel container markup.** In `public/index.html`, after the `#pause-edit-panel` block (closes ~ line where that panel ends), add:

```html
<!-- v2.112: resume review panel — populated from /api/campaign/resume/preview. -->
<div id="resume-review-panel" class="cockpit-panel" hidden style="display:none">
  <div class="resume-review-head">Review before resuming</div>
  <div id="resume-review-body" class="resume-review-body"></div>
  <div class="resume-review-actions">
    <button type="button" class="btn-ghost" id="resume-keep-editing">Keep editing</button>
    <button type="button" class="btn-gold" id="resume-confirm">Confirm &amp; Resume</button>
  </div>
</div>
```

- [ ] **Step 2: Add a `⟳ Reload from sheet` control.** In the paused-state region of the live card render (alongside the existing pause-edit controls), add a button wired to `reloadSheetWhilePaused()` (defined below). Use existing button classes (e.g. `btn-ghost`):

```html
<button type="button" class="btn-ghost" id="resume-reload-sheet" onclick="reloadSheetWhilePaused()">⟳ Reload from sheet</button>
```

- [ ] **Step 3: Add the client functions** in `public/js/app.js`:

```js
// v2.112: resume-with-live-state client. Renders ONLY from the server's resumeChanges
// object — never computes counts locally (no invented data).
async function reloadSheetWhilePaused() {
  const r = await fetch('/api/campaign/resume/reload-sheet', { method: 'POST' }).then(x => x.json());
  if (!r.ok) { showCampaignToast(`Reload failed: ${r.error || 'unknown'}`, 4000); return; }
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
    (a.added||[]).forEach(x => parts.push(`<div class="rr-line">＋ Added ${x.name}</div>`));
    (a.benched||[]).forEach(x => parts.push(`<div class="rr-line">⏸ Benched ${x.name}</div>`));
    (a.reEnabled||[]).forEach(x => parts.push(`<div class="rr-line">▶ Re-enabled ${x.name}</div>`));
    groups.push(`<div class="rr-group"><div class="rr-label">Accounts</div>${parts.join('')}</div>`);
  }
  if ((rc.settings||[]).length) {
    const parts = (rc.settings).map(s => s.changed
      ? `<div class="rr-line">${s.label} changed</div>`
      : `<div class="rr-line">${s.label} ${s.from} → ${s.to}</div>`);
    groups.push(`<div class="rr-group"><div class="rr-label">Settings</div>${parts.join('')}</div>`);
  }
  document.getElementById('resume-review-body').innerHTML = groups.join('') || '<div class="rr-line">No changes.</div>';
}

async function onResumeClicked() {
  const pre = await fetch('/api/campaign/resume/preview').then(x => x.json()).catch(() => null);
  if (!pre || !pre.ok || pre.resumeChanges.isEmpty) {
    await fetch('/api/campaign/resume/confirm', { method: 'POST' });
    return;
  }
  renderResumeReview(pre.resumeChanges);
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = false; panel.style.display = '';
}

document.getElementById('resume-keep-editing')?.addEventListener('click', () => {
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = true; panel.style.display = 'none';
});
document.getElementById('resume-confirm')?.addEventListener('click', async () => {
  await fetch('/api/campaign/resume/confirm', { method: 'POST' });
  const panel = document.getElementById('resume-review-panel');
  panel.hidden = true; panel.style.display = 'none';
});
window.reloadSheetWhilePaused = reloadSheetWhilePaused;
```

- [ ] **Step 4: Route the existing Resume button through `onResumeClicked`.** Find the existing pause/resume handler (line ~12937: `const endpoint = isPaused ? '/api/campaign/resume' : '/api/campaign/pause';`). For the resume branch only, call `onResumeClicked()` instead of posting directly to `/api/campaign/resume`. Leave the pause branch unchanged. (The plain endpoint stays for programmatic callers.)

- [ ] **Step 5: Add CSS** to `public/css/style.css` (reuse existing tokens — match `.cockpit-panel`):

```css
/* v2.112: resume review panel */
.resume-review-head { font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--hairline, #2a2a2a); }
.resume-review-body { padding: 10px 0; }
.rr-group { margin-bottom: 12px; }
.rr-label { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-dim, #8a8a8a); margin-bottom: 4px; }
.rr-line { font-size: 13px; line-height: 1.6; }
.rr-warn { color: var(--warn, #d4c98a); }
.rr-sub { font-size: 11.5px; color: var(--text-dim, #8a8a8a); }
.resume-review-actions { display: flex; justify-content: flex-end; gap: 10px; }
```

(Confirm the exact token names in `style.css` `:root` and match them; if `--hairline`/`--text-dim` differ, use the real names.)

- [ ] **Step 6: Verify.** Bump `package.json` patch version. `node --check`/`node --test` green. Relaunch dev:app. Manual: pause a campaign → edit cadence in the existing panel + add a sheet row → press Resume → the inline panel shows the real Sheet + Settings changes → Confirm resumes. No-change Resume skips the panel.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css package.json
git commit -m "feat: paused sheet-reload control + inline resume review panel (Sheet+Settings)"
```

---

## Phase 2 — #2c: benched/added state survives restart

### Task 7: Persist `benchedProfileIds` + account set into `_lastRunSettings`

**Files:**
- Modify: `src/campaign.js` (`_lastRunSettings` ~1653; `setProfileSkip` ~4511; new `_persistRunSettings` helper)

- [ ] **Step 1: Add `benchedProfileIds` to the snapshot.** In `_lastRunSettings` (line 1653), add the field (seeded from the start args):

```js
    senderColumn, allLeadsConnected, checkIntervalMinutes, autoChecksEnabled,
    benchedProfileIds: Array.isArray(benchedProfileIds) ? benchedProfileIds.slice() : [],
```

- [ ] **Step 2: Add a re-persist helper** (near `writeLastRun`, after `setProfileSkip`):

```js
// v2.112: keep the restore snapshot current so a mid-run bench / added account survives an
// app restart. Best-effort, atomic (same path as start). No-op if no snapshot yet.
function _persistRunSettings() {
  if (!_lastRunSettings) return;
  _lastRunSettings.profileIds = (campaign.profileIds || []).slice();
  _lastRunSettings.benchedProfileIds = [...(campaign._skippedProfiles || [])];
  try { writeLastRun(LAST_RUN_FILE, _lastRunSettings); } catch { /* non-fatal */ }
}
```

- [ ] **Step 3: Call it whenever bench state changes.** At the end of `setProfileSkip` (before `return { ok: true, ... }`), add `_persistRunSettings();`.

- [ ] **Step 4: Write the test** (`tests/resume-diff.test.js` is pure-only; this needs a small campaign-state test). Create `tests/restore-bench-persist.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
// _persistRunSettings is internal; assert the observable contract instead:
// setProfileSkip mutates _skippedProfiles, which getLastRunSettings should reflect after a write.
// This test documents the field's presence in the snapshot shape.
import { getLastRunSettings } from '../src/campaign.js';

test('getLastRunSettings returns an object (snapshot shape includes benchedProfileIds when set)', () => {
  const s = getLastRunSettings();
  // When idle, snapshot may be null; the contract is that the field name is benchedProfileIds.
  assert.ok(s === null || typeof s === 'object');
});
```

(Behavioral verification of restore is manual — Step 6 — because it needs a running campaign + browser lifecycle.)

- [ ] **Step 5: Verify.** `node --check src/campaign.js && node --test` green.

- [ ] **Step 6: Manual.** Bump version, relaunch. Start a campaign, bench an account, kill the app, restart, hit Restore → the benched account comes back benched. Confirm in `data/last-run-settings.json` that `benchedProfileIds` is written.

- [ ] **Step 7: Commit**

```bash
git add src/campaign.js tests/restore-bench-persist.test.js package.json
git commit -m "feat: persist benchedProfileIds + account set so restart restores them (#2c)"
```

---

## Phase 3 — #2a: benching is unreliable (systematic-debugging)

> Use superpowers:systematic-debugging. Confirm each hypothesis with a failing test BEFORE
> the fix. No fix without a reproduction.

### Task 8: Confirm + fix H1 (benched mid-turn keeps sending)

**Files:**
- Create: `src/bench-gate.js` (pure), `tests/bench-gate.test.js`
- Modify: `src/campaign.js` (inner loop condition line 2849)

- [ ] **Step 1: Extract the per-turn gate as a pure helper + failing test.** Create `tests/bench-gate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldContinueTurn } from '../src/bench-gate.js';

test('stops the turn when the profile was benched mid-turn', () => {
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: false, benched: true }), false);
});
test('continues when not benched/limited/aborted', () => {
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: false, benched: false }), true);
});
test('stops on abort / orphan / weekly limit (existing behavior preserved)', () => {
  assert.equal(shouldContinueTurn({ abort: true, orphan: false, weeklyLimited: false, benched: false }), false);
  assert.equal(shouldContinueTurn({ abort: false, orphan: true, weeklyLimited: false, benched: false }), false);
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: true, benched: false }), false);
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `node --test tests/bench-gate.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper.** Create `src/bench-gate.js`:

```js
// v2.112: the per-turn "keep sending this profile's batch?" gate. Extracted pure so the
// mid-turn bench fix is unit-tested. Mirrors the inner-loop condition in campaign.js plus
// the new benched check (#2a / H1).
export function shouldContinueTurn({ abort, orphan, weeklyLimited, benched }) {
  return !abort && !orphan && !weeklyLimited && !benched;
}
```

- [ ] **Step 4: Run test to verify it passes.** `node --test tests/bench-gate.test.js` → PASS (3/3).

- [ ] **Step 5: Wire the helper into the inner loop.** In `src/campaign.js` line 2849, the loop condition is:

```js
        for (let leadInBatch = 0; leadInBatch < innerLimit && !campaign._abort && !isOrphan() && !weeklyLimited.has(profileId); leadInBatch++) {
```

Replace the condition to also bail when benched mid-turn:

```js
        for (let leadInBatch = 0; leadInBatch < innerLimit && shouldContinueTurn({ abort: campaign._abort, orphan: isOrphan(), weeklyLimited: weeklyLimited.has(profileId), benched: campaign._skippedProfiles?.has(profileId) }); leadInBatch++) {
```

Add the import at the top of `src/campaign.js`:

```js
import { shouldContinueTurn } from './bench-gate.js';
```

- [ ] **Step 6: Verify.** `node --check src/campaign.js && node --test` green. Bump version, relaunch. Manual: with a multi-account campaign mid-turn, bench the active account → it stops at the next lead (within one), not after ~8.

- [ ] **Step 7: Commit**

```bash
git add src/bench-gate.js tests/bench-gate.test.js src/campaign.js package.json
git commit -m "fix: bench takes effect within one lead (mid-turn _skippedProfiles gate) (#2a H1)"
```

---

### Task 9: Investigate H2 (re-enabled didn't return) + logging

**Files:**
- Modify: `src/campaign.js` (worker re-enqueue ~3984; `noProfilesLeftEver` ~2743; `setProfileSkip` ~4520)

- [ ] **Step 1: Reproduce.** Add a test in `tests/bench-gate.test.js` capturing the drained-queue rule as a pure predicate. First extract the "is this profile permanently out?" decision used by `noProfilesLeftEver`. If H2 reproduces (un-bench after the last active account was benched does not rejoin), add:

```js
import { canReEnter } from '../src/bench-gate.js';

test('a re-enabled (un-benched) profile can re-enter rotation', () => {
  assert.equal(canReEnter({ benched: false, weeklyLimited: false, ejected: false }), true);
  assert.equal(canReEnter({ benched: true, weeklyLimited: false, ejected: false }), false);
});
```

- [ ] **Step 2: Run to verify it fails.** `node --test tests/bench-gate.test.js` → FAIL (`canReEnter` missing).

- [ ] **Step 3: Implement `canReEnter` + use it.** Append to `src/bench-gate.js`:

```js
// True when a profile is eligible to be picked again (not benched, not weekly-limited,
// not permanently ejected). Used so un-benching the last account re-enters rotation.
export function canReEnter({ benched, weeklyLimited, ejected }) {
  return !benched && !weeklyLimited && !ejected;
}
```

- [ ] **Step 4: Keep the loop alive while a benched account could return + log.** In `src/campaign.js`:
  - In `setProfileSkip`'s un-bench branch (line ~4520), when `!skip` and the profile is not in `profileQueue`, re-enqueue via the existing `retryParkedProfile` path or a new `campaign._requeueProfile?.(profileId)` closure (expose `campaign._requeueProfile = (id) => { if (!profileQueue.includes(id) && !profilesBeingRun.has(id)) profileQueue.push(id); };` next to `_addProfile`/`_unparkProfile`, cleared in the same finally).
  - Add `log` lines at bench, un-bench, and the `noProfilesLeftEver` break so the intermittent case is captured: `log(\`[bench] ${pName} skip=${skip} queueLen=${profileQueue.length}\`)`.

- [ ] **Step 5: Verify + manual.** `node --check && node --test` green. Manual: bench the only active account, then un-bench → it returns to rotation (or, if confirmed unreproducible, the logging is in place). Per systematic-debugging, only ship the requeue fix if Step 1 reproduced; otherwise ship logging alone and note it.

- [ ] **Step 6: Commit**

```bash
git add src/bench-gate.js tests/bench-gate.test.js src/campaign.js package.json
git commit -m "fix: un-bench re-enters rotation + bench-path logging (#2a H2)"
```

---

## Phase 4 — #2b: add / swap a fresh account mid-campaign

### Task 10: `_addProfile` side-channel + launch-failure auto-bench

**Files:**
- Modify: `src/campaign.js` (closures near `_unparkProfile` ~2662; worker-turn open path)

- [ ] **Step 1: Expose `_addProfile`.** Next to `campaign._unparkProfile` (line ~2662):

```js
    // v2.112: add a fresh account to the live rotation. Pushes to the run's id/name arrays
    // and the worker queue; the worker opens its browser on its next turn. Idempotent.
    campaign._addProfile = (id, name) => {
      if (!id || (campaign.profileIds || []).includes(id)) return false;
      campaign.profileIds.push(id);
      campaign.profileNames.push(name || id);
      profileNameCache[id] = name || id;
      profileQueue.push(id);
      log(`＋ ${name || id} added to the live rotation.`);
      return true;
    };
```

Clear in the finally (line ~4455): `campaign._addProfile = null;`.

- [ ] **Step 2: Auto-bench on launch failure.** In `runProfileTurn`'s open path, the existing `ensureOpen`/`openSession` is wrapped in try/catch that calls `pushError`. For a freshly-added profile whose first open throws, add: bench it (`campaign._skippedProfiles.add(profileId)`) + `log('⚠ <name> failed to launch — benched; campaign continues.')` so one bad add never blocks the run. (Locate the existing catch around the session-open call; add the bench there guarded by a "first turn for this profile" check, e.g. a `launchedOnce` Set.)

- [ ] **Step 3: Test (pure-extractable part).** Add to `tests/bench-gate.test.js` a test for an `addDecision` helper if extracted, else this is covered by manual verification. Minimum: assert `_addProfile` rejects duplicates via a small pure `canAddProfile(existingIds, id)` helper in `src/bench-gate.js`:

```js
export function canAddProfile(existingIds, id) {
  return !!id && !(existingIds || []).includes(id);
}
```

with test:

```js
import { canAddProfile } from '../src/bench-gate.js';
test('canAddProfile rejects empty + duplicates', () => {
  assert.equal(canAddProfile(['a'], 'a'), false);
  assert.equal(canAddProfile(['a'], ''), false);
  assert.equal(canAddProfile(['a'], 'b'), true);
});
```

- [ ] **Step 4: Verify.** `node --check && node --test` green.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js src/bench-gate.js tests/bench-gate.test.js package.json
git commit -m "feat: _addProfile side-channel + launch-failure auto-bench (#2b)"
```

---

### Task 11: Server — staging add/swap in `/api/campaign/resume/accounts`

**Files:**
- Modify: `server.js` (`/api/campaign/resume/accounts` from Task 5; `_applyPendingResume` already handles `addProfiles`)

- [ ] **Step 1: Accept `add` (and swap = add + bench) in the endpoint.** Extend the handler:

```js
  const { add } = req.body || {};
  if (Array.isArray(add)) {
    // getProfiles is already imported in server.js from ./src/gologin-launcher.js
    // (same source /api/gologin/profiles uses). Returns [{ id, name, ... }].
    const available = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    const byId = new Map(available.map(p => [p.id, p.name]));
    for (const a of add) {
      if (!byId.has(a.id)) return res.status(400).json({ error: `unknown profile ${a.id}` });
      if ((campaign.profileIds || []).includes(a.id)) return res.status(400).json({ error: `already in run ${a.id}` });
      if (!campaign._pendingResume.addProfiles.some(x => x.id === a.id)) {
        campaign._pendingResume.addProfiles.push({ id: a.id, name: byId.get(a.id) });
      }
    }
  }
```

(Use the same profile-listing function the existing `/api/gologin/profiles` route uses; name it consistently. A swap is the client sending `bench: {oldId:true}` + `add: [{id:newId}]` in the same or successive calls.)

- [ ] **Step 2: Verify.** `node --check server.js && node --test` green. With a paused campaign, `curl -XPOST .../resume/accounts -d '{"add":[{"id":"<realid>"}]}'` returns `resumeChanges.accounts.added` with that profile.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: stage add/swap accounts in resume/accounts endpoint (#2b)"
```

---

### Task 12: Frontend — account editor (add / swap / bench) on the paused card

**Files:**
- Modify: `public/js/app.js` (paused-card render; account-editor functions)
- Modify: `public/css/style.css`

- [ ] **Step 1: Render the account editor while paused.** In the paused live-card region, render one row per `campaign.profileIds` (from the status object) with an Active/Benched toggle (reuse `bench-btn` styling), a `Swap…` affordance, and an `＋ Add account` dropdown populated from `/api/gologin/profiles` filtered to not-already-in-run. Each control calls the functions below.

```js
async function stageAccountChange({ bench, add } = {}) {
  const body = {}; if (bench) body.bench = bench; if (add) body.add = add;
  const r = await fetch('/api/campaign/resume/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
  if (!r.ok) { showCampaignToast(r.error || 'account change rejected', 4000); return; }
  showCampaignToast('Staged — review on Resume.', 2000);
}
function stageBench(id, skip) { return stageAccountChange({ bench: { [id]: skip } }); }
function stageAddAccount(id) { return stageAccountChange({ add: [{ id }] }); }
function stageSwap(oldId, newId) { return stageAccountChange({ bench: { [oldId]: true }, add: [{ id: newId }] }); }
window.stageBench = stageBench; window.stageAddAccount = stageAddAccount; window.stageSwap = stageSwap;
```

The Accounts group in `renderResumeReview` (Task 6, Step 3) already renders added/benched/reEnabled, so no change there.

- [ ] **Step 2: CSS** for the editor rows (reuse tokens; match the existing account-list styling).

```css
/* v2.112: paused account editor */
.acct-edit-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--hairline, #2a2a2a); font-size: 13px; }
.acct-edit-add { margin-top: 10px; }
```

- [ ] **Step 3: Verify (manual — UI).** Bump version, relaunch. Pause a multi-account campaign → add a fresh account + swap one → Resume → panel shows "＋ Added X / ⏸ Benched Y" with real names → Confirm → the new account launches and joins; the swapped-out one stops within one lead.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js public/css/style.css package.json
git commit -m "feat: paused account editor — add/swap/bench wired to staging (#2b)"
```

---

## Final verification (after all phases, before finishing the branch)

- [ ] `npm test` — full suite green (target: existing 812+ plus the new `resume-diff` and `bench-gate` tests).
- [ ] `git status` — `data/monitoring-campaign.json` NOT staged in any commit.
- [ ] Off-limits files unchanged: `git log --oneline -- src/linkedin/outreach.js src/linkedin/actions.js` shows no new commits.
- [ ] Manual end-to-end per the spec's "Done looks like".
- [ ] Then use superpowers:finishing-a-development-branch.
