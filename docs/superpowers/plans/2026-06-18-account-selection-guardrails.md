# Account-Selection Guardrails (#5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Warn (never block) when the operator selects an account assigned to / in use by another operator, or starts a campaign whose channel is in passover — via per-card ribbons, an aggregate alert bar, and a "Before you start…" confirm with override.

**Architecture:** A new pure module (`public/js/account-guardrails.mjs`) does all classification; `app.js` renders the ribbon (per card), the passover-closed banner tint, the aggregate alert, and the Start confirm from it. CSS matches `public/sketches/guardrails-final.html` exactly.

**Tech Stack:** vanilla JS ESM (no bundler), `node --test`. Spec: `docs/superpowers/specs/2026-06-18-account-selection-guardrails-design.md`. Visual contract: `public/sketches/guardrails-final.html`.

---

## CRITICAL CONSTRAINTS
- Off-limits: `src/linkedin/outreach.js`, `src/linkedin/actions.js` — never touch.
- **Warn, never block** except Restricted (which stays hard-blocked, unchanged). Do not change the Restricted block, duplicate-hide, presets, or filters.
- **Zero invented data** — every flag/label/count from real SoO. CC "in use" shows no reserver name (no field).
- Real command-deck CSS only; new rules go in `style.css` using app tokens, matching the sketch.
- NEVER `git add -A` — stage only the files each task names. NEVER stage `data/monitoring-campaign.json` / bump `package.json` mid-task (version bump + relaunch at the end).
- Frontend pure helper pattern: `public/js/account-guardrails.mjs`, imported by app.js via `/js/account-guardrails.mjs` and by tests via `../public/js/account-guardrails.mjs`.

## File structure
| File | Responsibility | Action |
|---|---|---|
| `public/js/account-guardrails.mjs` | Pure classifier: `classifyAccountFlag`, `mapModeToChannel`, `passoverWarning`, `summarizeSelection`. | Create |
| `tests/account-guardrails.test.js` | Unit tests for the above. | Create |
| `public/css/style.css` | `.is-flagged` ribbon, restricted ribbon, `.passover-closed`, `.guardrail-alert`, `.guardrail-confirm` — per the sketch. | Modify |
| `public/index.html` | `#guardrail-alert` host above `#profiles-grid`. | Modify |
| `public/js/app.js` | Per-card ribbon in `renderProfiles`; `passover-closed` in `renderPassoverBanner`; `renderGuardrailAlert`; Start-confirm gate. | Modify |

---

## Task 1: `classifyAccountFlag` (pure)

**Files:** Create `public/js/account-guardrails.mjs`, `tests/account-guardrails.test.js`.

- [ ] **Step 1: failing test** — create `tests/account-guardrails.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountFlag } from '../public/js/account-guardrails.mjs';

test('assigned to another operator → flagged', () => {
  const r = classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A' }, 'antonio');
  assert.equal(r.flagged, true); assert.equal(r.reason, 'assigned');
  assert.equal(r.label, 'assigned to Marigona');
});
test('assigned to me → not flagged (substring match)', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Antonio Varlese', section: 'Team A' }, 'antonio').flagged, false);
});
test('pool account is never "assigned"', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Marigona', section: 'Unassigned Pool' }, 'antonio').flagged, false);
});
test('in use by another (with reserver) → flagged with name', () => {
  const r = classifyAccountFlag({ section: 'pool', salesNavCredits: 'In Use', salesNavUser: 'marco@x.com' }, 'antonio');
  assert.equal(r.reason, 'in-use'); assert.equal(r.label, 'in use by marco@x.com');
});
test('CC in use (no reserver field) → flagged, no name', () => {
  const r = classifyAccountFlag({ section: 'pool', ccCredits: 'In Use' }, 'antonio');
  assert.equal(r.reason, 'in-use'); assert.equal(r.label, 'in use');
});
test('in use by me → not flagged', () => {
  assert.equal(classifyAccountFlag({ section: 'pool', linkedinCredits: 'In Use', linkedinUser: 'antonio@x.com' }, 'antonio').flagged, false);
});
test('me empty → not flagged', () => {
  assert.equal(classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A' }, '').flagged, false);
});
test('assigned wins over in-use for the label', () => {
  const r = classifyAccountFlag({ Assignee: 'Marigona', section: 'Team A', ccCredits: 'In Use' }, 'antonio');
  assert.equal(r.reason, 'assigned');
});
```

