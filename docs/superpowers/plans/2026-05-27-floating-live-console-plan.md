# Floating Live Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed-position pill at the bottom-left of every non-dashboard route that surfaces live campaign status, expanding into a HUD card on click with a "Go to dashboard ›" link.

**Architecture:** Pure-helper module (`public/js/live-console.mjs`) holds the state-matrix → pill-config mapping and the visibility predicate, both unit-tested with `node --test`. DOM glue lives in `public/js/app.js`: a `renderLiveConsole(s)` function is hooked into the existing `pollStatus()` flow (no new poll loop), and a hashchange listener gates visibility. A single root `.live-console` element appended to `<body>` swaps between collapsed pill and expanded card via a class.

**Tech Stack:** Vanilla JS (ES modules), CSS custom properties in `public/css/style.css`, `node --test` for unit tests. No new dependencies. Reads existing `/api/campaign/status` payload.

---

## Spec Reference

This plan implements `docs/superpowers/specs/2026-05-27-floating-live-console-design.md`. Re-read the spec before starting — especially the **state matrix** (§ State Matrix) and the **layout descriptions** (§ Components 2 and 3).

## File Structure

- **Create:** `public/js/live-console.mjs` — pure helpers (`computePillState`, `shouldShowConsole`)
- **Create:** `tests/live-console.test.js` — `node --test` unit tests for the helpers
- **Modify:** `public/index.html` — add 1 root `<div id="live-console">` element before `</body>`
- **Modify:** `public/css/style.css` — append `.live-console` styling block
- **Modify:** `public/js/app.js` — import helpers, add `renderLiveConsole(s)`, hook into `pollStatus()`, add click + hashchange + localStorage wiring

**Pattern reference:** This mirrors the existing `public/js/tour.mjs` + `app.js` integration (pure helpers in a `.mjs`, imported into `app.js`, DOM glue in `app.js`). See `app.js:15-25` for the tour import pattern.

## Off-Limits

Do not modify `src/linkedin/outreach.js` or `src/linkedin/actions.js` (per `CLAUDE.md`).

## Branch + Commit Discipline

- Create a feature branch off the current working branch before Task 1: `git checkout -b live-console-v1`.
- Commit after each task's tests pass (or after each task's manual verification for non-test tasks).
- After every commit that touches runtime code, **relaunch dev:app** per the operator rule in `CLAUDE.md`:
  ```bash
  pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
  npm run dev:app > /tmp/dev-app.log 2>&1 &
  ```

---

## Task 1: Scaffold the pure-helper module + test file

**Files:**
- Create: `public/js/live-console.mjs`
- Create: `tests/live-console.test.js`

- [ ] **Step 1: Create empty module with header comment**

Write `public/js/live-console.mjs`:

```js
// Floating live console — pure helpers.
// Imported by public/js/app.js for DOM glue and by tests/live-console.test.js
// for unit verification. Keep this module DOM-free: no document/window access.

export function computePillState(_status) {
  throw new Error('not implemented');
}

export function shouldShowConsole(_args) {
  throw new Error('not implemented');
}
```

- [ ] **Step 2: Create empty test file with one smoke test**

Write `tests/live-console.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePillState, shouldShowConsole } from '../public/js/live-console.mjs';

test('module exports both helpers', () => {
  assert.equal(typeof computePillState, 'function');
  assert.equal(typeof shouldShowConsole, 'function');
});
```

