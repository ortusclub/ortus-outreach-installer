# Shared Primary Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the primary's identity into one `primarySource` selector in the Primary Person config, consumed by both auto-accept and the automated follow-up; retire the follow-up "Sent from" dropdown and the separate `autoAcceptSender`/`followUpSender` fields.

**Architecture:** A single per-campaign field `primarySource` (`'local-browser'` | a `profileId`) replaces both old fields. The GoLogin profile picker (built earlier on this branch inside the auto-accept card) is relocated into the Primary Person card. Auto-accept and follow-up each keep their own on/off toggle and gain a read-only "as your primary — [name]" line. The follow-up's posting identity becomes `tpl.primarySource`; message-token rendering (`personalizeTemplate`/`introData`) is untouched, so `{sender first name}` stays the campaign account and `{primary name}` stays the primary.

**Tech Stack:** Node ≥22, `node --test` (pure-helper unit tests), Express 4, vanilla HTML/CSS/JS, Electron shell for manual UI verification.

**Branch:** continue on `auto-accept-gologin-primary` (evolves the in-progress work; not merged).

**Off-limits (never touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. **No change needed:** `src/primary-tasks.js`, `src/primary-task-runner.js`, `src/linkedin/accept-invitation.js`, `src/linkedin/thread-message.js`.

**Spec:** `docs/superpowers/specs/2026-06-12-shared-primary-source-design.md`
**Sketch:** `public/sketches/primary-source-shared.html`

**Naming decisions (consistent across all tasks):**
- Field: `primarySource` (`'local-browser'` | profileId).
- DOM ids (renamed from `auto-accept-*`): `primary-source` (radio `name`), `primary-source-picker`, `primary-source-search`, `primary-source-grid`, `primary-source-profile-id`. Read-only label ids: `auto-accept-primary-label`, `follow-up-primary-label`.
- JS fns (renamed): `togglePrimarySource`, `renderPrimarySourcePicker`, `filterPrimarySourcePicker`, `readPrimarySource`, plus new `refreshPrimarySourceLabels`.
- CSS classes `.aa-src-*` / `.aa-acct-*` are **kept as-is** (styling hooks only — renaming is pure churn).

---

## File Structure

| File | Change |
|---|---|
| `src/campaign.js` | normalize → `primarySource`; enqueue `sender: tpl.primarySource` + log; history persists `primarySource` |
| `src/linkedin/auto-intro.js` | `maybeBuildFollowUp` line 92 → `sender = tpl.primarySource` (line 91 untouched) |
| `src/post-campaign-bulk-check.js` | `registerSchedule` param/persist/read-back → `primarySource` |
| `public/index.html` | add "Logged in via" to `#primary-person-block`; strip `#auto-accept-source` picker → read-only label; strip `#follow-up-sender` dropdown → read-only label |
| `public/js/app.js` | rename picker helpers to `primary-source`; `readPrimarySource`; `refreshPrimarySourceLabels`; emit `primarySource` in 2 builders; restore; generalized launch guard; simplify `refreshAutoAcceptGate` |
| `public/css/style.css` | add `.uses-primary` read-only line style |
| `tests/normalize-templates-primary.test.js` | assert `primarySource`; drop `followUpSender`/`autoAcceptSender` |
| `tests/register-schedule-followup-fields.test.js` | assert `primarySource` |
| `tests/maybe-build-followup-sender.test.js` | NEW — follow-up task sender = `primarySource`, body still personalized |

---

## Task 1: Backend — `normalizeTemplates` emits `primarySource` (TDD)

**Files:** Modify `src/campaign.js` (`normalizeTemplates`); `tests/normalize-templates-primary.test.js`.

- [ ] **Step 1: Update the test.** Open `tests/normalize-templates-primary.test.js`. Replace its entire contents with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplates } from '../src/campaign.js';

test('normalizeTemplates passes through the new primary-side fields with safe defaults', () => {
  const t = normalizeTemplates({}, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, false);
  assert.equal(t.followUpEnabled, false);
  assert.equal(t.followUpBody, '');
  assert.equal(t.followUpDelayMinutes, 10);
  assert.equal(t.primarySource, 'local-browser');
});

