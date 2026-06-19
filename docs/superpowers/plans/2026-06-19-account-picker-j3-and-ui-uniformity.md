# Account Picker (J3) + Dropdown Uniformity + URL-Column Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Spec: `docs/superpowers/specs/2026-06-19-account-picker-j3-and-ui-uniformity-design.md`.
> Sketches: `public/sketches/2026-06-19-account-picker-j3-states-v2.html` (J3),
> `public/sketches/2026-06-19-account-picker-grid-variants.html` (C + D).

**Goal:** Clean campaign-aware J3 account tiles (replacing the misfiring orange ribbon),
uniform boxed dropdowns, and a tab-picker-style LinkedIn URL column picker with auto-detect ✓
and a non-URL guard. Frontend-only.

**Hard constraints (every task):** do NOT touch `src/linkedin/outreach.js` or
`src/linkedin/actions.js`, or any server/Apps Script file. Never `git add -A`/`.`; stage only
named files; never stage `data/`. Pure helpers get `node --test`; render/CSS manual-verify.
Commits `feat:`-prefixed, ending `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Pure helper — `classifyAccountState` + CC reserver fallback (TDD)

**Files:** Modify `public/js/account-guardrails.mjs`; create `tests/account-state.test.js`;
modify `public/js/app.js` (move `isRestrictedStatus` import).

- [ ] **Step 1 — move `isRestrictedStatus` into the mjs.** Cut the `isRestrictedStatus`
  function from `app.js` (~716–719) and add to `account-guardrails.mjs` as
  `export function isRestrictedStatus(status){ const s=String(status||'').toLowerCase().trim(); return /restricted/.test(s) || s==='inaccessible'; }`.
  Add `isRestrictedStatus` to the existing import in `app.js:31`
  (`import { classifyAccountFlag, summarizeSelection, classifyAccountState, isRestrictedStatus } from '/js/account-guardrails.mjs';`).

- [ ] **Step 2 — CC reserver fallback.** In `classifyAccountFlag`'s `CREDIT_FIELDS`, change
  the `ccCredits` reserver from `null` to `'linkedinUser'` (operator: CC holder = LinkedIn OP
  User). Keep all other behavior.

- [ ] **Step 3 — failing tests** in `tests/account-state.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountState } from '../public/js/account-guardrails.mjs';

const PASS = { cc: { active: false, label: 'in 2d' }, monthly: { active: false, label: 'in 4d' } };
const PASS_ACTIVE = { cc: { active: true, label: 'closes in 3d' }, monthly: { active: true, label: 'closes in 10d' } };

test('blocked wins over everything', () => {
  const s = classifyAccountState({ Status: 'Identity Restricted', Assignee: 'Cathy', linkedinCredits: 'In Use' }, 'me', 'connect_only', PASS);
  assert.equal(s.state, 'blocked');
});

test('in use by someone else → in-use + who', () => {
  const s = classifyAccountState({ linkedinCredits: 'In Use', linkedinUser: 'Cathy' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'in-use');
  assert.equal(s.who, 'Cathy');
});

test('CC in use falls back to linkedinUser for who', () => {
  const s = classifyAccountState({ ccCredits: 'In Use', linkedinUser: 'Cathy' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'in-use');
  assert.equal(s.who, 'Cathy');
});

test('in use by me → free (not flagged)', () => {
  const s = classifyAccountState({ linkedinCredits: 'In Use', linkedinUser: 'alecx' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('assigned to other + channel resting → assigned (blue) with frees label', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'assigned');
  assert.equal(s.who, 'Cathy');
  assert.equal(s.frees, 'in 2d');
});

test('assigned to other + channel ACTIVE (after passover) → free', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'connect_only', PASS_ACTIVE);
  assert.equal(s.state, 'free');
});

test('open_profile_only uses the monthly schedule', () => {
  const resting = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'open_profile_only', PASS);
  assert.equal(resting.state, 'assigned');
  assert.equal(resting.frees, 'in 4d');
  const active = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'open_profile_only', PASS_ACTIVE);
  assert.equal(active.state, 'free');
});