- [ ] **Step 3: Run the smoke test to confirm wiring**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
node --test tests/live-console.test.js
```

Expected: PASS (1 passing — both exports exist as functions).

- [ ] **Step 4: Commit**

```bash
git add public/js/live-console.mjs tests/live-console.test.js
git commit -m "feat(live-console): scaffold pure-helper module + test file"
```

---

## Task 2: Implement `computePillState` (state matrix)

**Files:**
- Modify: `public/js/live-console.mjs`
- Modify: `tests/live-console.test.js`

**Helper contract:** Takes a `/api/campaign/status` payload `s`. Returns `{dot, pulse, label, mode, name, processed, total, lead, account, action, state, logs, errSegment, parkedSegment, throttleReason}`.

**Precedence (highest first):** `paused > throttle > parked > errors > healthy`. Dot color depends on highest-precedence flag.

- [ ] **Step 1: Write failing tests for the 6 state matrix rows + 1 fallback**

Append to `tests/live-console.test.js`:

```js
// ── computePillState ────────────────────────────────────────────────────
const baseStatus = {
  running: true, paused: false, state: 'sending',
  name: 'Sam', mode: 'connect_and_introduce',
  currentProfile: 'Marlon',
  currentAction: { label: 'Sending intro DM', lead: 'Priya Sharma' },
  processedToday: 47, totalTargets: 280,
  errors: [], parked: [], logs: [], throttle: null,
};

test('computePillState: healthy running → green pulse, no segments', () => {
  const r = computePillState(baseStatus);
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.errSegment, null);
  assert.equal(r.parkedSegment, null);
  assert.equal(r.label, 'Sam · CC+IC');
  assert.equal(r.processed, 47);
  assert.equal(r.total, 280);
});

test('computePillState: throttle.active → amber, no pulse, surfaces reason', () => {
  const r = computePillState({ ...baseStatus, throttle: { active: true, reason: 'cpu-high', multiplier: 0.6 } });
  assert.equal(r.dot, 'amber');
  assert.equal(r.pulse, false);
  assert.equal(r.throttleReason, 'cpu-high');
});

test('computePillState: errors.length > 0 → green pulse + err segment', () => {
  const r = computePillState({ ...baseStatus, errors: [{ message: 'a' }, { message: 'b' }] });
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.errSegment, '· 2 err');
});

test('computePillState: parked.length > 0 → amber + parked segment', () => {
  const r = computePillState({ ...baseStatus, parked: [{ profileId: 'x' }] });
  assert.equal(r.dot, 'amber');
  assert.equal(r.pulse, false);
  assert.equal(r.parkedSegment, '· 1 parked');
});

test('computePillState: paused → gray, no pulse, label flips to paused', () => {
  const r = computePillState({ ...baseStatus, paused: true });
  assert.equal(r.dot, 'gray');
  assert.equal(r.pulse, false);
  assert.equal(r.label, 'Sam · paused');
});

test('computePillState: state=monitoring → green pulse, monitoring label', () => {
  const r = computePillState({ ...baseStatus, state: 'monitoring' });
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.label, 'Sam · monitoring');
});

test('computePillState: missing fields → graceful fallback', () => {
  const r = computePillState({ running: true });
  assert.equal(r.dot, 'gray');
  assert.equal(r.name, '—');
  assert.equal(r.processed, 0);
  assert.equal(r.total, 0);
});