test('normalizeTemplates honors provided primary-side values', () => {
  const t = normalizeTemplates({
    autoAcceptPrimary: true,
    followUpEnabled: true,
    followUpBody: '  Hi {first name}  ',
    followUpDelayMinutes: '25',
    primarySource: 'profile-abc123',
  }, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, true);
  assert.equal(t.followUpEnabled, true);
  assert.equal(t.followUpBody, 'Hi {first name}');
  assert.equal(t.followUpDelayMinutes, 25);
  assert.equal(t.primarySource, 'profile-abc123');
});

test('primarySource falls back to local-browser for empty/unknown', () => {
  assert.equal(normalizeTemplates({ primarySource: '' }, 'connect_and_introduce').primarySource, 'local-browser');
  assert.equal(normalizeTemplates({}, 'connect_and_introduce').primarySource, 'local-browser');
});

test('legacy followUpSender / autoAcceptSender are no longer emitted', () => {
  const t = normalizeTemplates({ followUpSender: 'campaign-account', autoAcceptSender: 'profX' }, 'connect_and_introduce');
  assert.equal(t.followUpSender, undefined);
  assert.equal(t.autoAcceptSender, undefined);
  assert.equal(t.primarySource, 'local-browser');
});
```

- [ ] **Step 2: Run — expect FAIL.** `node --test tests/normalize-templates-primary.test.js` → fails (`primarySource` undefined; old fields still emitted).

- [ ] **Step 3: Implement.** In `src/campaign.js` `normalizeTemplates`, find these lines (the `followUpSender` field and the `autoAcceptSender` IIFE that follows it):

```js
    followUpSender: templates.followUpSender === 'campaign-account' ? 'campaign-account' : 'local-browser',
    // autoAcceptSender — where the primary accepts: 'local-browser' (you) or a
    // GoLogin profileId chosen in the UI. Concrete id, not an enum, so pass it
    // through; anything empty/falsey degrades to local-browser.
    autoAcceptSender: (() => {
      const v = (templates.autoAcceptSender || '').toString().trim();
      return v && v !== 'local-browser' ? v : 'local-browser';
    })(),
```

Replace ALL of that with a single field:

```js
    // primarySource — the primary's ONE identity, used by BOTH auto-accept and
    // the automated follow-up: 'local-browser' (you) or a GoLogin profileId.
    // Concrete id, not an enum, so pass it through; empty/falsey → local-browser.
    primarySource: (() => {
      const v = (templates.primarySource || '').toString().trim();
      return v && v !== 'local-browser' ? v : 'local-browser';
    })(),
```

(Leave `followUpEnabled`, `followUpBody`, `followUpDelayMinutes`, `autoAcceptPrimary`, `primaryName`, `primaryUrl`, `primaryIntroBody` unchanged.)

- [ ] **Step 4: Run — expect PASS.** `node --test tests/normalize-templates-primary.test.js`.

- [ ] **Step 5: Commit.**
```bash
git add src/campaign.js tests/normalize-templates-primary.test.js
git commit -m "refactor(primary-source): normalizeTemplates emits primarySource (retire followUpSender/autoAcceptSender)"
```
(Append: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`)

---

## Task 2: Backend — consumers read `primarySource` (enqueue, follow-up, history)

**Files:** Modify `src/campaign.js` (enqueue + history), `src/linkedin/auto-intro.js`; add `tests/maybe-build-followup-sender.test.js`.

