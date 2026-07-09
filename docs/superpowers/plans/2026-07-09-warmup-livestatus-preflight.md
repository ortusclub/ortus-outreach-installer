# v2.140 fixes + warm-up rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three v2.140 defects (warm-up can't be reverted, Live Status empty on local runs, pre-flight buttons overlap) and rework the warm-up entry point into an always-reversible in-tile toggle with an optional SoO-driven suggestion.

**Architecture:** Frontend-only vanilla JS/CSS changes in `public/`, plus one pure helper in `public/js/account-guardrails.mjs` (node-testable). No backend/route/schedule-math changes — `src/warmup.js`, `src/warmup-store.js`, and `/api/warmup` are already correct. UI verified manually via `npm run dev:app` (repo has no UI test suite); the one pure helper gets a `node --test` unit test.

**Tech Stack:** Vanilla JS (ES modules, no bundler), Express 4, `node --test`, Electron dev shell.

**Spec:** `docs/superpowers/specs/2026-07-09-warmup-livestatus-preflight-design.md`

## Global Constraints

- Node ≥22; no bundler for frontend; vanilla JS only.
- Bugatti design system: monochrome + hairlines, gold (`--gold`) is the only accent; radii `0` or `9999`. Reuse existing tokens — introduce no new colors.
- **Off-limits files** — never touch `src/linkedin/outreach.js` / `src/linkedin/actions.js`.
- Patch-bump `package.json` version before relaunching so the operator can confirm the build (`2.141.0` → `2.142.0`).
- After a commit touching runtime code, relaunch dev:app: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`
- SoO column name for the "new account" flag is not final (working name "Immature"); read a candidate set, and show NO suggestion when unmatched (safe default).
- Preserve the warm-up link's `preventDefault`/`stopPropagation` so clicking it never toggles the tile's selection checkbox.

---

### Task 1: Live Status shows on a local/native run

**Files:**
- Modify: `public/js/app.js` — `placeLiveCard()` (~8709-8747)

**Interfaces:**
- Consumes: existing `syncLiveStatusVisibility()` which sets `#nav-status` `display` from `location.hash === '#/new'` and cockpit running/monitoring/finished state.
- Produces: no new exports. `placeLiveCard()` relocates `#active-card` into `#wiz-live-slot` whenever the Live Status section is visible.

**Root cause:** `syncLiveStatusVisibility()` reveals the section on `location.hash === '#/new'`, but `placeLiveCard()` gates the card relocation on `document.body.classList.contains('route-wizard')`. On a local run those disagree → header shows, card never moves in → empty box.

- [ ] **Step 1: Change the relocation gate to follow the section's own visibility**

In `placeLiveCard()`, the current lines read:

```js
  const onWizard = document.body.classList.contains('route-wizard');
  const liveVisible = !!sec && sec.style.display !== 'none';
  // v2.86.1 (port): follow the section's visibility even when the card is empty.
  // When "Open log" forces the section open while idle, the dashboard card's
  // "No campaign running" empty state is exactly what should show — instead of
  // falling back to the legacy cockpit panel. (Was: && !is-empty.)
  const wantWizard = onWizard && liveVisible;
```