- [ ] **Step 2:** `node --test tests/account-guardrails.test.js` → FAIL (module missing).
- [ ] **Step 3: implement** — create `public/js/account-guardrails.mjs`:

```js
// Pure helpers for account-selection guardrails (#5). No DOM, no I/O.
// Flags accounts assigned to / in use by another operator; computes the mode-aware
// passover warning. Consumed by public/js/app.js and by tests. Zero invented data.

function norm(s) { return String(s || '').trim().toLowerCase(); }

const IN_USE = 'in use';
// [creditField, reserverField|null] — ccCredits has NO reserver field in the SoO.
const CREDIT_FIELDS = [
  ['linkedinCredits', 'linkedinUser'],
  ['inmailCredits', 'inmailUser'],
  ['salesNavCredits', 'salesNavUser'],
  ['ccCredits', null],
];

/**
 * Classify one account at selection time. `me` = operator identifier (lowercased upstream).
 * Returns { flagged, reason: 'assigned'|'in-use'|null, label }.
 */
export function classifyAccountFlag(soo, me) {
  if (!soo || !me) return { flagged: false, reason: null, label: '' };
  const meN = norm(me);
  const section = norm(soo.section);
  const isPool = section.includes('pool') || section.includes('unassigned');

  // assigned to another operator (Assignee match is substring, mirrors the picker preset)
  const assignee = String(soo.Assignee || soo.assignee || '').trim();
  if (!isPool && assignee && assignee !== '-' && !norm(assignee).includes(meN)) {
    return { flagged: true, reason: 'assigned', label: 'assigned to ' + assignee };
  }

  // in use by another operator (or unknown reserver, e.g. CC)
  for (const [creditKey, userKey] of CREDIT_FIELDS) {
    if (norm(soo[creditKey]) === IN_USE) {
      const reserver = userKey ? String(soo[userKey] || '').trim() : '';
      if (!reserver) return { flagged: true, reason: 'in-use', label: 'in use' };
      if (!norm(reserver).includes(meN)) return { flagged: true, reason: 'in-use', label: 'in use by ' + reserver };
    }
  }
  return { flagged: false, reason: null, label: '' };
}
```

- [ ] **Step 4:** `node --test tests/account-guardrails.test.js` → PASS (8/8).
- [ ] **Step 5: commit**

```bash
git add public/js/account-guardrails.mjs tests/account-guardrails.test.js
git commit -m "feat: classifyAccountFlag — flag accounts assigned to/in use by others (#5)"
```

---

## Task 2: `mapModeToChannel` + `passoverWarning` + `summarizeSelection` (pure)

**Files:** Modify `public/js/account-guardrails.mjs`, `tests/account-guardrails.test.js`.

- [ ] **Step 1: failing tests** (append):

```js
import { mapModeToChannel, passoverWarning, summarizeSelection } from '../public/js/account-guardrails.mjs';

const PO = { monthly: { active: true, label: 'ACTIVE — closes in 12d' }, cc: { active: false, label: 'in 3d' } };

test('mapModeToChannel', () => {
  assert.equal(mapModeToChannel('connect_only'), 'cc');
  assert.equal(mapModeToChannel('connect_and_introduce'), 'cc');
  assert.equal(mapModeToChannel('open_profile_only'), 'monthly');
  assert.equal(mapModeToChannel('inmail_only'), 'monthly');
  assert.equal(mapModeToChannel('check_status'), null);
});
test('passoverWarning: CC closed for a connect campaign', () => {
  const w = passoverWarning('connect_only', PO);
  assert.equal(w.channel, 'cc'); assert.equal(w.label, 'in 3d');
});
test('passoverWarning: monthly active → no warning', () => {
  assert.equal(passoverWarning('open_profile_only', PO), null);
});
test('passoverWarning: mode with no channel → null', () => {
  assert.equal(passoverWarning('check_status', PO), null);
});
test('summarizeSelection: counts flagged + passover, hasWarnings', () => {
  const sel = [
    { email: 'a@x', soo: { Assignee: 'Marigona', section: 'Team A' } },
    { email: 'b@x', soo: { Assignee: 'Antonio', section: 'Team A' } },
  ];
  const s = summarizeSelection(sel, 'antonio', 'connect_only', PO);
  assert.equal(s.flagged.length, 1);
  assert.equal(s.flagged[0].email, 'a@x');
  assert.equal(s.passover.channel, 'cc');
  assert.equal(s.hasWarnings, true);
});
test('summarizeSelection: nothing flagged + active channel → no warnings', () => {
  const s = summarizeSelection([{ email: 'b@x', soo: { Assignee: 'Antonio', section: 'Team A' } }], 'antonio', 'open_profile_only', PO);
  assert.equal(s.hasWarnings, false);
});
```