test('computePillState: precedence — paused beats throttle', () => {
  const r = computePillState({ ...baseStatus, paused: true, throttle: { active: true, reason: 'x' } });
  assert.equal(r.dot, 'gray');
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/live-console.test.js
```

Expected: FAIL (8 failing — `computePillState` throws "not implemented").

- [ ] **Step 3: Implement `computePillState`**

Replace the stub in `public/js/live-console.mjs`:

```js
const MODE_LABELS = {
  connect_only: 'CC',
  connect_and_introduce: 'CC+IC',
  message_only: 'DM',
  inmail_only: 'IM',
  open_profile_only: 'OP-DM',
  check_status: 'CHK',
  check_dms: 'DMS',
  post_amplification: 'AMP',
};

export function computePillState(s) {
  if (!s || typeof s !== 'object') {
    return _emptyState();
  }

  const name = (s.name || '').trim() || '—';
  const modeShort = MODE_LABELS[s.mode] || (s.mode || '').toUpperCase() || '—';
  const errCount = Array.isArray(s.errors) ? s.errors.length : 0;
  const parkedCount = Array.isArray(s.parked) ? s.parked.length : 0;
  const throttleActive = !!(s.throttle && s.throttle.active);
  const isPaused = !!s.paused;
  const isMonitoring = s.state === 'monitoring';

  // Precedence: paused > throttle > parked > errors > healthy.
  let dot = 'gray';
  let pulse = false;
  let labelSuffix = modeShort;

  if (isPaused) {
    dot = 'gray';
    pulse = false;
    labelSuffix = 'paused';
  } else if (throttleActive) {
    dot = 'amber';
    pulse = false;
  } else if (parkedCount > 0) {
    dot = 'amber';
    pulse = false;
  } else if (s.running || isMonitoring) {
    dot = 'green';
    pulse = true;
    if (isMonitoring) labelSuffix = 'monitoring';
  }

  return {
    dot,
    pulse,
    label: `${name} · ${labelSuffix}`,
    name,
    mode: modeShort,
    processed: Number(s.processedToday) || 0,
    total: Number(s.totalTargets) || 0,
    lead: (s.currentAction && s.currentAction.lead) || '—',
    account: s.currentProfile || '—',
    action: (s.currentAction && s.currentAction.label) || '—',
    state: s.state || 'idle',
    logs: Array.isArray(s.logs) ? s.logs.slice(-3) : [],
    errSegment: errCount > 0 ? `· ${errCount} err` : null,
    parkedSegment: parkedCount > 0 ? `· ${parkedCount} parked` : null,
    throttleReason: throttleActive ? (s.throttle.reason || null) : null,
  };
}

function _emptyState() {
  return {
    dot: 'gray', pulse: false, label: '—', name: '—', mode: '—',
    processed: 0, total: 0, lead: '—', account: '—', action: '—',
    state: 'idle', logs: [],
    errSegment: null, parkedSegment: null, throttleReason: null,
  };
}

export function shouldShowConsole(_args) {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/live-console.test.js
```

Expected: PASS (9 passing total: 1 smoke + 8 computePillState).

- [ ] **Step 5: Commit**

```bash
git add public/js/live-console.mjs tests/live-console.test.js
git commit -m "feat(live-console): implement computePillState state matrix"
```

---

## Task 3: Implement `shouldShowConsole` (visibility predicate)

**Files:**
- Modify: `public/js/live-console.mjs`
- Modify: `tests/live-console.test.js`

**Helper contract:** Takes `{running, hash}`. Returns `true` only when the campaign is running AND the operator is NOT on the dashboard route.

- [ ] **Step 1: Append failing tests**

Append to `tests/live-console.test.js`:

```js
// ── shouldShowConsole ────────────────────────────────────────────────────
test('shouldShowConsole: hidden when no campaign running', () => {
  assert.equal(shouldShowConsole({ running: false, hash: '#/new' }), false);
});

test('shouldShowConsole: hidden on dashboard hash (#/) even when running', () => {
  assert.equal(shouldShowConsole({ running: true, hash: '#/' }), false);
});

test('shouldShowConsole: hidden on empty hash (treated as dashboard)', () => {
  assert.equal(shouldShowConsole({ running: true, hash: '' }), false);
});

test('shouldShowConsole: visible when running and off dashboard', () => {
  assert.equal(shouldShowConsole({ running: true, hash: '#/new' }), true);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/live-console.test.js
```

Expected: FAIL (4 new failures — `shouldShowConsole` throws "not implemented").

- [ ] **Step 3: Replace `shouldShowConsole` stub**

In `public/js/live-console.mjs`, replace the `shouldShowConsole` export:

```js
export function shouldShowConsole({ running, hash }) {
  if (!running) return false;
  const onDashboard = hash === '#/' || hash === '' || hash == null;
  return !onDashboard;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/live-console.test.js
```

Expected: PASS (13 passing total).

- [ ] **Step 5: Commit**

```bash
git add public/js/live-console.mjs tests/live-console.test.js
git commit -m "feat(live-console): implement shouldShowConsole visibility predicate"
```

---

## Task 4: Add the root HTML element to `public/index.html`

**Files:**
- Modify: `public/index.html` (insert just before `<div id="tour-overlay">` near line 1683)

- [ ] **Step 1: Locate the insertion point**

Open `public/index.html` and find the comment `<!-- Onboarding tour overlay.` (around line 1683 — right before the existing `<div id="tour-overlay" class="tour-overlay hidden" …>`).

- [ ] **Step 2: Insert the live-console markup directly above that comment**

Insert this block just above the `<!-- Onboarding tour overlay.` comment:

```html
<!-- Floating live console. Hidden by default. Visibility + content driven by
     renderLiveConsole(s) in public/js/app.js, which uses pure helpers from
     /js/live-console.mjs. Hidden when no campaign is running OR when the
     operator is on the dashboard route (#/). -->
<div id="live-console" class="live-console is-collapsed" hidden>
  <!-- Pill (collapsed) -->
  <button type="button" class="live-console__pill" data-lc="pill" title="Open live console">
    <span class="live-console__dot" data-lc="dot"></span>
    <span class="live-console__label" data-lc="label">—</span>
    <span class="live-console__sep" aria-hidden="true"></span>
    <span class="live-console__count" data-lc="count">— / —</span>
    <span class="live-console__seg live-console__seg--err" data-lc="err" hidden></span>
    <span class="live-console__seg live-console__seg--parked" data-lc="parked" hidden></span>
    <span class="live-console__chev" aria-hidden="true">›</span>
  </button>

  <!-- Card (expanded) -->
  <div class="live-console__card" data-lc="card">
    <div class="live-console__head">
      <span class="live-console__dot" data-lc="dot-card"></span>
      <span class="live-console__title" data-lc="title">—</span>
      <span class="live-console__mode" data-lc="mode">—</span>
      <button type="button" class="live-console__ctl" data-lc="collapse" title="Collapse">−</button>
    </div>
    <div class="live-console__body">
      <div class="live-console__row"><span class="live-console__k">Account</span><span class="live-console__v" data-lc="account">—</span></div>
      <div class="live-console__row"><span class="live-console__k">Lead</span>   <span class="live-console__v" data-lc="lead">—</span></div>
      <div class="live-console__row"><span class="live-console__k">Action</span> <span class="live-console__v" data-lc="action">—</span></div>
      <div class="live-console__row"><span class="live-console__k">Sent</span>   <span class="live-console__v" data-lc="sent">— / —</span></div>
      <div class="live-console__divider"></div>
      <div class="live-console__log" data-lc="log"></div>
    </div>
    <div class="live-console__foot">
      <span class="live-console__state" data-lc="state">state · —</span>
      <a href="#/" class="live-console__dashboard-link" data-lc="dash">Go to dashboard ›</a>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Reload dev:app and verify the element is present but invisible**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Then in the Electron app: Cmd+Opt+I → Console → `document.getElementById('live-console')` should return the element (not null). The `hidden` attribute keeps it invisible — that's correct.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(live-console): add #live-console root element"
```

---

## Task 5: Add `.live-console` CSS (pill + card)

**Files:**
- Modify: `public/css/style.css` (append at end of file)

- [ ] **Step 1: Find end of `style.css`**

```bash
wc -l /Users/antoniovarlese/ortus-gologin-clone/public/css/style.css
```

Note the line count — you'll append after the final line.

- [ ] **Step 2: Append the live-console block**

Add this at the very end of `public/css/style.css`:

```css
/* ─────────────────────────────────────────────────────────────────────────
   Floating live console (2026-05-27)
   Pill bottom-left + expand-in-place HUD card. Visibility/state driven by
   renderLiveConsole(s) in app.js. Tokens already defined at top of file.
   ───────────────────────────────────────────────────────────────────────── */

.live-console {
  position: fixed;
  bottom: 18px;
  left: 18px;
  z-index: 60;
  font-family: var(--body);
}
.live-console[hidden] { display: none !important; }

/* ── Pill (collapsed) ─────────────────────────────────────────────────── */
.live-console__pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px 9px 12px;
  background: rgba(19, 19, 19, 0.92);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: 9999px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s;
}
.live-console__pill:hover { border-color: var(--gold); }

.live-console__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: var(--gray);
  flex-shrink: 0;
}
.live-console__dot[data-color="green"]  { background: var(--green); }
.live-console__dot[data-color="amber"]  { background: #d29922; }
.live-console__dot[data-color="gray"]   { background: var(--gray); }
.live-console__dot[data-pulse="1"][data-color="green"] {
  box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.55);
  animation: live-console-pulse 1.6s infinite;
}
@keyframes live-console-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.55); }
  70%  { box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); }
  100% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0); }
}