- [ ] **Step 1: Write the failing follow-up test.** Create `tests/maybe-build-followup-sender.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeBuildFollowUp } from '../src/linkedin/auto-intro.js';

const introData = { firstName: 'Lee', senderFirstName: 'Alec', primaryName: 'Sam' };

test('follow-up task posting identity = tpl.primarySource (GoLogin profile)', () => {
  const task = maybeBuildFollowUp({
    tpl: { followUpEnabled: true, followUpBody: 'Hi {first name}', primarySource: 'profileX', followUpDelayMinutes: 10 },
    introData, profileId: 'campaignAcct1', profileName: 'alec@x', sheetUrl: 'u',
    leadName: 'Lee', url: 'https://lnkd/in/lee', threadUrl: 'https://www.linkedin.com/messaging/thread/abc', now: 1000,
  });
  assert.equal(task.sender, 'profileX');
  // body is personalized at build time, independent of posting identity
  assert.equal(task.body, 'Hi Lee');
  // the campaign account that ran the intro is still recorded
  assert.equal(task.campaignProfileId, 'campaignAcct1');
});

test('follow-up posting identity defaults to local-browser when primarySource absent', () => {
  const task = maybeBuildFollowUp({
    tpl: { followUpEnabled: true, followUpBody: 'Hi', followUpDelayMinutes: 10 },
    introData, profileId: 'campaignAcct1', profileName: 'alec@x', sheetUrl: 'u',
    leadName: 'Lee', url: 'u2', threadUrl: 't', now: 1000,
  });
  assert.equal(task.sender, 'local-browser');
});

test('follow-up disabled returns null', () => {
  assert.equal(maybeBuildFollowUp({ tpl: { followUpEnabled: false }, introData, profileId: 'p' }), null);
});
```

Note: `personalizeTemplate` must turn `Hi {first name}` into `Hi Lee` using `introData.firstName`. If the existing `personalizeTemplate` uses a different key than `firstName`, adjust the `introData` in the test to match how the existing code keys it (read `personalizeTemplate` in `src/linkedin/auto-intro.js` to confirm the key names) — the load-bearing assertions are `task.sender` and that `task.body` is the personalized (not raw) string.

- [ ] **Step 2: Run — expect FAIL.** `node --test tests/maybe-build-followup-sender.test.js` → `task.sender` is resolved from `followUpSender` (undefined → 'local-browser'), so the first test fails (`'local-browser' !== 'profileX'`).

- [ ] **Step 3: Implement follow-up sender.** In `src/linkedin/auto-intro.js`, find (line ~92):
```js
  const sender = tpl.followUpSender === 'campaign-account' ? profileId : 'local-browser';
```
Replace with:
```js
  // Posting identity = the primary (a participant in every intro thread). The
  // message body above is already personalized from introData, so token
  // resolution ({sender first name} = campaign account) is unaffected.
  const sender = tpl.primarySource || 'local-browser';
```
**Do NOT change line 91 (`const body = personalizeTemplate(rawBody, introData);`) or anything else in the function.**

- [ ] **Step 4: Implement enqueue + log.** In `src/campaign.js`, in the auto-accept enqueue block, find:
```js
                      sender: tpl.autoAcceptSender,
```
Replace with:
```js
                      sender: tpl.primarySource,
```
Then find the source-aware log just below it:
```js
                      const _where = (tpl.autoAcceptSender && tpl.autoAcceptSender !== 'local-browser')
                        ? 'the chosen GoLogin profile'
                        : 'your local browser';
```
Replace with:
```js
                      const _where = (tpl.primarySource && tpl.primarySource !== 'local-browser')
                        ? 'the primary\'s GoLogin profile'
                        : 'your local browser';
```

- [ ] **Step 5: Implement history persistence.** In `src/campaign.js`, in the history-snapshot block, find these two lines:
```js
            followUpSender: (templates && templates.followUpSender) || 'local-browser',
            autoAcceptSender: (templates && templates.autoAcceptSender) || 'local-browser',
```
Replace BOTH with one:
```js
            primarySource: (templates && templates.primarySource) || 'local-browser',
```

- [ ] **Step 6: Run.** `node --test tests/maybe-build-followup-sender.test.js` → PASS. Then `node --check src/campaign.js` (clean) and `node --test tests/*.test.js` → no failures (the partition/accept tests still pass; they use task-level `sender` which is unchanged).

- [ ] **Step 7: Commit.**
```bash
git add src/campaign.js src/linkedin/auto-intro.js tests/maybe-build-followup-sender.test.js
git commit -m "refactor(primary-source): enqueue + follow-up + history read tpl.primarySource"
```
(Append the Co-Authored-By trailer.)

---

## Task 3: Backend — schedule/post-campaign parity → `primarySource`

**Files:** Modify `src/post-campaign-bulk-check.js`; `tests/register-schedule-followup-fields.test.js`.

