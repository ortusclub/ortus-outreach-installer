# v2.140 fixes + warm-up removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two v2.140 defects (Live Status empty on local runs, pre-flight buttons overlap) and REMOVE the warm-up feature entirely (operator decided it's not needed).

**Architecture:** Task 1 (done) and Task 2 are surgical frontend fixes in `public/`. Tasks 3–4 rip out the warm-up feature: backend (`src/warmup.js`, `src/warmup-store.js`, `/api/warmup`, the daily-limit cap in `src/campaign.js`, `tests/warmup.test.js`) and frontend (all warm-up UI in `app.js`, `index.html`, `style.css`, plus the exploratory sketch). Removing warm-up means every profile simply uses `campaign.dailyLimit` — the prior default before warm-up existed.

**Tech Stack:** Vanilla JS (ES modules, no bundler), Express 4, `node --test`, Electron dev shell.

**Spec:** `docs/superpowers/specs/2026-07-09-warmup-livestatus-preflight-design.md` (warm-up rework sections now superseded by removal — see this plan's Tasks 3–4).

## Global Constraints

- Node ≥22; no bundler for frontend; vanilla JS only.
- Bugatti design system: monochrome + hairlines, gold (`--gold`) is the only accent; radii `0` or `9999`. Reuse existing tokens — introduce no new colors.
- **Off-limits files** — never touch `src/linkedin/outreach.js` / `src/linkedin/actions.js`.
- Patch-bump `package.json` version before relaunching so the operator can confirm the build (`2.141.0` → `2.142.0`).
- After a commit touching runtime code, relaunch dev:app: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`
- Removing warm-up must not change any non-warm-up behavior: with no account armed, `profileDailyLimit(id)` already returned `campaign.dailyLimit`, so replacing it is behavior-preserving for every existing run.
- The full test suite must pass after backend removal: `node --test`.

---

### Task 1: Live Status shows on a local/native run  ✅ COMPLETE (commit 63c393b)

Done and reviewed clean. `placeLiveCard()` now gates card relocation on `#nav-status` visibility (single source of truth), fixing the empty Live Status box on local runs.

---

### Task 2: Pre-flight action buttons no longer overlap

**Files:**
- Modify: `public/css/style.css` — `.pf-actions` (~7822-7825)

**Interfaces:**
- Consumes: existing button ids `#pf-fix`, `#pf-exclude`, `#pf-anyway`, `#pf-cancel` and `.pf-count-note`. No JS/handler/markup changes.
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

Start a campaign whose sheet has a blocklisted/flagged lead so the pre-flight overlay opens with the "Keep flagged, launch anyway (blocklisted still excluded)" label active.
Expected: all four buttons are fully readable and none overlap; the explainer note sits on its own line.

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "fix: pre-flight action buttons overlap — content-sized wrap, long button on own row"
```

---

### Task 3: Remove warm-up — backend + campaign loop

**Files:**
- Delete: `src/warmup.js`, `src/warmup-store.js`, `tests/warmup.test.js`
- Modify: `src/campaign.js` — remove imports (33-34) + the `profileDailyLimit` block (~3132-3157) + its 3 call sites
- Modify: `server.js` — remove the `/api/warmup` route(s)

**Interfaces:**
- Produces: no warm-up module, no `/api/warmup` endpoint. `src/campaign.js` uses `campaign.dailyLimit` directly for every profile's per-run quota.

**Behavior note:** `profileDailyLimit(id)` returned `campaign.dailyLimit` whenever the profile had no enabled warm-up entry — which, post-removal, is always. So substituting `campaign.dailyLimit` is exactly the pre-warm-up behavior.

- [ ] **Step 1: Remove the campaign.js warm-up imports**

`src/campaign.js` lines 33-34 are:

```js
import { effectiveDailyLimit, warmupStatus, WARMUP_WEEKS } from './warmup.js';
import { readWarmup } from './warmup-store.js';
```

Delete both lines.

- [ ] **Step 2: Delete the `profileDailyLimit` block**

Delete the whole block (currently ~3132-3157) — the `⑫ Account warm-up mode` comment, `const _warmupMap = readWarmup();`, `const _warmupCapLogged = new Set();`, and the entire `function profileDailyLimit(profileId) { … }`.

- [ ] **Step 3: Replace the 3 call sites with `campaign.dailyLimit`**

Site A (~3222):
```js
        if (!skipsDailyLimit && getCampaignCount(candidate) >= profileDailyLimit(candidate)) continue; // ⑫ warm-up-aware
```
→
```js
        if (!skipsDailyLimit && getCampaignCount(candidate) >= campaign.dailyLimit) continue;
```

Site B (~3243):
```js
        (!skipsDailyLimit && getCampaignCount(id) >= profileDailyLimit(id)) // ⑫ warm-up-aware
```
→
```js
        (!skipsDailyLimit && getCampaignCount(id) >= campaign.dailyLimit)
```

Site C (~4281-4292) — the whole warm-up-aware completion block:
```js
            // ⑫ warm-up-aware: a warming account "completes" at its capped limit.
            const _limitNow = profileDailyLimit(profileId);
            if (!skipsDailyLimit && getCampaignCount(profileId) >= _limitNow) {
              const _wuCapped = _limitNow < campaign.dailyLimit;
              recordProfileEnd(profileId, pName, `Reached campaign limit (${_limitNow}${_wuCapped ? ' — warm-up cap' : ''})`);
              // ⑫ A warm-up cap (e.g. 5/day) is smaller than BATCH_SIZE, so
              // without this break the turn would keep sending until the batch
              // is drained and overshoot the ramp. Only break for the warm-up
              // case — the pre-existing turn behaviour for the normal campaign
              // limit is left exactly as it was.
              if (_wuCapped) break;
            }
```
→
```js
            if (!skipsDailyLimit && getCampaignCount(profileId) >= campaign.dailyLimit) {
              recordProfileEnd(profileId, pName, `Reached campaign limit (${campaign.dailyLimit})`);
            }
```

- [ ] **Step 4: Remove the `/api/warmup` routes in server.js**

Find the warm-up route handlers (`grep -n "warmup\|/api/warmup" server.js`) and delete the GET `/api/warmup` and POST `/api/warmup/:profileId` handlers in full, including any import of `warmup-store`/`warmup` at the top of `server.js`.

- [ ] **Step 5: Delete the warm-up files and its test**

```bash
git rm src/warmup.js src/warmup-store.js tests/warmup.test.js
```

- [ ] **Step 6: Run the full suite — no dangling references**

Run: `node --test`
Expected: PASS, 0 failures. If any test or module still imports `./warmup.js` / `warmup-store.js`, that's a dangling reference — fix it. Also run `grep -rn "warmup\|effectiveDailyLimit\|profileDailyLimit\|readWarmup" src server.js` and confirm zero hits.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove warm-up feature — backend + campaign daily-limit cap (operator: not needed)"
```

---

### Task 4: Remove warm-up — frontend + sketch

**Files:**
- Modify: `public/js/app.js` — imports (32), `loadWarmup`/`setProfileWarmup`/`wuStatus`/`renderWarmupSched` + `WU_SCHEDULE`/`WU_WEEKS`/`warmupData`/`wuSchedOpenFor` (~586-660), the warm-up tile render branch (~1752-1776), the `.wu-link` listener wiring (~1798-1806), the `loadWarmup()` call (~1546), `renderWarmupSched()` call (~1825), and any `window.*` warm-up bindings
- Modify: `public/index.html` — remove `#wu-sched` element (~1716) and any warm-up copy
- Modify: `public/css/style.css` — remove `.s-warmup`, `.wu-link`, `.wu-sched*`, `.wu-step*` rules
- Delete: `public/sketches/warmup-entry-variants.html` + its card in `public/sketches/index.html`
- Modify: `public/help.html` — remove the warm-up mention

**Interfaces:**
- Consumes: nothing new. Produces: an account picker tile that renders its normal state (`FREE` / `ASSIGNED` / `IN USE` / `BLOCKED`) with NO warm-up affordance anywhere.

- [ ] **Step 1: Remove the tile render branch**

In `renderProfiles()`, delete the entire warm-up block: the `const _wuEntry = warmupData[p.id];` / `const _wu = wuStatus(_wuEntry);` lines and the `if (_state.state === 'free' && !_locked) { … warm-up … }` sub-branch that sets the WARM-UP stat zone and the `Start warm-up`/`Stop warm-up` sub-line. The base `_statZone` (FREE/ASSIGNED/etc.) and the plain `_sub` strings ("Anyone can use." etc.) must remain intact.

- [ ] **Step 2: Remove the `.wu-link` listener wiring**

Delete the `const wuLink = item.querySelector('.wu-link'); if (wuLink) { … addEventListener … setProfileWarmup … }` block (~1798-1806). Leave the checkbox (`const cb = …`) wiring immediately after it untouched.

- [ ] **Step 3: Remove the warm-up functions + state + calls**

Delete `loadWarmup()`, `setProfileWarmup()`, `wuStatus()`, `renderWarmupSched()`, and the module-level `warmupData`, `wuSchedOpenFor`, `WU_SCHEDULE`, `WU_WEEKS` declarations. Remove the `await loadWarmup();` call (~1546) and the `renderWarmupSched();` call (~1825). Remove `warmupSuggestedFromSoo` from the `account-guardrails.mjs` import line only if present (it was never added — verify).

- [ ] **Step 4: Remove markup, CSS, sketch, help copy**

- `public/index.html`: delete the `<div id="wu-sched" …>` element and its comment.
- `public/css/style.css`: delete the `.s-warmup`, `.wu-link`, `.wu-sched`, `.wu-steps`, `.wu-step`, `.wu-sched-head`, `.wu-sched-note` rules (grep them out).
- `git rm public/sketches/warmup-entry-variants.html` and delete its `<a class="card" href="warmup-entry-variants.html" …>…</a>` block from `public/sketches/index.html`.
- `public/help.html`: remove the warm-up line.

- [ ] **Step 5: Verify no dangling references + manual render check**

Run: `grep -rn "warmup\|warm-up\|wu-sched\|wu-link\|wuStatus\|s-warmup\|WU_SCHEDULE\|WU_WEEKS\|renderWarmupSched\|setProfileWarmup\|loadWarmup" public/js/app.js public/index.html public/css/style.css public/help.html`
Expected: zero hits.
Then load the app (dev:app): open the account picker → tiles render normally in every state with no warm-up link, no console errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove warm-up UI, styles, and exploratory sketch (operator: not needed)"
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
git commit -m "chore: bump to v2.142.0 (live-status + preflight fixes, warm-up removed)"
```

---

## Self-Review

**Spec coverage (as amended by the operator's remove-warm-up decision):**
- Live Status empty on local run → Task 1 ✅ (done).
- Pre-flight overlap → Task 2.
- Warm-up: the spec's ①/④ rework is superseded — operator chose full removal → Tasks 3 (backend + campaign loop) + 4 (frontend + sketch).
- Out-of-scope "6. LAUNCH BLOCKED" chip — not touched. ✓

**Placeholder scan:** Task 3/4 name exact files, line ranges, before/after code, and a grep gate proving no dangling references. The one search-driven step (server.js `/api/warmup` handler bounds) is explicit about what to delete and is verified by Step 6's grep + full suite.

**Behavior preservation:** `profileDailyLimit(id)` ≡ `campaign.dailyLimit` for any profile without an enabled warm-up entry (which is all of them once the store is gone), so Task 3 is behavior-preserving for every real run. The full `node --test` suite is the gate.