- [ ] **Step 2:** run → new tests FAIL (functions missing).
- [ ] **Step 3: implement** (append to `account-guardrails.mjs`):

```js
const CC_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message']);
const MONTHLY_MODES = new Set(['open_profile_only', 'inmail_only']);

/** Which credit channel a campaign mode consumes (drives the passover warning). */
export function mapModeToChannel(mode) {
  if (CC_MODES.has(mode)) return 'cc';
  if (MONTHLY_MODES.has(mode)) return 'monthly';
  return null; // message_only / check_status / introduce_back consume no credits
}

/** Mode-aware passover warning. passover = getPassoverStatus() → { monthly, cc }. */
export function passoverWarning(mode, passover) {
  const channel = mapModeToChannel(mode);
  if (!channel || !passover) return null;
  const info = passover[channel];
  if (!info || info.active) return null;
  return { channel, label: info.label };
}

/** Aggregate the currently-selected accounts. selectedSooList = [{ email, soo }]. */
export function summarizeSelection(selectedSooList, me, mode, passover) {
  const flagged = [];
  for (const entry of (selectedSooList || [])) {
    const f = classifyAccountFlag(entry.soo, me);
    if (f.flagged) flagged.push({ email: entry.email, label: f.label });
  }
  const pw = passoverWarning(mode, passover);
  return { flagged, passover: pw, hasWarnings: flagged.length > 0 || !!pw };
}
```

- [ ] **Step 4:** run → all pass.
- [ ] **Step 5: commit**

```bash
git add public/js/account-guardrails.mjs tests/account-guardrails.test.js
git commit -m "feat: mode→channel + passover warning + selection summary (#5)"
```

---

## Task 3: CSS — ribbons, alert, confirm, passover-closed

**Files:** Modify `public/css/style.css`.