- [ ] **Step 1: Update the test.** In `tests/register-schedule-followup-fields.test.js`: in the `registerSchedule({...})` input, remove `followUpSender: 'campaign-account',` and the `autoAcceptSender: 'profile-sched1',` line, and add `primarySource: 'profile-sched1',`. Then replace the assertions `assert.equal(entry.followUpSender, 'campaign-account');` and `assert.equal(entry.autoAcceptSender, 'profile-sched1');` with:
```js
  assert.equal(entry.primarySource, 'profile-sched1');
```
(Keep the other assertions: autoAcceptPrimary, followUpEnabled, followUpBody, followUpDelayMinutes.)

- [ ] **Step 2: Run — expect FAIL.** `node --test tests/register-schedule-followup-fields.test.js`.

- [ ] **Step 3: Param.** In `src/post-campaign-bulk-check.js`, in `registerSchedule`'s destructured params, find the tail:
```js
                                          followUpSender = 'local-browser',
                                          autoAcceptSender = 'local-browser' }) {
```
Replace with:
```js
                                          primarySource = 'local-browser' }) {
```

- [ ] **Step 4: Persist.** Find the entry-object lines:
```js
    followUpSender: followUpSender === 'campaign-account' ? 'campaign-account' : 'local-browser',
    autoAcceptSender: (autoAcceptSender && autoAcceptSender !== 'local-browser') ? autoAcceptSender : 'local-browser',
```
Replace BOTH with:
```js
    primarySource: (primarySource && primarySource !== 'local-browser') ? primarySource : 'local-browser',
```

- [ ] **Step 5: Read-back.** In the `runAutoIntros({ templates: {...} })` call, find:
```js
                followUpSender: entry.followUpSender,
                autoAcceptSender: entry.autoAcceptSender,
```
Replace BOTH with:
```js
                primarySource: entry.primarySource,
```

- [ ] **Step 6: Run.** `node --test tests/register-schedule-followup-fields.test.js` → PASS; `node --check src/post-campaign-bulk-check.js`; `node --test tests/*.test.js` → no failures.

- [ ] **Step 7: Commit.**
```bash
git add src/post-campaign-bulk-check.js tests/register-schedule-followup-fields.test.js
git commit -m "refactor(primary-source): schedule + post-campaign parity uses primarySource"
```
(Append the Co-Authored-By trailer.)

---

## Task 4: CSS — read-only "uses-primary" line

**Files:** Modify `public/css/style.css`.

- [ ] **Step 1: Append the style.** In `public/css/style.css`, immediately after the `.aa-acct-empty{...}` rule (the last rule in the "Auto-accept source cards" block added earlier; locate with `grep -n "\.aa-acct-empty" public/css/style.css`), insert:

```css
/* v2.94.x — read-only "acts as your primary — [name]" line on the auto-accept + follow-up cards */
.uses-primary{display:flex;align-items:center;gap:8px;margin:8px 0 0;padding:9px 11px;border:1px solid var(--hairline);border-radius:10px;background:var(--hairline-soft);font-size:.82rem;color:var(--ink);}
.uses-primary .dot{width:7px;height:7px;border-radius:9999px;background:var(--green);flex-shrink:0;}
.uses-primary .nm{font-weight:600;}
.uses-primary .edit{margin-left:auto;font-family:var(--mono);font-size:.55rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gray);border:1px solid var(--hairline);border-radius:9999px;padding:5px 10px;white-space:nowrap;}
```

- [ ] **Step 2: Brace check.** `node -e "const c=require('fs').readFileSync('public/css/style.css','utf8'); const o=(c.match(/\{/g)||[]).length, cl=(c.match(/\}/g)||[]).length; console.log(o,cl)"` → counts equal.

- [ ] **Step 3: Commit.**
```bash
git add public/css/style.css
git commit -m "style(primary-source): read-only uses-primary line"
```
(Append the Co-Authored-By trailer.)

---

## Task 5: HTML — relocate picker to Primary Person; strip the two old controls

**Files:** Modify `public/index.html`.