test('assigned to me → free', () => {
  const s = classifyAccountState({ Assignee: 'alecx', section: 'Team A' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('pool section → free even if Assignee set', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Pool Accounts Unassigned' }, 'alecx', 'connect_only', PASS);
  assert.equal(s.state, 'free');
});

test('null-channel mode (message_only): assigned-to-other stays assigned, no frees', () => {
  const s = classifyAccountState({ Assignee: 'Cathy', section: 'Team A' }, 'alecx', 'message_only', PASS);
  assert.equal(s.state, 'assigned');
  assert.equal(s.frees, '');
});

test('missing soo / missing me → free', () => {
  assert.equal(classifyAccountState(null, 'me', 'connect_only', PASS).state, 'free');
  assert.equal(classifyAccountState({ Assignee: 'Cathy' }, '', 'connect_only', PASS).state, 'free');
});
```

- [ ] **Step 4 — run, expect FAIL.** `node --test tests/account-state.test.js`
- [ ] **Step 5 — implement** `export function classifyAccountState(soo, me, mode, passover)` in
  `account-guardrails.mjs`, per spec priority order (blocked → in-use(other) → assigned(gated by
  passover) → free). Reuse `norm`, `classifyAccountFlag`, `mapModeToChannel`, `isRestrictedStatus`.
  Returns `{ state, who: '', frees: '' }`. For assigned: `channel = mapModeToChannel(mode)`;
  if `channel && passover?.[channel] && passover[channel].active === false` →
  `{state:'assigned', who:assignee, frees: passover[channel].label}`; if `channel && active` → free;
  if `channel === null` → `{state:'assigned', who:assignee, frees:''}`. Derive in-use via the
  same CREDIT_FIELDS loop (now with cc→linkedinUser); in-use only when reserver ≠ me.
- [ ] **Step 6 — run, expect PASS** + full suite green (`node --test tests/*.test.js`). Commit
  (`git add public/js/account-guardrails.mjs public/js/app.js tests/account-state.test.js`).

---

### Task 2: J3 tile render + CSS (HIGHER RISK — touches `renderProfiles`)

**Files:** `public/js/app.js` (renderProfiles card template ~1024–1047), `public/css/style.css`.
Manual-verify. Use the most capable model. Preserve all selection/checkbox behavior.

READ first: `renderProfiles` (~942–1090), `renderSoOBadges` (~780–811), the J3 tile markup +
CSS in `public/sketches/2026-06-19-account-picker-j3-states-v2.html`, and the existing
`.profile-grid`/`.profile-item` rules.

- [ ] **Step 1 — CSS.** Port the J3 tile styles from the v2 sketch into `style.css` under a
  clear banner, scoped so they only affect the new tile (e.g. `.profile-item.j3 { … }` and
  `.j3-status`/`.j3-word`/`.j3-when`/`.j3-detail`/`.j3-verdict` + the `st-*`/`dot-*`/`w-*`
  state classes). Use real tokens (`--green/--blue/--gold/--red`, tints `rgba(...,0.10–0.13)`).
  Keep the grid container `.browse-card .profile-grid` (6-col) — tiles flow in it; widen the
  min if needed so the two-zone tile fits (it can drop to e.g. 3–4 per row).
- [ ] **Step 2 — render.** In `renderProfiles`, after computing `restricted`, call
  `classifyAccountState(soo, getMyIdentifier(), document.getElementById('campaign-mode')?.value || '', getPassoverStatus())`.
  Build the tile: `<label class="profile-item j3 <state> [selected] [is-restricted]">` →
  left `.j3-status st-<state>` (dot + WORD + when/who line from `who`/`frees`) + right
  `.j3-detail` (checkbox + email (+ keep `⚠ dup` / restricted flag) + verdict sentence).
  Map state→word: free=FREE/"Anyone can use"/"Free to use", assigned=ASSIGNED/"`who` · frees `frees`"/
  "Assigned to `who` …", in-use=IN USE/"`who` · right now"/"In use by `who` — pick another",
  blocked=BLOCKED/"Restricted"/"Restricted by LinkedIn — can't use". Restricted keeps
  `disabled` checkbox + dim. **Remove** the `is-flagged`/`data-warn` ribbon, the
  `renderSoOBadges(...)` call, and the `pick-primary` block from this template.
- [ ] **Step 3 — keep behavior:** the checkbox `change` handler, `selectedProfileIds`,
  restricted-blocked selection, dedupe `⚠ dup` flag — all unchanged. `classifyAccountFlag`
  may stay for `summarizeSelection` (selection-summary warnings) — do not remove it.
- [ ] **Step 4 — verify** `node --check public/js/app.js`; full suite green. Manual: reload app,
  confirm tiles render in each state with no console errors. Commit
  (`git add public/js/app.js public/css/style.css`).

---

### Task 3: C — uniform dropdowns

**Files:** `public/index.html`, `public/css/style.css`. Manual-verify.

- [ ] **Step 1.** Change `#primary-timing-select` (586), `#follow-up-delay` (610),
  `#check-cadence-select` (666), `#pe-cadence` (1614) from `class="intro-config-select"` to
  `class="intro-config-select-wide"`. For the two inside inline "Every [select]" wrappers,
  replace the `.intro-config-inline` wrapper with a flex row
  (`display:flex;align-items:center;gap:10px`) where the prefix stays and the select is
  `style="flex:1"` (per the grid-variants "After" column). Keep all `onchange` handlers + ids.
- [ ] **Step 2 — verify** `node --check` not needed (HTML); reload app, confirm all four
  dropdowns are boxed + uniform and still save/restore. Commit
  (`git add public/index.html public/css/style.css`).

---

### Task 4: D — URL column picker (tab-picker style + ✓ + guard)

**Files:** `public/js/app.js` (`previewSheet` ~3430–3443 render of `#linkedin-col-select`),
`public/css/style.css` (reuse `.tabpick`/`.leadblock`). Manual-verify.

READ: the `.tabpick`/`.leadblock` CSS (~2026–2043) and the existing auto-detect scan
(`autoDetectCol`, ~3420–3429) + the `#linkedin-col-select` render.

- [ ] **Step 1 — render.** Replace the `.ic-filled`/`.ic-row` markup for `#linkedin-col-select`
  with a `.tabpick` block: `.tabpick-head` ("Which column holds the LinkedIn profile URL?"),
  the boxed `<select id="linkedin-col-select">` (tabpick select style), and — when
  `autoDetectCol` matched — a green "✓ auto-detected from header / values" line under it.
  Keep the option list + the `autoDetectCol` preselect.
- [ ] **Step 2 — guard.** Add an `onchange` (e.g. `_linkedinColPick()`) that checks the chosen
  column's sample values (from the previewed rows already in scope, or re-read from the rendered
  table) for URL-likeness (`linkedin.com` or `^https?://`); if none look like URLs, show a red
  `.leadblock`-style note ("That doesn't look like a URL column — pick the column whose cells are
  linkedin.com/in/… links"). Non-blocking. Hide it again when a URL-ish column is chosen.
- [ ] **Step 3 — verify** `node --check public/js/app.js`; reload, preview a sheet, confirm the
  picker looks like the tab picker, the ✓ shows on auto-detect, and choosing a non-URL column
  shows the red guard. Commit (`git add public/js/app.js public/css/style.css`).

---

### Task 5: Version bump, suite, relaunch

- [ ] Bump `package.json` patch (→ 2.112.9). `node --test tests/*.test.js` green.
  Relaunch dev:app (`pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; ORTUS_DATA_DIR=… npm run dev:app &`),
  confirm version badge. Commit (`git add package.json`). Ships only via manual reinstall (#15).

---

## Self-review (coverage vs spec)

- State model → Task 1 (helper + tests) + Task 2 (render). Passover gate + CC fallback → Task 1.
- J3 visual (no YOURS) → Task 2. Uniform dropdowns (C) → Task 3. URL picker (D) → Task 4.
- Off-limits files + server/Apps Script untouched (frontend-only) — every task.
- Manual-verify for all UI; pure helper is the only unit-tested unit.