.live-console__label {
  font-size: 0.72rem;
  letter-spacing: 0.02em;
  color: var(--gray);
}
.live-console__sep {
  width: 1px;
  height: 14px;
  background: var(--hairline);
}
.live-console__count {
  font-family: var(--mono);
  font-size: 0.74rem;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.live-console__seg {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.live-console__seg--err     { color: var(--red); }
.live-console__seg--parked  { color: #d29922; }
.live-console__seg[hidden]  { display: none; }
.live-console__chev {
  color: var(--gray);
  font-size: 0.78rem;
  margin-left: 2px;
}

/* ── Card (expanded) ──────────────────────────────────────────────────── */
.live-console__card {
  display: none;
  width: 360px;
  background: rgba(19, 19, 19, 0.96);
  border: 1px solid var(--gold);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.live-console.is-expanded .live-console__pill { display: none; }
.live-console.is-expanded .live-console__card { display: block; }

.live-console__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline-soft);
}
.live-console__title {
  font-family: var(--display);
  font-size: 1rem;
  letter-spacing: 0.04em;
  color: var(--ink);
}
.live-console__mode {
  font-size: 0.55rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--gold);
  margin-left: 2px;
}
.live-console__ctl {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border-radius: 9999px;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--gray);
  font-size: 0.85rem;
  line-height: 1;
  cursor: pointer;
}
.live-console__ctl:hover { color: var(--ink); border-color: var(--ink); }