Replace with (single source of truth — the section's visibility, which `syncLiveStatusVisibility` already computed):

```js
  const liveVisible = !!sec && sec.style.display !== 'none';
  // v2.142: the Live Status section's own visibility is the single source of
  // truth for whether the card belongs in the wizard slot. Previously this
  // also required document.body.route-wizard, which disagreed with the
  // hash-based test in syncLiveStatusVisibility() on a local/native run —
  // the header showed but #active-card was never relocated (empty box).
  const wantWizard = liveVisible && !!slot;
```

- [ ] **Step 2: Manual verification — local run**

Run: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &` then in the app: New Campaign → configure a tiny run → leave "Running in cloud" UNticked → Start.
Expected: the **Live Status** section on the wizard shows the populated `#active-card` (same card as the dashboard, with the live log), not an empty box.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "fix: Live Status card empty on local run — gate card relocation on section visibility"
```

---

### Task 2: Pre-flight action buttons no longer overlap

**Files:**
- Modify: `public/css/style.css` — `.pf-actions` (~7822-7825)
- Modify: `public/index.html` — `.pf-actions` block (~3356-3363) only if a wrapper row is needed

**Interfaces:**
- Consumes: existing button ids `#pf-fix`, `#pf-exclude`, `#pf-anyway`, `#pf-cancel` and `.pf-count-note`. No JS/handler changes.
- Produces: a layout where no button overlaps another at any width ≥ 360px.

**Root cause:** `.pf-actions` is `display:flex; flex-wrap:wrap` with a `flex:1` spacer; the long "Keep flagged, launch anyway (blocklisted still excluded)" label + the primary button overflow and the spacer math collapses them.

- [ ] **Step 1: Replace the flex-spacer layout with a non-overlapping wrap**

Current:

```css
.pf-actions { display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--hairline);
  margin-top: 8px; padding-top: 22px; flex-wrap: wrap; }
.pf-actions .spacer { flex: 1; }
```

Replace with:

```css
.pf-actions { display: flex; gap: 10px 12px; align-items: center; flex-wrap: wrap;
  border-top: 1px solid var(--hairline); margin-top: 8px; padding-top: 22px; }
/* Every action sizes to its content and never shrinks into a neighbour; the
   long "Keep flagged…" button is allowed to take its own full row. */
.pf-actions > .btn { flex: 0 0 auto; white-space: nowrap; }
.pf-actions #pf-anyway { flex: 1 1 100%; }   /* long label → own row, full width */
.pf-actions .spacer { display: none; }        /* spacer no longer needed */
.pf-count-note { flex: 1 1 100%; }
```

- [ ] **Step 2: Manual verification — blockers present**

Run the app (dev:app already running from Task 1), start a campaign whose sheet has a blocklisted/flagged lead so the pre-flight overlay opens with the "Keep flagged, launch anyway (blocklisted still excluded)" label active.
Expected: all four buttons (`Fix on sheet`, `Exclude all flagged & launch`, `Keep flagged, launch anyway…`, `Cancel`) are fully readable and none overlap; the explainer note sits on its own line.

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "fix: pre-flight action buttons overlap — content-sized wrap, long button on own row"
```

---

### Task 3: SoO warm-up suggestion helper (pure, tested)

**Files:**
- Modify: `public/js/account-guardrails.mjs` — add `warmupSuggestedFromSoo`
- Test: `tests/account-guardrails.test.js` — add cases

**Interfaces:**
- Produces: `export function warmupSuggestedFromSoo(soo): boolean` — true when the SoO row marks the account as new/immature. Reads a candidate set of column names case-insensitively; truthy values are `TRUE`, `true`, `yes`, `y`, `1`, `new`, `immature` (trimmed, lower-cased). Absent column or any other value → `false`.
- Consumed by: Task 4 (tile render).

- [ ] **Step 1: Write the failing test**

Append to `tests/account-guardrails.test.js`:

```js
import { warmupSuggestedFromSoo } from '../public/js/account-guardrails.mjs';

test('warmupSuggestedFromSoo: flags TRUE/yes/new/immature in a candidate column', () => {
  assert.equal(warmupSuggestedFromSoo({ Immature: 'TRUE' }), true);
  assert.equal(warmupSuggestedFromSoo({ Immature: 'yes' }), true);
  assert.equal(warmupSuggestedFromSoo({ Maturity: 'immature' }), true);
  assert.equal(warmupSuggestedFromSoo({ 'New Account': 'new' }), true);
});

test('warmupSuggestedFromSoo: false when column absent or value not a flag', () => {
  assert.equal(warmupSuggestedFromSoo({ Status: 'Available' }), false);
  assert.equal(warmupSuggestedFromSoo({ Immature: '' }), false);
  assert.equal(warmupSuggestedFromSoo({ Immature: 'mature' }), false);
  assert.equal(warmupSuggestedFromSoo({}), false);
  assert.equal(warmupSuggestedFromSoo(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/account-guardrails.test.js`
Expected: FAIL — `warmupSuggestedFromSoo` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `public/js/account-guardrails.mjs`:

```js
// ⑫ Warm-up suggestion — the SoO sheet may (future) carry a column flagging
// new/"immature" accounts that should warm up before running at full volume.
// The column name is not final (working name "Immature"); read a small
// candidate set case-insensitively. Absent column → no suggestion (safe).
const WARMUP_FLAG_COLUMNS = ['immature', 'maturity', 'new account', 'newaccount'];
const WARMUP_FLAG_TRUTHY = new Set(['true', 'yes', 'y', '1', 'new', 'immature']);
export function warmupSuggestedFromSoo(soo) {
  if (!soo || typeof soo !== 'object') return false;
  for (const key of Object.keys(soo)) {
    if (!WARMUP_FLAG_COLUMNS.includes(key.trim().toLowerCase())) continue;
    const val = String(soo[key] ?? '').trim().toLowerCase();
    if (WARMUP_FLAG_TRUTHY.has(val)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/account-guardrails.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add public/js/account-guardrails.mjs tests/account-guardrails.test.js
git commit -m "feat: warmupSuggestedFromSoo — tolerant SoO 'new account' flag read"
```

---

### Task 4: Warm-up in-tile toggle — always reversible + SoO suggestion

**Files:**
- Modify: `public/js/app.js` — import list (line 32), warm-up render branch (~1752-1776), listener wiring is unchanged (~1798-1806)
- Modify: `public/css/style.css` — add `.wu-suggest` accent (near `.wu-link`)

**Interfaces:**
- Consumes: `warmupSuggestedFromSoo` (Task 3), existing `wuStatus()`, `warmupData`, `setProfileWarmup()`, and the per-tile `soo` object already in scope in `renderProfiles()`.
- Produces: warm-up affordance rendered for every NON-locked tile: `Turn off` shows whenever warm-up is active or complete (any tile state — this is the revert fix); `Warm up?` shows on free tiles only, styled as a suggestion when SoO-flagged.

**Root cause of the revert bug:** the warm-up sub-line (incl. "Stop warm-up") is built only inside `if (_state.state === 'free' && !_locked)`. Selecting an account moves it out of `free`, so the Stop affordance disappears.

- [ ] **Step 1: Add the helper to the app.js import**

Line 32 currently imports from `/js/account-guardrails.mjs`. Add `warmupSuggestedFromSoo` to that import list:

```js
import { classifyAccountFlag, summarizeSelection, classifyAccountState, isRestrictedStatus, isHiddenSection, lookupSoO, isBreakdownMode, classifyAccountChannels, breakdownAssignee, warmupSuggestedFromSoo } from '/js/account-guardrails.mjs';
```

- [ ] **Step 2: Replace the free-only warm-up branch with an any-state affordance**

Replace the block that currently starts at `if (_state.state === 'free' && !_locked) {` (the WARM-UP stat-zone takeover + `_sub` affordance, ending at its closing `}` before `_classes =`) with:

```js
      // ⑫ Warm-up (v2.142): the badge still takes over the FREE stat zone, but
      // the toggle affordance renders for ANY non-locked tile so an armed
      // account can always be turned back off — even after it's selected and
      // shows IN USE (the v2.140 "can't revert" bug). Suggestion to START only
      // appears on a free tile; SoO may flag it as a new/immature account.
      if (!_locked) {
        if (_wu.active) {
          if (_state.state === 'free') {
            _statZone = `
      <div class="jt-stat s-warmup">
        <span class="jt-dot"></span>
        <span class="jt-word">WARM-UP</span>
        <span class="jt-zsub">wk ${_wu.week} · ${_wu.cap}/day</span>
      </div>`;
          }
          _sub += ` · <b>Warm-up wk ${_wu.week} of ${WU_WEEKS} — ${_wu.cap}/day</b>`
            + ` <a class="wu-link" href="#" data-wu-enable="0">Turn off</a>`;
        } else if (_wu.complete) {
          _sub += ` · <b style="color:var(--green)">✓ warm-up complete</b>`
            + ` <a class="wu-link" href="#" data-wu-enable="0">Clear</a>`;
        } else if (_state.state === 'free') {
          _sub += warmupSuggestedFromSoo(soo)
            ? ` <a class="wu-link wu-suggest" href="#" data-wu-enable="1">Warm up? — flagged new in SoO</a>`
            : ` <a class="wu-link" href="#" data-wu-enable="1">Warm up?</a>`;
        }
      }
```

Note: `soo` is the per-tile SoO object already resolved earlier in the loop (used by `classifyAccountState(soo, …)`); confirm the in-scope variable name at implementation time and match it.

- [ ] **Step 3: Add the suggestion accent CSS**

Near the existing `.wu-link` rule in `public/css/style.css`, add:

```css
/* SoO-flagged new account — a nudge to warm up, gold to match the WARM-UP badge. */
.wu-link.wu-suggest { color: var(--gold); font-weight: 600; }
```

- [ ] **Step 4: Manual verification — revert from every state**

dev:app running. In the account picker:
1. On a FREE tile click **Warm up?** → tile shows WARM-UP badge + "Turn off".
2. Select that account (check it) so it becomes selected/IN USE → confirm **Turn off** is STILL visible in the sub-line.
3. Click **Turn off** → warm-up clears from the IN USE state; tile returns to normal.
4. If a SoO row is flagged (e.g. a test sheet with an `Immature` column = TRUE), its free tile shows the gold "Warm up? — flagged new in SoO" nudge; it does NOT auto-arm.

Expected: warm-up is reversible from any tile state; suggestion only nudges.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/css/style.css
git commit -m "feat: warm-up in-tile toggle reversible from any state + SoO suggestion (fixes v2.140 revert bug)"
```

---

### Task 5: Version bump + relaunch for operator verification

**Files:**
- Modify: `package.json` (line 4)

- [ ] **Step 1: Bump the version**

Change `"version": "2.141.0",` → `"version": "2.142.0",`.

- [ ] **Step 2: Relaunch and confirm the build number shows**

Run: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`
Expected: the app's version indicator reads **2.142.0**.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump to v2.142.0 (warm-up revert + live-status + preflight overlap fixes)"
```

---

## Self-Review

**Spec coverage:**
- ① warm-up revert → Task 4 (toggle renders for any non-locked tile; `Turn off` in all states). ✓
- ② Live Status empty on local run → Task 1 (single visibility source of truth). ✓
- ③ pre-flight overlap → Task 2 (content-sized wrap). ✓
- ④ warm-up entry-point rework (Variant B, SoO-suggested/operator-confirmed, tolerant of missing column) → Tasks 3 + 4. ✓
- Out-of-scope "6. LAUNCH BLOCKED" chip — correctly not touched. ✓

**Placeholder scan:** All code steps contain real code; the one deferred item (final SoO column name) is handled by a candidate-set read with a safe default, not a placeholder. The only implementation-time check is confirming the in-scope `soo` variable name in Task 4 Step 2 — noted explicitly.

**Type consistency:** `warmupSuggestedFromSoo(soo): boolean` defined in Task 3, imported and called in Task 4 with the same signature. `wuStatus()`, `warmupData`, `setProfileWarmup()`, `WU_WEEKS` all reused as they exist today.
