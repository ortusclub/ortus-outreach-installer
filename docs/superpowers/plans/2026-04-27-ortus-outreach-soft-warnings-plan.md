# Ortus Outreach Soft-Warnings 2.8.22 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate the soft warnings that `src/linkedin/*` already detects (weekly limit, rate-limited, email-required, how-do-you-know modal) into per-account state, surface in the dashboard right pane, and persist to an append-only NDJSON log so operators can review what fired overnight.

**Architecture:** Single-sweep patch series on branch `throughput-2.8.22`. Three patches commit in order W1 (state + inspection points + helper) → W2 (UI surface) → W3 (NDJSON persistence + endpoint + frontend merge), then FINAL bumps version. All patches additive — no behavior changes to detection, parking, throttle, or campaign flow. Patterns mirror 2.8.20-B1 (parkedProfiles state), 2.8.20-B2 (NDJSON appendErrorLog + /api/errors + loadPersistedErrors).

**Tech Stack:** Node ≥22, vanilla JS + Express 4, Electron 33, GoLogin 2.2.8, puppeteer-core 22, `node --test` for backend tests, no bundler for frontend, manual browser smoke for UI.

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `src/campaign.js` (~1503 lines) | campaign state + `pushSoftWarning` helper + 3 inspection-site calls + `appendWarningLog` + payload | W1, W3 |
| `tests/soft-warning-helper.test.js` | NEW — pure-helper tests for dedupe + cap | W1 |
| `public/index.html` | NEW `#rp-warnings-row` after `#rp-parked-row` | W2 |
| `public/css/style.css` | NEW `.rp-warnings-line` / `.rp-warnings-detail` styles | W2 |
| `public/js/app.js` (~3946 lines) | NEW `_prettyWarningKind` / `renderSoftWarnings` / `toggleWarningDetail` / `loadPersistedWarnings` + wire to `pollStatus` and startup IIFE | W2, W3 |
| `server.js` (~1158 lines) | NEW `GET /api/warnings` endpoint near `/api/errors` (line ~1064) | W3 |
| `data/warnings-log.ndjson` | NEW — created on first warning, append-only NDJSON | W3 (runtime, not committed) |
| `package.json` | version field bump | FINAL |

**Off-limits — DO NOT touch in any task:**
- `src/linkedin/outreach.js`
- `src/linkedin/actions.js`

If a task seems to require touching these files, STOP and escalate to the controller.

---

## Task 0: Pre-flight + branch creation

**Files:**
- Read: `package.json`, current branch via `git status`
- Create: branch `throughput-2.8.22`

- [ ] **Step 1: Verify on main, version is 2.8.21, working tree clean**

Run:
```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected:
- Branch: `main`
- Version: `2.8.21`
- `git status --short`: empty or only untracked dev artifacts. ANY tracked modifications: stop and ask the controller.

- [ ] **Step 2: Verify all tests pass**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Pass count should be 114 (per 2.8.21 baseline). Any failure: stop.

- [ ] **Step 3: Create and switch to branch `throughput-2.8.22`**

Run:
```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b throughput-2.8.22
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `throughput-2.8.22`.

No commit on this task.

---

## Task W1: State + inspection + helper + tests

This task touches `src/campaign.js` in 6 places + adds one new test file. Single commit at end.

**Files:**
- Modify: `src/campaign.js`
- Create: `tests/soft-warning-helper.test.js`

### Step group A — Helper definition

- [ ] **Step A1: Locate the existing `parkedProfiles` references in `src/campaign.js`**