.live-console__body { padding: 12px; }
.live-console__row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  padding: 4px 0;
  font-size: 0.78rem;
}
.live-console__k {
  font-size: 0.55rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--gray);
  align-self: center;
}
.live-console__v {
  font-family: var(--mono);
  font-size: 0.76rem;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-console__divider {
  height: 1px;
  background: var(--hairline-soft);
  margin: 8px 0;
}
.live-console__log {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--gray);
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--hairline-soft);
  border-radius: 3px;
  padding: 8px 10px;
  line-height: 1.55;
  max-height: 72px;
  overflow: hidden;
}
.live-console__log-line {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.live-console__log-line.is-latest { color: var(--ink); }

.live-console__foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--hairline-soft);
  font-size: 0.6rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--gray);
}
.live-console__dashboard-link {
  color: var(--gold);
  text-decoration: none;
}
.live-console__dashboard-link:hover { text-decoration: underline; }
```

- [ ] **Step 3: Reload dev:app and visually verify**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In the Electron app, open DevTools Console and run:

```js
const el = document.getElementById('live-console');
el.hidden = false;
el.classList.remove('is-collapsed');
el.classList.add('is-collapsed');
```

Expected: the pill appears at the bottom-left of the viewport. Then toggle expanded:

```js
el.classList.remove('is-collapsed');
el.classList.add('is-expanded');
```

Expected: the card appears, anchored bottom-left, gold-bordered.

Hide it again before leaving:

```js
el.hidden = true;
```

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "feat(live-console): add pill + card styling"
```

---

## Task 6: Wire `renderLiveConsole(s)` into `pollStatus()` (read-only render)

**Files:**
- Modify: `public/js/app.js`

This task wires the helpers to the DOM. Click handlers and persistence come in Task 7.

- [ ] **Step 1: Add import for the pure helpers**

Edit `public/js/app.js`. Find the existing `import { … } from '/js/tour.mjs';` block (around line 15-25). Immediately after the closing `}` of that import, add:

```js
import { computePillState, shouldShowConsole } from '/js/live-console.mjs';
```

- [ ] **Step 2: Add module-level state at the top of `app.js`**

Find the line `let selectedProfileIds = [];` (around line 27). Immediately above it, add:

```js
// Floating live console — state used by renderLiveConsole(). The previous
// running flag is needed to detect the running → idle transition that
// resets the expanded-state localStorage flag (see Task 7).
let _lcPrevRunning = false;
let _lcWriteCache = {};
```

- [ ] **Step 3: Define `renderLiveConsole(s)` at the end of `app.js`**

Append this block at the very end of `public/js/app.js`:

```js
// ─────────────────────────────────────────────────────────────────────────
// Floating live console — DOM glue. Pure helpers live in /js/live-console.mjs.
// Hooked into pollStatus() so it shares the existing 2s poll cadence.
// ─────────────────────────────────────────────────────────────────────────
function renderLiveConsole(s) {
  const root = document.getElementById('live-console');
  if (!root) return;

  const running = !!(s && s.running);
  const visible = shouldShowConsole({ running, hash: location.hash || '' });

  if (!visible) {
    root.hidden = true;
    _lcPrevRunning = running;
    return;
  }
  root.hidden = false;

  const pill = computePillState(s);

  // Helper: only write text if it changed, to avoid layout thrash.
  const setText = (sel, value) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const cached = _lcWriteCache[sel];
    if (cached === value) return;
    el.textContent = value;
    _lcWriteCache[sel] = value;
  };
  const setAttr = (sel, attr, value) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const key = `${sel}@${attr}`;
    if (_lcWriteCache[key] === value) return;
    if (value == null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
    _lcWriteCache[key] = value;
  };
  const setHidden = (sel, hide) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const key = `${sel}@hidden`;
    const v = hide ? '1' : '0';
    if (_lcWriteCache[key] === v) return;
    if (hide) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
    _lcWriteCache[key] = v;
  };

  // Pill content
  setAttr('[data-lc="dot"]', 'data-color', pill.dot);
  setAttr('[data-lc="dot"]', 'data-pulse', pill.pulse ? '1' : '0');
  setText('[data-lc="label"]', pill.label);
  setText('[data-lc="count"]', `${pill.processed} / ${pill.total}`);

  if (pill.errSegment) {
    setText('[data-lc="err"]', pill.errSegment);
    setHidden('[data-lc="err"]', false);
  } else {
    setHidden('[data-lc="err"]', true);
  }
  if (pill.parkedSegment) {
    setText('[data-lc="parked"]', pill.parkedSegment);
    setHidden('[data-lc="parked"]', false);
  } else {
    setHidden('[data-lc="parked"]', true);
  }

  // Card content
  setAttr('[data-lc="dot-card"]', 'data-color', pill.dot);
  setAttr('[data-lc="dot-card"]', 'data-pulse', pill.pulse ? '1' : '0');
  setText('[data-lc="title"]', pill.name.toUpperCase());
  setText('[data-lc="mode"]', pill.mode);
  setText('[data-lc="account"]', pill.account);
  setText('[data-lc="lead"]', pill.lead);
  setText('[data-lc="action"]', pill.action);
  const sentStr = `${pill.processed} / ${pill.total}` +
    (pill.errSegment ? ` ${pill.errSegment}` : '');
  setText('[data-lc="sent"]', sentStr);
  setText('[data-lc="state"]', `state · ${pill.state}`);

  // Log tail (3 lines)
  const logEl = root.querySelector('[data-lc="log"]');
  if (logEl) {
    const lines = pill.logs;
    const sig = lines.join('|');
    if (_lcWriteCache['__log_sig'] !== sig) {
      logEl.innerHTML = '';
      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'live-console__log-line' + (i === lines.length - 1 ? ' is-latest' : '');
        span.textContent = line;
        logEl.appendChild(span);
      });
      _lcWriteCache['__log_sig'] = sig;
    }
  }

  _lcPrevRunning = running;
}
```

- [ ] **Step 4: Hook `renderLiveConsole(s)` into `pollStatus()`**

Find the end of the `try` block in `pollStatus()` in `app.js`. The function starts around line 4273. The `try` block runs the main fetch + render flow. Look for the lines that render the log panel and account queue (the section around `renderAccountQueue(...)` and the `if (s.logs?.length > 0)` block — roughly lines 4420-4440).