- [ ] **Step 1:** Append the rules below (copied from `public/sketches/guardrails-final.html`'s `<style>`, which is the visual contract — verify token names against `:root`/`body.theme-light`):

```css
/* v2.112: #5 account-selection guardrails (warn + override) */
.profile-item.is-flagged { position: relative; padding-top: 28px; border-color: rgba(217,119,6,0.55); overflow: hidden; }
.profile-item.is-flagged::before { content: attr(data-warn); position: absolute; top: 0; left: 0; right: 0; background: #d97706; color: #fff; font-family: var(--mono); font-size: 0.54rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 9px; }
.profile-item.is-restricted { position: relative; padding-top: 28px; overflow: hidden; }
.profile-item.is-restricted::before { content: "⛔ Restricted — blocked"; position: absolute; top: 0; left: 0; right: 0; background: #c0392b; color: #fff; font-family: var(--mono); font-size: 0.54rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 9px; }
.passover-banner strong.passover-closed { color: #d97706; }
.guardrail-alert { display: flex; align-items: flex-start; gap: 11px; background: #fdf2e2; border: 1px solid #d97706; border-left-width: 4px; border-radius: 8px; padding: 12px 14px; margin: 12px 0; }
.guardrail-alert.hidden { display: none; }
.guardrail-alert .big { font-size: 1.25rem; line-height: 1; }
.guardrail-alert .txt { font-size: 0.85rem; color: #7c2d12; line-height: 1.5; }
.guardrail-alert .txt b { color: #9a3412; }
.guardrail-confirm { max-width: 560px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px 22px; }
.guardrail-confirm h3 { margin: 0 0 6px; }
.gc-label { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gray); margin-top: 14px; }
.gc-line { font-size: 0.85rem; line-height: 1.7; color: var(--ink); }
.gc-line .muted { color: var(--gray); }
.gc-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
```

NOTE: the existing `.profile-item.is-restricted` may already have styles (opacity etc.); ADD the ribbon `::before` + `position/padding-top/overflow` without removing existing restricted rules. If `.is-restricted` already sets `position`, keep it.

- [ ] **Step 2:** `node --test` (suite unaffected; sanity). Commit:

```bash
git add public/css/style.css
git commit -m "style: guardrail ribbons, alert, confirm, passover-closed (#5)"
```

---

## Task 4: per-card ribbon + passover-closed banner (app.js)

**Files:** Modify `public/js/app.js` (`renderProfiles` ~919; `renderPassoverBanner` ~825).

- [ ] **Step 1:** At the top of `app.js` add the import:

```js
import { classifyAccountFlag, summarizeSelection } from '/js/account-guardrails.mjs';
```
(Match the existing `/js/*.mjs` import style; if app.js isn't a module, confirm — it loads as `<script type="module">`, so static import is fine.)

- [ ] **Step 2:** In `renderProfiles`, after `const restricted = isRestrictedStatus(sooStatus);`, add:

```js
    const flag = restricted ? { flagged: false } : classifyAccountFlag(soo, getMyIdentifier());
```

In the `item.className` assignment, add `is-flagged` when flagged:

```js
    item.className = 'profile-item'
      + (selectedProfileIds.includes(p.id) ? ' selected' : '')
      + (restricted ? ' is-restricted' : '')
      + (flag.flagged ? ' is-flagged' : '');
    if (flag.flagged) item.dataset.warn = '⚠ ' + flag.label;
```

(The CSS `::before` reads `data-warn`. Restricted uses its fixed ribbon — no data-warn. A flagged card stays selectable; do NOT disable it.)

- [ ] **Step 3:** In `renderPassoverBanner`, change `fmt` so a CLOSED channel gets the `passover-closed` class (today inactive shows in plain ink). Current `fmt`:

```js
  const fmt = (info) => {
    const cls = info.active ? ' class="passover-active"' : '';
    return `<strong${cls}>Passover ${info.label}</strong>`;
  };
```
→
```js
  const fmt = (info) => {
    const cls = info.active ? ' class="passover-active"' : ' class="passover-closed"';
    return `<strong${cls}>Passover ${info.label}</strong>`;
  };
```

- [ ] **Step 4:** `node --check public/js/app.js` clean; `node --test` green. Manual: flagged cards show the amber ribbon, restricted the red one, CC closed shows amber in the banner. Commit:

```bash
git add public/js/app.js
git commit -m "feat: per-card guardrail ribbon + passover-closed banner tint (#5)"
```

---

## Task 5: aggregate alert bar (index.html + app.js)

**Files:** Modify `public/index.html` (above `#profiles-grid` ~1173), `public/js/app.js`.

- [ ] **Step 1:** In `index.html`, immediately BEFORE `<div id="profiles-loading">` (line ~1172), add:

```html
          <div id="guardrail-alert" class="guardrail-alert hidden"></div>
```

- [ ] **Step 2:** In `app.js`, add `renderGuardrailAlert()` (near `renderSelectedPanel`):

```js
// v2.112 (#5): aggregate guardrail alert — built ONLY from the currently-selected accounts.
function renderGuardrailAlert() {
  const el = document.getElementById('guardrail-alert');
  if (!el) return;
  const me = getMyIdentifier();
  const mode = currentMode();                 // existing helper that returns the chosen mode
  const passover = getPassoverStatus();
  const selected = (selectedProfileIds || []).map(id => {
    const name = selectedProfileNames[id] || id;
    return { email: name, soo: findSoOForProfile(name) };
  });
  const s = summarizeSelection(selected, me, mode, passover);
  if (!s.hasWarnings) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const bits = [];
  if (s.flagged.length) bits.push(`<b>${s.flagged.length} of your selected accounts are assigned to / in use by others</b>`);
  if (s.passover) bits.push(`this campaign's <b>${s.passover.channel === 'cc' ? 'CC' : 'monthly'} credits are in passover (${escHtml(s.passover.label)})</b>`);
  el.innerHTML = `<span class="big">⚠</span><span class="txt">${bits.join(', and ')}.</span>`;
  el.classList.remove('hidden');
}
```
(Use the REAL mode-getter the wizard uses — find how the Start handler reads the mode, e.g. a `currentMode()` / a radio value; replace `currentMode()` accordingly. `escHtml` exists. `findSoOForProfile` exists.)

- [ ] **Step 3:** Call `renderGuardrailAlert()` wherever selection or mode changes: at the end of `renderSelectedPanel()` and `updateCampaignSummary()`, and in the mode-change handler. (These already fire on checkbox toggle via `renderProfiles`' change listener.)

- [ ] **Step 4:** `node --check` + `node --test` green. Manual: select a flagged account → amber bar appears summarizing it; deselect all flagged + active channel → bar hides. Commit:

```bash
git add public/index.html public/js/app.js
git commit -m "feat: aggregate guardrail alert bar above the grid (#5)"
```

---

## Task 6: Start-confirm gate (app.js)

**Files:** Modify `public/js/app.js` (the Start handler ~3571; index.html if a static confirm host is preferred).

- [ ] **Step 1:** Find the Start handler's early validation (`if (!_autoRoutedModes.has(...) && selectedProfileIds.length === 0) { alert(...); return; }`, ~3571). Immediately AFTER that check, add a guardrail gate that shows the "Before you start…" confirm when there are warnings and the operator hasn't already confirmed this attempt:

```js
    // v2.112 (#5): warn (don't block) on assigned/in-use selected accounts + passover.
    if (!_guardrailConfirmed) {
      const me = getMyIdentifier();
      const selected = selectedProfileIds.map(id => {
        const name = selectedProfileNames[id] || id;
        return { email: name, soo: findSoOForProfile(name) };
      });
      const s = summarizeSelection(selected, me, currentMode(), getPassoverStatus());
      if (s.hasWarnings) { showGuardrailConfirm(s); return; }  // wait for Start anyway / Back
    }
    _guardrailConfirmed = false; // reset for next launch
```

- [ ] **Step 2:** Add `let _guardrailConfirmed = false;` near the top-level state, and `showGuardrailConfirm(s)` which renders the `.guardrail-confirm` panel (markup matching `public/sketches/guardrails-final.html`) into a host element (reuse a modal/overlay pattern the app already has, or a `#guardrail-confirm-host` div added to index.html near the launch controls). Its **Start anyway** button sets `_guardrailConfirmed = true` and re-invokes the Start handler; **Back to selection** hides the panel and aborts. Build the panel body from `s.flagged` (list each `email — label`) and `s.passover` (the mode-aware line), all escaped, no invented data.

```js
function showGuardrailConfirm(s) {
  const host = document.getElementById('guardrail-confirm-host'); // add to index.html
  if (!host) return;
  const flaggedLines = s.flagged.map(f => `<div class="gc-line">⚠ ${escHtml(f.email)} — <span class="muted">${escHtml(f.label)}</span></div>`).join('');
  const passoverLine = s.passover
    ? `<div class="gc-label">Passover</div><div class="gc-line">This campaign's <span style="color:#d97706">${s.passover.channel === 'cc' ? 'CC' : 'monthly'} credits are in passover</span> (${escHtml(s.passover.label)}).</div>`
    : '';
  host.innerHTML = `<div class="guardrail-confirm">
    <h3>Before you start…</h3>
    ${s.flagged.length ? `<div class="gc-label">Assigned / in use by others — ${s.flagged.length} selected</div>${flaggedLines}` : ''}
    ${passoverLine}
    <div class="gc-actions">
      <button type="button" class="btn btn-secondary btn-sm" id="gc-back">Back to selection</button>
      <button type="button" class="btn btn-start btn-sm" id="gc-go">Start anyway</button>
    </div>
  </div>`;
  host.classList.remove('hidden');
  document.getElementById('gc-back').onclick = () => { host.classList.add('hidden'); host.innerHTML = ''; };
  document.getElementById('gc-go').onclick = () => { host.classList.add('hidden'); host.innerHTML = ''; _guardrailConfirmed = true; startCampaign(); }; // call the real Start entrypoint
}
```
(Replace `startCampaign()` with the actual Start handler/function name. If the app has an existing overlay/modal helper, use it instead of a bare host div — match the app's pattern.)

- [ ] **Step 3:** Add `<div id="guardrail-confirm-host" class="hidden"></div>` to `index.html` near the launch controls.

- [ ] **Step 4:** `node --check` + `node --test` green. Manual end-to-end: select a flagged account, press Start → confirm panel lists it + (if applicable) passover → **Start anyway** launches; **Back** returns. No warnings → starts immediately (unchanged). Commit:

```bash
git add public/js/app.js public/index.html
git commit -m "feat: 'Before you start' guardrail confirm with override (#5)"
```

---

## Final verification (before finishing the branch)
- [ ] `npm test` green (incl. new `account-guardrails` tests).
- [ ] `git status` — `data/monitoring-campaign.json` NOT staged.
- [ ] Off-limits unchanged: `git log --oneline -- src/linkedin/outreach.js src/linkedin/actions.js` (no new commits).
- [ ] Bump `package.json` patch version; relaunch `dev:app`; manual end-to-end matching `public/sketches/guardrails-final.html`.
- [ ] superpowers:finishing-a-development-branch.