Run:
```bash
grep -nE "parkedProfiles|appendErrorLog" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected (per 2026-04-27 codebase state):
- Line 239: `parkedProfiles: []` (in `campaign` state object)
- Line 265: `async function appendErrorLog(entry) {`
- Line 291: `appendErrorLog(entry).catch(() => {});`
- Line 572: `campaign.parkedProfiles = [];` (reset in `startCampaign`)
- Line 757, 1163: push sites
- Line 1475: bubbled into `getCampaignStatus()` payload as `parked`

Use these as anchors for subsequent steps. If line numbers have drifted, find the equivalent and use the new lines. The pattern is what matters, not the absolute number.

- [ ] **Step A2: Add `softWarnings: []` to the `campaign` state object**

Edit `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`. Find the line that contains `parkedProfiles: [],` (currently line 239). Add a new line directly after it:

Find:
```javascript
  parkedProfiles: [],
```
Replace with:
```javascript
  parkedProfiles: [],
  softWarnings: [],
```

- [ ] **Step A3: Add `SOFT_WARNING_DEDUPE_MS` constant + `pushSoftWarning` helper**

Edit `src/campaign.js`. Find the line `async function appendErrorLog(entry) {` (currently line 265). Insert the following block IMMEDIATELY BEFORE that line:

```javascript
// Soft-warning dedupe window — same (profileId, kind) within this many ms is suppressed.
const SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000;
const SOFT_WARNING_CAP = 200;

/**
 * Append a soft warning to in-memory state with dedupe + cap.
 * Pure logic — does not write to disk (W3 adds that side-effect via appendWarningLog).
 *
 * @param {Object} state - The campaign state object (mutated)
 * @param {Object} entry - { profileId, pName, kind, message }
 * @returns {Object|null} - The pushed entry, or null if deduped
 */
function pushSoftWarning(state, { profileId, pName, kind, message }) {
  const now = Date.now();
  const cutoff = now - SOFT_WARNING_DEDUPE_MS;

  // Dedupe: skip if same (profileId, kind) was added within window
  for (let i = state.softWarnings.length - 1; i >= 0; i--) {
    const e = state.softWarnings[i];
    if (e.detectedAt < cutoff) break; // entries are time-ordered; stop walking
    if (e.profileId === profileId && e.kind === kind) {
      return null;
    }
  }

  const entry = { profileId, pName, kind, message, detectedAt: now };
  state.softWarnings.push(entry);

  // Cap: FIFO trim from front when exceeded
  while (state.softWarnings.length > SOFT_WARNING_CAP) {
    state.softWarnings.shift();
  }

  return entry;
}
```

### Step group B — State reset + inspection sites

- [ ] **Step B1: Reset `softWarnings` in `startCampaign`**

Edit `src/campaign.js`. Find the line `campaign.parkedProfiles = [];` (currently line 572). Add a new line directly after:

Find:
```javascript
  campaign.parkedProfiles = [];
```
Replace with:
```javascript
  campaign.parkedProfiles = [];
  campaign.softWarnings = [];
```

- [ ] **Step B2: Inspect site #1 — `rate_limited` recognition (around line 1048)**

Run:
```bash
grep -n "rate_limited" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Find the line in the consumption site that matches the `rate_limited` outcome from `performOutreach`. Read 5 lines of context before and after to identify the exact insertion point.

Add a `pushSoftWarning` call immediately after the `rate_limited` is recognized. The call shape:
```javascript
pushSoftWarning(campaign, {
  profileId,
  pName,
  kind: 'rate_limited',
  message: 'LinkedIn rate-limit page shown',
});
```

The exact insertion point depends on the surrounding control flow. The principle: place it where you can SEE that the rate-limited outcome was just recognized, with `profileId` and `pName` (or equivalent) in scope. If `pName` is not in scope at that exact line, walk up the function to where it is and place the call there inside the same conditional branch.

- [ ] **Step B3: Inspect site #2 — weekly invitation limit auditAction (around line 1180)**

Run:
```bash
grep -n "Weekly invitation limit reached" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Find the line that contains `auditAction: 'Weekly invitation limit reached',` (currently line 1180). Read 10 lines of context before to find where the `pName` / `profileId` are in scope.

Add a `pushSoftWarning` call immediately before or after that audit-log emission, in the same conditional branch:
```javascript
pushSoftWarning(campaign, {
  profileId,
  pName,
  kind: 'weekly_limit',
  message: 'Weekly invitation limit reached',
});
```

- [ ] **Step B4: Find inspection site #3 — `hasWeeklyLimit` / `hasEmailRequired` / `hasHowDoYouKnow` modal flags**

These flags are returned from the modal-detection function in `src/linkedin/actions.js` (off-limits). The CONSUMER site is in `src/campaign.js` (or possibly via `performOutreach`'s return value). Run:

```bash
grep -nE "hasWeeklyLimit|hasEmailRequired|hasHowDoYouKnow" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js /Users/antoniovarlese/ortus-gologin-clone/server.js
```

Three possible outcomes:
1. **Match in `src/campaign.js`**: Add `pushSoftWarning` calls at that consumption site. Pattern:
   ```javascript
   if (modalFlags.hasWeeklyLimit) {
     pushSoftWarning(campaign, {
       profileId, pName,
       kind: 'weekly_limit',
       message: 'Weekly invitation limit modal',
     });
   }
   if (modalFlags.hasEmailRequired) {
     pushSoftWarning(campaign, {
       profileId, pName,
       kind: 'email_required',
       message: 'LinkedIn requires email to connect',
     });
   }
   if (modalFlags.hasHowDoYouKnow) {
     pushSoftWarning(campaign, {
       profileId, pName,
       kind: 'how_do_you_know',
       message: 'LinkedIn asked how you know this person',
     });
   }
   ```
   (Variable name `modalFlags` is illustrative — use whatever the actual variable is at the consumption site.)

2. **No match in `src/campaign.js` — the flags are consumed inside `linkedin/outreach.js` (off-limits) and the outcome bubbles up only as a generic `{ action: 'skipped', error: 'something' }`**: In this case, the flags are not directly observable at the campaign-loop level. SKIP this inspection site — DO NOT modify `linkedin/outreach.js` to expose them. Report this as a known limitation in the task report (only sites #1 and #2 wired up).

3. **Match in `server.js` (template preview path)**: Not relevant to the campaign loop; ignore.

After deciding which case applies, proceed.

### Step group C — Bubble into payload

- [ ] **Step C1: Add `softWarnings` to `getCampaignStatus()` payload**

Edit `src/campaign.js`. Find the line `parked: campaign.parkedProfiles.slice(),` (currently line 1475). Add a new line directly after:

Find:
```javascript
    parked: campaign.parkedProfiles.slice(),
```
Replace with:
```javascript
    parked: campaign.parkedProfiles.slice(),
    softWarnings: campaign.softWarnings.slice(),
```

### Step group D — Tests

- [ ] **Step D1: Write `tests/soft-warning-helper.test.js`**

Create `/Users/antoniovarlese/ortus-gologin-clone/tests/soft-warning-helper.test.js` with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — pushSoftWarning helper. Replicated here to avoid coupling
// the test to campaign.js internals (matches the pattern of
// tests/watchdog-helper.test.js which inlines withWatchdog).

const SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000;
const SOFT_WARNING_CAP = 200;

function pushSoftWarning(state, { profileId, pName, kind, message }) {
  const now = Date.now();
  const cutoff = now - SOFT_WARNING_DEDUPE_MS;
  for (let i = state.softWarnings.length - 1; i >= 0; i--) {
    const e = state.softWarnings[i];
    if (e.detectedAt < cutoff) break;
    if (e.profileId === profileId && e.kind === kind) return null;
  }
  const entry = { profileId, pName, kind, message, detectedAt: now };
  state.softWarnings.push(entry);
  while (state.softWarnings.length > SOFT_WARNING_CAP) state.softWarnings.shift();
  return entry;
}

test('pushSoftWarning adds entry to empty state', () => {
  const state = { softWarnings: [] };
  const result = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'rate_limited', message: 'test',
  });
  assert.equal(state.softWarnings.length, 1);
  assert.equal(state.softWarnings[0].profileId, 'p1');
  assert.equal(state.softWarnings[0].kind, 'rate_limited');
  assert.equal(state.softWarnings[0].message, 'test');
  assert.equal(typeof state.softWarnings[0].detectedAt, 'number');
  assert.equal(result, state.softWarnings[0]);
});

test('pushSoftWarning dedupes same (profileId, kind) within window', () => {
  const state = { softWarnings: [] };
  const first = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'first',
  });
  const second = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'second',
  });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(state.softWarnings.length, 1);
  assert.equal(state.softWarnings[0].message, 'first');
});

test('pushSoftWarning allows different kind for same profile within window', () => {
  const state = { softWarnings: [] };
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'limit',
  });
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'rate_limited', message: 'rate',
  });
  assert.equal(state.softWarnings.length, 2);
});

test('pushSoftWarning allows same kind for different profile within window', () => {
  const state = { softWarnings: [] };
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'a',
  });
  pushSoftWarning(state, {
    profileId: 'p2', pName: 'Beth', kind: 'weekly_limit', message: 'b',
  });
  assert.equal(state.softWarnings.length, 2);
});

test('pushSoftWarning re-allows same (profileId, kind) after window expires', () => {
  const state = { softWarnings: [] };
  // Manually seed an expired entry
  state.softWarnings.push({
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'old',
    detectedAt: Date.now() - (SOFT_WARNING_DEDUPE_MS + 1000),
  });
  const result = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'new',
  });
  assert.ok(result);
  assert.equal(state.softWarnings.length, 2);
  assert.equal(state.softWarnings[1].message, 'new');
});

test('pushSoftWarning trims from front when cap exceeded', () => {
  const state = { softWarnings: [] };
  // Push 201 entries with different (profileId, kind) so dedupe doesn't fire
  for (let i = 0; i < 201; i++) {
    pushSoftWarning(state, {
      profileId: `p${i}`, pName: `n${i}`, kind: 'rate_limited', message: `m${i}`,
    });
  }
  assert.equal(state.softWarnings.length, 200);
  // Oldest (p0) should be evicted; newest (p200) should be present
  assert.equal(state.softWarnings[0].profileId, 'p1');
  assert.equal(state.softWarnings[199].profileId, 'p200');
});
```

- [ ] **Step D2: Run the new test to verify it passes**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --test tests/soft-warning-helper.test.js 2>&1 | tail -15
```

Expected: 6 passing tests, 0 failing.

- [ ] **Step D3: Run full suite to ensure no regression**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Pass count = 114 + 6 = 120.

### Step group E — Commit W1

- [ ] **Step E1: Commit W1**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js tests/soft-warning-helper.test.js
git commit -m "$(cat <<'EOF'
feat(2.8.22): W1 — softWarnings state + pushSoftWarning helper

Adds in-memory aggregation for soft warnings already detected by
src/linkedin/* (off-limits): weekly_limit, rate_limited, email_required,
how_do_you_know.

Changes:
- New campaign state field: softWarnings: []
- New helper: pushSoftWarning(state, entry) with 10-min dedupe per
  (profileId, kind) and 200-entry FIFO cap
- Reset alongside parkedProfiles in startCampaign
- pushSoftWarning called at existing detection consumption sites:
  - rate_limited recognition (campaign.js ~line 1048)
  - Weekly invitation limit auditAction emission (~line 1180)
  - Modal flag consumer (if visible at campaign-loop level)
- softWarnings: campaign.softWarnings.slice() bubbled into
  getCampaignStatus payload alongside parked

No touches to src/linkedin/*. No detection logic changed.

Test: tests/soft-warning-helper.test.js — 6 pure-logic tests covering
push, dedupe, multi-profile, multi-kind, window expiry, cap trim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task W2: UI surface

**Files:**
- Modify: `public/index.html`
- Modify: `public/css/style.css`
- Modify: `public/js/app.js`

### Step group A — HTML

- [ ] **Step A1: Locate the existing `#rp-parked-row` block**

Run:
```bash
grep -nA 4 'id="rp-parked-row"' /Users/antoniovarlese/ortus-gologin-clone/public/index.html
```

Expected: a 4-line block starting around line 593:
```html
<div class="rp-section" id="rp-parked-row" hidden>
  <div class="rp-label" data-edit="rp-label-parked">Parked</div>
  <div class="rp-parked-line" id="rp-parked-line" onclick="toggleParkedDetail()" style="cursor:pointer">—</div>
  <div class="rp-parked-detail" id="rp-parked-detail" hidden></div>
</div>
```

- [ ] **Step A2: Insert `#rp-warnings-row` immediately after `#rp-parked-row`**

Edit `/Users/antoniovarlese/ortus-gologin-clone/public/index.html`. After the closing `</div>` of `#rp-parked-row` (the one that closes the `<div class="rp-section" id="rp-parked-row" hidden>`), insert:

```html
      <div class="rp-section" id="rp-warnings-row" hidden>
        <div class="rp-label" data-edit="rp-label-warnings">Warnings</div>
        <div class="rp-warnings-line" id="rp-warnings-line" onclick="toggleWarningDetail()" style="cursor:pointer">—</div>
        <div class="rp-warnings-detail" id="rp-warnings-detail" hidden></div>
      </div>
```

(Match the indentation of the surrounding rows.)

### Step group B — CSS

- [ ] **Step B1: Locate the existing `.rp-parked-line` styles**

Run:
```bash
grep -nA 6 '^\.rp-parked-line' /Users/antoniovarlese/ortus-gologin-clone/public/css/style.css
```

Expected: a styles block starting around line 2444. Read the full block (and the `.has-parked` modifier and `.rp-parked-detail` block that follow) to know the exact pattern.

- [ ] **Step B2: Add `.rp-warnings-line` and `.rp-warnings-detail` styles**

Edit `/Users/antoniovarlese/ortus-gologin-clone/public/css/style.css`. Find the LAST `.rp-parked-*` rule block (likely `.rp-parked-detail { ... }`). Add the following IMMEDIATELY AFTER that rule block:

```css
.rp-warnings-line {
  font: 11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--ink);
  cursor: pointer;
  margin-top: 2px;
}
.rp-warnings-line.has-warnings {
  color: var(--ink);
}
.rp-warnings-detail {
  margin-top: 4px;
  padding: 4px 6px;
  border-left: 1px solid var(--hairline);
  font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--ink-dim);
}
```

(If the actual `--hairline`, `--ink`, `--ink-dim` variable names differ in the codebase, use whatever the parked styles used at Step B1.)

### Step group C — JS helpers

- [ ] **Step C1: Locate the parked rendering helpers**

Run:
```bash
grep -nA 1 -E "_prettyParkReason|renderParkedProfiles|toggleParkedDetail|loadPersistedErrors" /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js | head -25
```

Expected anchors (lines may shift):
- Line ~3850: `function _prettyParkReason(r) {`
- Line ~3858: `function renderParkedProfiles(parked) {`
- Line ~3884: `function toggleParkedDetail() {`
- Line ~3889: `window.toggleParkedDetail = toggleParkedDetail;`
- Line ~3896: `async function loadPersistedErrors() {`

Read all of these blocks before continuing — they're the templates to mirror.

- [ ] **Step C2: Add `_prettyWarningKind`, `renderSoftWarnings`, `toggleWarningDetail` helpers**

Edit `/Users/antoniovarlese/ortus-gologin-clone/public/js/app.js`. After the `window.toggleParkedDetail = toggleParkedDetail;` line (currently ~3889), insert:

```javascript

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

  const list = Array.isArray(warnings) ? warnings : [];
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
```

NOTE: `escapeHtml` and `_humanAgoFromTs` should both already exist in `app.js` (used by `renderParkedProfiles`). If `escapeHtml` doesn't exist, use `(s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))` inline. Verify with:
```bash
grep -nE "function escapeHtml|function _humanAgoFromTs" /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js
```

- [ ] **Step C3: Wire `renderSoftWarnings` into `pollStatus`**

Run:
```bash
grep -n "renderParkedProfiles" /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js
```

Expected line ~2009: `renderParkedProfiles(s.parked);`

Edit `app.js`. Find:
```javascript
    renderParkedProfiles(s.parked);
```
Replace with:
```javascript
    renderParkedProfiles(s.parked);
    renderSoftWarnings(s.softWarnings);
```

### Step group D — Smoke test + commit

- [ ] **Step D1: Run tests (no regression check; UI changes don't have unit tests)**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120 (unchanged from W1).

- [ ] **Step D2: Manual UI smoke test**

The dev server is already running on port 3000. Open the dashboard in a browser. Confirm:
- Right pane renders without errors (DevTools console is clean)
- The `#rp-warnings-row` element exists in the DOM but is hidden (no warnings yet)
- No layout regression on the right pane

If you cannot smoke-test from your environment, note as a concern; the controller will smoke-test at FINAL.

- [ ] **Step D3: Commit W2**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add public/index.html public/css/style.css public/js/app.js
git commit -m "$(cat <<'EOF'
feat(2.8.22): W2 — soft-warnings UI surface

Adds a new "Warnings" row to the right pane, between the existing
Parked row and Passover. Mirrors the parkedProfiles UI pattern from
2.8.20-B1.

Changes:
- public/index.html: new #rp-warnings-row block with click handler
- public/css/style.css: new .rp-warnings-line / .rp-warnings-detail
  styles (monochrome, no new colors)
- public/js/app.js: _prettyWarningKind / renderSoftWarnings /
  toggleWarningDetail helpers; renderSoftWarnings(s.softWarnings)
  wired into pollStatus alongside renderParkedProfiles(s.parked)

Row hides when softWarnings is empty. When non-empty, shows most-recent
summary + "+N more" count. Click to expand detail list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task W3: NDJSON persistence

**Files:**
- Modify: `src/campaign.js` (constant + `appendWarningLog` helper + call from `pushSoftWarning`)
- Modify: `server.js` (new `GET /api/warnings` endpoint)
- Modify: `public/js/app.js` (new `loadPersistedWarnings` + startup IIFE call + merge in `renderSoftWarnings`)

### Step group A — Backend persistence

- [ ] **Step A1: Locate existing NDJSON pattern (`appendErrorLog` and `STATE_FILE`)**

Run:
```bash
grep -nE "STATE_FILE|ERROR_LOG_FILE|DATA_DIR|appendFile" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -15
```

Note the exact constant naming convention and how `DATA_DIR` is defined / imported. The new `WARNINGS_LOG_FILE` constant must follow the same pattern.

- [ ] **Step A2: Add `WARNINGS_LOG_FILE` constant**

Edit `src/campaign.js`. Find the line where `ERROR_LOG_FILE` (or equivalent) is defined. Add a new line directly after:

For example, if the existing line is:
```javascript
const ERROR_LOG_FILE = resolve(DATA_DIR, 'errors-log.ndjson');
```
add:
```javascript
const WARNINGS_LOG_FILE = resolve(DATA_DIR, 'warnings-log.ndjson');
```

(Use whatever the existing path-resolution pattern is. If there's no `ERROR_LOG_FILE` constant — i.e. the path is inlined — add `WARNINGS_LOG_FILE` near `STATE_FILE` instead.)

- [ ] **Step A3: Add `appendWarningLog` helper**

Edit `src/campaign.js`. Find the `appendErrorLog` function definition (around line 265 — the one located in W1 Step A1). Add the following IMMEDIATELY AFTER its closing brace:

```javascript

/**
 * Append a soft-warning entry to the NDJSON log, fire-and-forget.
 * Async (not sync — soft warnings are advisory, no need for crash-safe
 * sync write like server.js's appendFatalErrorSync).
 *
 * @param {Object} entry - { profileId, pName, kind, message, detectedAt }
 */
async function appendWarningLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(WARNINGS_LOG_FILE, line);
  } catch (err) {
    // Non-fatal — log to console, don't throw
    console.warn('[appendWarningLog]', err.message);
  }
}
```

NOTE: `appendFile` should already be imported at the top of `src/campaign.js` (used by `appendErrorLog`). Verify with:
```bash
grep -n "appendFile" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -3
```
If not, add `appendFile` to the existing `import { ... } from 'node:fs/promises';` line.

- [ ] **Step A4: Call `appendWarningLog` from `pushSoftWarning`**

Edit `src/campaign.js`. Find the `pushSoftWarning` function (added in W1 Step A3). Find the line:
```javascript
  return entry;
}
```
(at the end of `pushSoftWarning`). Replace with:
```javascript
  appendWarningLog(entry).catch(() => {}); // fire-and-forget, errors logged in helper
  return entry;
}
```

### Step group B — API endpoint

- [ ] **Step B1: Locate the `/api/errors` endpoint**

Run:
```bash
grep -nA 15 "app.get\\('/api/errors'" /Users/antoniovarlese/ortus-gologin-clone/server.js
```

Expected: an endpoint block starting around line 1064. Read the full handler — the new `/api/warnings` endpoint mirrors its shape.

- [ ] **Step B2: Add `GET /api/warnings` endpoint**

Edit `/Users/antoniovarlese/ortus-gologin-clone/server.js`. Find the `app.get('/api/errors', ...)` block. Add the following IMMEDIATELY AFTER its closing `});`:

```javascript

app.get('/api/warnings', async (_req, res) => {
  try {
    const path = resolve(DATA_DIR, 'warnings-log.ndjson');
    const buf = await readFile(path, 'utf-8').catch(() => '');
    const lines = buf.split('\n').filter(Boolean);
    const warnings = lines
      .slice(-200)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
```

NOTE: `readFile` and `resolve` and `DATA_DIR` should already be imported / defined in `server.js` (used by `/api/errors`). Verify with:
```bash
grep -nE "readFile|DATA_DIR" /Users/antoniovarlese/ortus-gologin-clone/server.js | head -5
```

If `DATA_DIR` is named differently in `server.js` (e.g. inlined), match the pattern used by `/api/errors`.

### Step group C — Frontend merge

- [ ] **Step C1: Add `loadPersistedWarnings` function**

Edit `/Users/antoniovarlese/ortus-gologin-clone/public/js/app.js`. Find the `loadPersistedErrors` function (around line 3896 — located in W2 Step C1). Add the following IMMEDIATELY AFTER its closing brace:

```javascript

let _persistedWarnings = [];
async function loadPersistedWarnings() {
  try {
    const r = await fetch('/api/warnings');
    if (!r.ok) return;
    const { warnings } = await r.json();
    _persistedWarnings = Array.isArray(warnings) ? warnings : [];
    // Re-render to merge in persisted entries on first load
    if (typeof renderSoftWarnings === 'function') {
      // Use empty array — pollStatus will provide the fresh runtime state
      // shortly. This call just makes sure persisted entries appear immediately.
      renderSoftWarnings(_persistedWarnings);
    }
  } catch {}
}
window.loadPersistedWarnings = loadPersistedWarnings;
```

- [ ] **Step C2: Modify `renderSoftWarnings` to merge runtime + persisted**

Edit `app.js`. Find the `renderSoftWarnings` function (added in W2 Step C2). Change the line:
```javascript
  const list = Array.isArray(warnings) ? warnings : [];
```
to:
```javascript
  const runtime = Array.isArray(warnings) ? warnings : [];
  const persisted = Array.isArray(_persistedWarnings) ? _persistedWarnings : [];
  // Merge by (profileId, kind, detectedAt) — runtime takes precedence on overlap
  const seen = new Set(runtime.map(w => `${w.profileId}|${w.kind}|${w.detectedAt}`));
  const merged = runtime.concat(persisted.filter(w => !seen.has(`${w.profileId}|${w.kind}|${w.detectedAt}`)));
  const list = merged;
```

- [ ] **Step C3: Call `loadPersistedWarnings()` on startup**

Edit `app.js`. Find the line `loadPersistedErrors();` (around line 3076 — located in W2 Step C1). Replace:

Find:
```javascript
loadPersistedErrors();
```
Replace with:
```javascript
loadPersistedErrors();
loadPersistedWarnings();
```

### Step group D — Verify + commit

- [ ] **Step D1: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120 (no new tests in W3).

- [ ] **Step D2: Smoke test the new endpoint**

```bash
curl -s http://localhost:3000/api/warnings
```

Expected: `{"warnings":[]}` (file doesn't exist yet, handler returns empty).

If the dev server isn't running on port 3000, restart it first.

- [ ] **Step D3: Commit W3**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js server.js public/js/app.js
git commit -m "$(cat <<'EOF'
feat(2.8.22): W3 — NDJSON persistence + /api/warnings + merge

Adds append-only persistence so soft warnings survive app restart
and operators can review what fired overnight.

Changes:
- src/campaign.js: WARNINGS_LOG_FILE constant; appendWarningLog
  async helper (fire-and-forget, logs errors to console);
  pushSoftWarning calls appendWarningLog after non-deduped push
- server.js: GET /api/warnings returns last 200 entries from
  data/warnings-log.ndjson (mirrors /api/errors shape)
- public/js/app.js: _persistedWarnings module variable;
  loadPersistedWarnings() on startup; renderSoftWarnings merges
  runtime + persisted by (profileId, kind, detectedAt) so duplicate
  entries don't double-count when both sources have the same key

NDJSON file is created on first warning, append-only afterwards.
Operator can rotate manually if it grows large.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task FINAL: Version bump + verification

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1: Bump version 2.8.21 → 2.8.22**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```
  "version": "2.8.21",
```
Replace with:
```
  "version": "2.8.22",
```

- [ ] **Step 2: Confirm no other 2.8.21 references need updating**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.21" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero source-code matches. CLAUDE.md history line ("2.8.21 — code health & hygiene (lens C)") is INTENTIONAL and stays.

- [ ] **Step 3: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Pass count = 120.

- [ ] **Step 4: Manual UI smoke test (controller does this)**

The dev server is running on port 3000. The controller will:
1. Open `http://localhost:3000` in a browser, log in, load the dashboard
2. Confirm right pane renders cleanly (no JS errors in DevTools)
3. Confirm `#rp-warnings-row` exists in DOM, hidden when no warnings
4. Trigger a known warning by running a campaign that hits a weekly limit OR by manually `curl -X POST` to inject a warning (controller's choice)
5. Confirm warning appears in row + persists in `data/warnings-log.ndjson`

If the implementer can't do this from their environment, that's fine — controller handles it.

- [ ] **Step 5: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
chore(2.8.22): bump version after soft-warnings patch (W1-W3)

Lens D — throughput / rate-limit safety (operator visibility):
- W1: softWarnings state + pushSoftWarning helper called at
      existing detection consumption sites in campaign.js
- W2: new right-pane Warnings row mirroring parked pattern
- W3: NDJSON persistence + GET /api/warnings + frontend merge

No new detection logic, no automatic reaction to warnings, no touches
to off-limits src/linkedin/* files. Aggregates only what is already
detected by the existing layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm branch state ready for merge**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git log --oneline main..HEAD
git status --short
```

Expected:
- 4 commits on this branch ahead of main (W1, W2, W3, FINAL)
- `git status --short` is clean (no modifications, no untracked)

The controller will offer the merge command (`git checkout main && git merge throughput-2.8.22`) to the user.

---

## Notes for the executor

- **Each task is one subagent dispatch.** Sub-step groups (A, B, C, D, E within W1) are inside the same dispatch.
- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`. If a task seems to require touching these, STOP and report.
- **W1 Step B4 may yield "no observable site"** — that's a valid outcome (modal flags consumed inside off-limits files). Report it; only sites #1 and #2 wired up. Lens still ships.
- **Branch never gets force-pushed.** All commits are additive history.
- **Dev server is already running on port 3000** per the controller's environment. Use it for endpoint smoke tests.