Just before the closing `} catch` of `pollStatus`, add one line:

```js
    // Floating live console — runs on every poll tick. Idempotent; only
    // writes DOM when values change (see _lcWriteCache).
    try { renderLiveConsole(s); } catch (err) { console.warn('[live-console] render failed:', err.message); }
```

To find the right line, search for the pattern `} catch` inside the `pollStatus` function. The first `} catch (err)` after line 4273 is the end of the main try block.

- [ ] **Step 5: Reload dev:app and verify with a running campaign**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In Electron: start a Connect-only test campaign (smallest, fastest mode) with 1–2 leads. Once it's running, click any sidebar nav item to leave the dashboard. The pill should appear at bottom-left showing the campaign name and counter. Navigate back to the dashboard (`#/`) — pill should hide.

Note: clicking the pill won't do anything yet — that's Task 7.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "feat(live-console): wire renderLiveConsole into pollStatus"
```

---

## Task 7: Add click + hashchange + localStorage wiring

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Define the persistence + interaction helpers**

Append this block at the very end of `public/js/app.js` (after the `renderLiveConsole` function from Task 6):

```js
// ── Live console: persistence + interaction ──────────────────────────────
const LC_LS_KEY = 'liveConsole.expanded';

function _lcReadExpanded() {
  try { return localStorage.getItem(LC_LS_KEY) === '1'; }
  catch { return false; }
}
function _lcWriteExpanded(expanded) {
  try { localStorage.setItem(LC_LS_KEY, expanded ? '1' : '0'); } catch { /* */ }
}
function _lcClearExpanded() {
  try { localStorage.removeItem(LC_LS_KEY); } catch { /* */ }
}

function _lcApplyState(expanded) {
  const root = document.getElementById('live-console');
  if (!root) return;
  root.classList.toggle('is-expanded', expanded);
  root.classList.toggle('is-collapsed', !expanded);
}

function _lcExpand()   { _lcApplyState(true);  _lcWriteExpanded(true);  }
function _lcCollapse() { _lcApplyState(false); _lcWriteExpanded(false); }

function _lcInit() {
  const root = document.getElementById('live-console');
  if (!root) return;

  // Restore expand state from localStorage on init.
  _lcApplyState(_lcReadExpanded());

  // Click pill → expand. Click collapse button → collapse.
  // Click dashboard link → goDashboard() (defined elsewhere in app.js).
  const pillBtn = root.querySelector('[data-lc="pill"]');
  if (pillBtn) pillBtn.addEventListener('click', _lcExpand);

  const collapseBtn = root.querySelector('[data-lc="collapse"]');
  if (collapseBtn) collapseBtn.addEventListener('click', _lcCollapse);

  const dashLink = root.querySelector('[data-lc="dash"]');
  if (dashLink) dashLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (typeof goDashboard === 'function') goDashboard();
    else window.location.hash = '#/';
  });

  // Re-evaluate visibility when the route changes.
  window.addEventListener('hashchange', () => {
    if (typeof pollStatus === 'function') {
      // pollStatus() will call renderLiveConsole at the end; no-op safety net
      // here is to also recompute visibility from cached state immediately.
      // We don't have direct access to the last `s` here, so toggle hidden
      // based on the predicate using `_lcPrevRunning` as a best-effort flag.
    }
    const root2 = document.getElementById('live-console');
    if (!root2) return;
    if (!shouldShowConsole({ running: _lcPrevRunning, hash: location.hash || '' })) {
      root2.hidden = true;
    } else {
      root2.hidden = false;
    }
  });
}

// Initialize once DOM is ready. Matches the existing init pattern at the
// top of pollStatus() flow — DOMContentLoaded has already fired by the time
// app.js's module script runs in modern Electron, but guard anyway.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _lcInit);
} else {
  _lcInit();
}
```

- [ ] **Step 2: Add the running→idle reset to `renderLiveConsole`**

In the existing `renderLiveConsole` function (from Task 6), find the line `_lcPrevRunning = running;` at the very end of the function. Just **before** that line, add the transition-detection block:

```js
  // Detect running → idle transition: clear localStorage so the next campaign
  // starts collapsed regardless of how the last one was left.
  if (_lcPrevRunning && !running) {
    _lcClearExpanded();
    _lcApplyState(false);
  }