- [ ] **Step 1: Add "Logged in via" to `#primary-person-block`.** Find the `#primary-person-block` element. After its LinkedIn-URL field (the `intro-config-field` ending right before the block's closing `</div>` at the `primary-person-url` hint), and BEFORE that closing `</div>`, insert this new field (note: ids renamed from `auto-accept-*` to `primary-source-*`; radio `name="primary-source"`):

```html
            <!-- v2.94.x: the primary's ONE identity — used by both auto-accept and the follow-up below -->
            <div class="intro-config-field">
              <label class="intro-config-label">Logged in via</label>
              <div class="aa-src-cards">
                <div class="aa-src-card">
                  <label class="aa-src-head">
                    <input type="radio" name="primary-source" value="local-browser" checked
                           onchange="togglePrimarySource(); savePrimaryPersonFields();">
                    <span class="aa-src-title">My local browser</span>
                  </label>
                  <div class="aa-src-desc">The primary is logged into LinkedIn in your own Chrome.</div>
                </div>
                <div class="aa-src-card">
                  <label class="aa-src-head">
                    <input type="radio" name="primary-source" value="gologin"
                           onchange="togglePrimarySource(); savePrimaryPersonFields();">
                    <span class="aa-src-title">A GoLogin profile</span>
                  </label>
                  <div class="aa-src-desc">The primary is one of your GoLogin profiles — pick which one.</div>
                  <div id="primary-source-picker" style="display:none;">
                    <input type="text" id="primary-source-search" class="aa-acct-search"
                           placeholder="Search by name or email…" oninput="filterPrimarySourcePicker()">
                    <div id="primary-source-grid" class="aa-acct-grid"></div>
                  </div>
                  <input type="hidden" id="primary-source-profile-id" value="">
                </div>
              </div>
              <div class="intro-config-hint">Used for <b>both</b> primary-side actions below. It must be logged into LinkedIn as the primary.</div>
            </div>
```

- [ ] **Step 2: Strip the auto-accept source picker → read-only label.** In the `#auto-accept-block`, replace the entire `<div id="auto-accept-source" ...> ... </div>` subtree (the block beginning `<!-- v2.94.x: where the primary accepts ... -->` and the `<div id="auto-accept-source" style="display:none;">…</div>`) with this single read-only line:

```html
            <!-- v2.94.x: accepts as the shared primary identity (set in Primary Person) -->
            <div id="auto-accept-primary-line" class="uses-primary" style="display:none;">
              <span class="dot"></span><span>Accepts as your primary — <span class="nm" id="auto-accept-primary-label">your local browser</span></span>
            </div>
```

(Keep the `#auto-accept-toggle`, `#auto-accept-gate`, the eyebrow, and the closing hint exactly as they are.)

- [ ] **Step 3: Strip the follow-up "Sent from" dropdown → read-only label.** In `#follow-up-block`, find the "Sent from" field:
```html
              <div class="intro-config-field">
                <label class="intro-config-label" for="follow-up-sender">Sent from</label>
                <select id="follow-up-sender" class="intro-config-select-wide" onchange="savePrimaryPersonFields()">
                  <option value="local-browser">You (local browser)</option>
                  <option value="campaign-account">The campaign account</option>
                </select>
              </div>
```
Replace it with:
```html
              <div class="uses-primary">
                <span class="dot"></span><span>Sent from your primary — <span class="nm" id="follow-up-primary-label">your local browser</span></span>
              </div>
```

- [ ] **Step 4: Sanity-check ids.** Run:
```bash
for id in primary-source-picker primary-source-search primary-source-grid primary-source-profile-id auto-accept-primary-label follow-up-primary-label auto-accept-primary-line; do printf "%s=" "$id"; grep -c "id=\"$id\"" public/index.html; done
grep -c 'name="primary-source"' public/index.html     # expect 2
grep -c 'id="follow-up-sender"' public/index.html      # expect 0
grep -c 'id="auto-accept-source"' public/index.html    # expect 0
```
Each id count = 1; `name="primary-source"` = 2; `follow-up-sender` = 0; `auto-accept-source` = 0.

- [ ] **Step 5: Commit.**
```bash
git add public/index.html
git commit -m "feat(primary-source): Logged-in-via in Primary Person; auto-accept + follow-up show read-only primary line"
```
(Append the Co-Authored-By trailer.)

---

## Task 6: JS — rename picker to `primary-source`, live labels, emit `primarySource`, restore, guard

**Files:** Modify `public/js/app.js`.

- [ ] **Step 1: Replace the gate + picker helpers.** Locate the block from `function refreshAutoAcceptGate()` through the end of `window.readAutoAcceptSender = readAutoAcceptSender;` (the five functions added earlier: refreshAutoAcceptGate, toggleAutoAcceptSource, renderAutoAcceptPicker, filterAutoAcceptPicker, readAutoAcceptSender — `grep -n "function refreshAutoAcceptGate\|window.readAutoAcceptSender" public/js/app.js`). Replace that ENTIRE block with:

```js
// v2.91/2.94.x: auto-accept toggle stays locked until a primary URL is present
// (auto-accept needs to know whose invitation to accept). The source selector
// itself lives in Primary Person and is NOT gated here.
function refreshAutoAcceptGate() {
  const url = (document.getElementById('primary-person-url')?.value || '').trim();
  const toggle = document.getElementById('auto-accept-toggle');
  const gate = document.getElementById('auto-accept-gate');
  const hasUrl = /linkedin\.com\/in\//i.test(url);
  if (toggle) {
    toggle.disabled = !hasUrl;
    if (!hasUrl) toggle.checked = false;
  }
  if (gate) gate.style.display = hasUrl ? 'none' : '';
  refreshPrimarySourceLabels();
}
window.refreshAutoAcceptGate = refreshAutoAcceptGate;

// v2.94.x: show the GoLogin picker only when the GoLogin source is selected.
function togglePrimarySource() {
  const src = document.querySelector('input[name="primary-source"]:checked')?.value;
  const picker = document.getElementById('primary-source-picker');
  if (picker) picker.style.display = src === 'gologin' ? '' : 'none';
  if (src === 'gologin') renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
  refreshPrimarySourceLabels();
}
window.togglePrimarySource = togglePrimarySource;

// v2.94.x: single-select GoLogin profile picker for the primary's identity.
// Reuses allProfilesData + findSoOForProfile + renderSoOBadges. Selection is
// stored in the hidden #primary-source-profile-id input.
function renderPrimarySourcePicker(filter = '') {
  const grid = document.getElementById('primary-source-grid');
  if (!grid) return;
  const sel = document.getElementById('primary-source-profile-id')?.value || '';
  const q = (filter || '').trim().toLowerCase();
  const rows = (allProfilesData || []).filter(p =>
    !q || (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q));
  grid.innerHTML = '';
  if (rows.length === 0) {
    grid.innerHTML = '<div class="aa-acct-empty">No profiles match.</div>';
    return;
  }
  rows.forEach((p) => {
    const soo = findSoOForProfile(p.name);
    const isSel = p.id === sel;
    const row = document.createElement('div');
    row.className = 'aa-acct-row' + (isSel ? ' sel' : '');
    row.dataset.profileId = p.id;
    row.innerHTML = `
      <input type="radio" name="primary-source-profile" ${isSel ? 'checked' : ''}>
      <div class="body">
        <div class="name">${escHtml(p.name)}</div>
        ${!soo ? `<div class="id">${p.id.substring(0, 12)}…</div>` : ''}
        ${renderSoOBadges(soo)}
      </div>`;
    row.addEventListener('click', () => {
      const hidden = document.getElementById('primary-source-profile-id');
      if (hidden) hidden.value = p.id;
      renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
      refreshPrimarySourceLabels();
      savePrimaryPersonFields();
    });
    grid.appendChild(row);
  });
}
function filterPrimarySourcePicker() {
  renderPrimarySourcePicker(document.getElementById('primary-source-search')?.value || '');
}
window.filterPrimarySourcePicker = filterPrimarySourcePicker;

// v2.94.x: resolve the primary's identity for the templates payload.
// '' when GoLogin is selected but no profile picked yet — the launch guard
// catches that; normalizeTemplates also degrades '' to 'local-browser'.
function readPrimarySource() {
  const src = document.querySelector('input[name="primary-source"]:checked')?.value;
  if (src === 'gologin') return document.getElementById('primary-source-profile-id')?.value || '';
  return 'local-browser';
}
window.readPrimarySource = readPrimarySource;

// v2.94.x: live-update the read-only "as your primary — [name]" lines on the
// auto-accept + follow-up cards from the shared selector.
function refreshPrimarySourceLabels() {
  const src = readPrimarySource();
  let name = 'your local browser';
  if (src && src !== 'local-browser') {
    const p = (allProfilesData || []).find(x => x.id === src);
    name = p ? p.name : 'a GoLogin profile';
  }
  const aaLabel = document.getElementById('auto-accept-primary-label');
  const aaLine = document.getElementById('auto-accept-primary-line');
  if (aaLabel) aaLabel.textContent = name;
  // Show the auto-accept read-only line only when the feature is on.
  if (aaLine) aaLine.style.display = document.getElementById('auto-accept-toggle')?.checked ? '' : 'none';
  const fuLabel = document.getElementById('follow-up-primary-label');
  if (fuLabel) fuLabel.textContent = name;
}
window.refreshPrimarySourceLabels = refreshPrimarySourceLabels;
```

- [ ] **Step 2: Emit `primarySource` in BOTH config builders.** Find the two `followUpSender:` lines (`grep -n "followUpSender: _isIntroFlow" public/js/app.js` → 2 matches) and the two `autoAcceptSender: _isIntroFlow ? readAutoAcceptSender()` lines (`grep -n "autoAcceptSender: _isIntroFlow" public/js/app.js` → 2 matches). In EACH of the two builders: **delete** the `followUpSender: _isIntroFlow ? (...) : 'local-browser',` line and the `autoAcceptSender: _isIntroFlow ? readAutoAcceptSender() : 'local-browser',` line, and in their place put the single line:
```js
    primarySource: _isIntroFlow ? readPrimarySource() : 'local-browser',
```
After this: `grep -c "primarySource: _isIntroFlow ? readPrimarySource" public/js/app.js` → 2; `grep -c "followUpSender: _isIntroFlow" public/js/app.js` → 0; `grep -c "readAutoAcceptSender" public/js/app.js` → 0.

- [ ] **Step 3: Restore.** Find the restore block added earlier (the `{ const sender = t.autoAcceptSender ... }` block, located right after `if (t.followUpSender) setV('follow-up-sender', t.followUpSender);`). Replace BOTH that line and the block with:
```js
  // v2.94.x: restore the shared primary source. A profileId → GoLogin source;
  // 'local-browser'/absent → local. refreshAutoAcceptGate() below re-renders.
  {
    const src = t.primarySource || 'local-browser';
    const isGo = !!src && src !== 'local-browser';
    const hidden = document.getElementById('primary-source-profile-id');
    if (hidden) hidden.value = isGo ? src : '';
    const localR = document.querySelector('input[name="primary-source"][value="local-browser"]');
    const goR = document.querySelector('input[name="primary-source"][value="gologin"]');
    if (localR) localR.checked = !isGo;
    if (goR) goR.checked = isGo;
    if (typeof togglePrimarySource === 'function') togglePrimarySource();
  }
```
(The existing `refreshAutoAcceptGate()` call a couple of lines below will refresh the labels.)

- [ ] **Step 4: Generalize the launch guard.** Find the launch guard added earlier (`grep -n "Pick which GoLogin account is the primary" public/js/app.js`). Replace that whole `if (_isIntroFlow && document.getElementById('auto-accept-toggle')?.checked) { ... }` block with one that fires when EITHER primary-side feature is on:
```js
  // v2.94.x: if either primary-side action is on and the primary is set to a
  // GoLogin profile, a profile must be chosen — else there's no browser to use.
  if (_isIntroFlow) {
    const _aaOn = !!document.getElementById('auto-accept-toggle')?.checked;
    const _fuOn = !!document.getElementById('follow-up-toggle')?.checked;
    const _src = document.querySelector('input[name="primary-source"]:checked')?.value;
    if ((_aaOn || _fuOn) && _src === 'gologin' && !(document.getElementById('primary-source-profile-id')?.value || '')) {
      if (typeof showCampaignToast === 'function') {
        showCampaignToast('Pick which GoLogin profile your primary uses, or switch to your local browser.');
      }
      return;
    }
  }
```

- [ ] **Step 5: Verify.** Run:
```bash
node --check public/js/app.js                                              # clean
grep -c "function togglePrimarySource\|function renderPrimarySourcePicker\|function readPrimarySource\|function refreshPrimarySourceLabels\|function filterPrimarySourcePicker" public/js/app.js  # 5
grep -c "readAutoAcceptSender\|toggleAutoAcceptSource\|renderAutoAcceptPicker\|follow-up-sender" public/js/app.js   # 0
grep -c "primarySource: _isIntroFlow ? readPrimarySource" public/js/app.js  # 2
grep -c "Pick which GoLogin profile your primary uses" public/js/app.js     # 1
```

- [ ] **Step 6: Commit.**
```bash
git add public/js/app.js
git commit -m "feat(primary-source): shared selector JS — picker, live labels, emit primarySource, restore, guard"
```
(Append the Co-Authored-By trailer.)

---

## Task 7: Version bump, relaunch, full verification

**Files:** Modify `package.json`.

- [ ] **Step 1: Full suite.** `node --test tests/*.test.js` → 0 fail.
- [ ] **Step 2: Bump** `package.json` `"version"` `2.94.1` → `2.94.2`.
- [ ] **Step 3: Relaunch.**
```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
- [ ] **Step 4: Manual checklist (CC+IC mode, primary URL set).** In Primary Person: "Logged in via" shows two cards; choosing "A GoLogin profile" reveals the searchable grid with real profiles. Auto-accept card (toggle on): read-only line reads "Accepts as your primary — [name]" matching the selector. Follow-up card (toggle on): "Sent from your primary — [name]" matches. Switching the selector updates both lines live. With GoLogin selected + no profile picked and either feature on → Start blocked with the toast. Confirm the footer shows `2.94.2`.
- [ ] **Step 5: Commit.**
```bash
git add package.json
git commit -m "chore: bump to 2.94.2 for shared primary source"
```
(Append the Co-Authored-By trailer.)

---

## Self-Review (completed during planning)

**Spec coverage:**
- One `primarySource` field replaces both → Tasks 1 (normalize), 2 (consumers), 3 (schedule), 6 (UI emit/restore). ✓
- Picker relocated to Primary Person → Task 5 (markup) + Task 6 (JS rename to `primary-source`). ✓
- Auto-accept picker stripped → read-only line; follow-up dropdown stripped → read-only line → Task 5. ✓
- Follow-up posts as primary, token resolution untouched → Task 2 (line 92 only; line 91 explicitly preserved; test asserts personalized body). ✓
- Live read-only labels → Task 6 `refreshPrimarySourceLabels`. ✓
- Generalized launch guard (either feature) → Task 6 Step 4. ✓
- Schedule/post-campaign parity → Task 3. ✓
- No change to runner/partition/accept-invitation/thread-message → no task touches them. ✓
- Tests: normalize, follow-up sender, schedule → Tasks 1, 2, 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code (the one conditional note in Task 2 Step 1 — adjusting `introData` keys to match `personalizeTemplate` — is a concrete instruction with a named fallback, not a placeholder). ✓

**Type/name consistency:** `primarySource` (field), ids `primary-source`/`primary-source-picker`/`primary-source-search`/`primary-source-grid`/`primary-source-profile-id`, labels `auto-accept-primary-label`/`follow-up-primary-label`/line `auto-accept-primary-line`, fns `togglePrimarySource`/`renderPrimarySourcePicker`/`filterPrimarySourcePicker`/`readPrimarySource`/`refreshPrimarySourceLabels` — used consistently between Task 5 markup (`onchange`/`oninput`/ids) and Task 6 JS. Old names (`autoAcceptSender`, `followUpSender`, `readAutoAcceptSender`, `auto-accept-source`, `follow-up-sender`) are removed and grep-asserted to 0. ✓