```

The function tail should now read:

```js
  // Detect running → idle transition…
  if (_lcPrevRunning && !running) {
    _lcClearExpanded();
    _lcApplyState(false);
  }

  _lcPrevRunning = running;
}
```

- [ ] **Step 3: Reload dev:app and run the full manual verification**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In the Electron app, with a running campaign:

1. Navigate to a non-dashboard section (e.g. `#/new`). Pill appears at bottom-left.
2. Click pill → expands to card with Account/Lead/Action/Sent + log lines.
3. Click `−` in card header → collapses back to pill.
4. Click pill → expands again. Reload (Cmd+R). After reload, console is still expanded (localStorage).
5. Click "Go to dashboard ›" — hash changes to `#/`, console hides (dashboard rule).
6. Click any nav item back to a non-dashboard section — console reappears collapsed (because localStorage held `1`, then we re-applied it). NOTE: if it's still expanded, that's also correct.
7. Stop the campaign (`/api/campaign/stop`) — within ~2s, console disappears entirely. Refreshing the page: console stays hidden (no campaign running). localStorage has been cleared.
8. Start a new campaign — console reappears, collapsed (the running→idle clear from the previous stop).

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(live-console): click/hashchange/localStorage wiring"
```

---

## Task 8: Final verification + full test suite run

**Files:**
- None modified.

- [ ] **Step 1: Run the full test suite to confirm no regressions**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
node --test tests/*.test.js 2>&1 | tail -30
```

Expected: all existing tests still pass + 13 new tests from `tests/live-console.test.js` pass. Note the total passing count for the commit message.

- [ ] **Step 2: Visual cross-check on every route**

In dev:app with a running campaign, visit each route and confirm the pill behaves correctly:

| Route | Pill visible? |
|---|---|
| `#/` (dashboard) | NO |
| `#/new` (wizard) | YES |
| Settings sub-section (still `#/new`) | YES |

If any route surfaces unexpected behavior (pill stuck on dashboard, pill missing where expected), revert to Task 7 and inspect `shouldShowConsole` + the hashchange listener.

- [ ] **Step 3: Verify off-limits files were not touched**

```bash
git log --name-only origin/main..HEAD -- src/linkedin/outreach.js src/linkedin/actions.js
```

Expected: no output. If anything shows, abort and undo — those files are off-limits per `CLAUDE.md`.

- [ ] **Step 4: Final commit (notes only — no code)**

If there's nothing left to commit, skip. Otherwise commit any leftover state.

---

## Acceptance Criteria

- [ ] All 13 unit tests in `tests/live-console.test.js` pass.
- [ ] Full repo test suite still passes (no regressions).
- [ ] Pill appears at bottom-left on every route except `#/` when a campaign is running.
- [ ] Clicking the pill expands it into a card with Account / Lead / Action / Sent rows + 3 log lines.
- [ ] Clicking the `−` button collapses it back to pill.
- [ ] Clicking "Go to dashboard ›" navigates to `#/` and the console hides.
- [ ] State persists across reloads via `localStorage.liveConsole.expanded`.
- [ ] `localStorage.liveConsole.expanded` is cleared on the running → idle transition.
- [ ] State matrix is correctly observed:
  - healthy → green pulse
  - throttle → amber dot, no pulse
  - errors > 0 → `· N err` segment
  - parked > 0 → amber dot + `· N parked` segment
  - paused → gray dot, label flips to "paused"
  - monitoring → green pulse, label flips to "monitoring"
- [ ] No changes to `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- [ ] No new dependencies in `package.json`.

---

## Out of Scope (per spec)

- Drag-to-reposition the card
- Multiple-campaign support
- Push notifications / sound alerts
- Sticky pill on the dashboard itself
- Slide-in / slide-out animations
- Mobile / small-screen layout
