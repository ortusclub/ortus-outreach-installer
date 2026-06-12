# Auto-accept via a chosen GoLogin profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the CC+IC "Auto-accept the connection" run either via the local browser (today) or via a chosen GoLogin profile the primary is logged into, with a Variant-B two-source-card picker.

**Architecture:** Add one per-campaign template field, `autoAcceptSender` (`'local-browser'` | a `profileId`), and carry it on the accept task as `sender`. The primary-task runner already launches `launchAccount(profileId)` for non-local tasks and runs `acceptInvitationFrom(page,…)` on any page, so the only backend change is teaching the accept task + partitioner about `sender`. The UI swaps the single toggle for a master toggle + two radio source cards; the GoLogin card reveals a searchable single-select profile grid that reuses the existing profile data + SoO badges.

**Guiding rule:** `autoAcceptSender` goes **everywhere `followUpSender` already lives**, with the same defaulting — guaranteeing identical coverage across manual launch, scheduled runs, and the post-campaign sweep. `followUpSender` currently appears in: `src/campaign.js` (normalize, history), `src/post-campaign-bulk-check.js` (registerSchedule param, persist, read-back), `public/js/app.js` (two config builders, restore), and two test files.

**Tech Stack:** Node ≥22, `node --test` (pure-helper unit tests), Express 4, vanilla HTML/CSS/JS (no bundler), Electron shell for manual UI verification.

**Off-limits (do NOT touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Also no change needed to `src/primary-task-runner.js` or `src/linkedin/accept-invitation.js` (already generic over `page`).

**Spec:** `docs/superpowers/specs/2026-06-12-auto-accept-gologin-primary-design.md`
**Sketch (Variant B):** `public/sketches/auto-accept-primary-B-cards.html`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/primary-tasks.js` | accept/follow-up task builders + browser partition | `buildAcceptTask` gains `sender`; `partitionByBrowser` routes by `sender` for all task types |
| `src/campaign.js` | template normalize, accept enqueue, history snapshot | normalize `autoAcceptSender`; pass `sender` at enqueue; persist in history |
| `src/post-campaign-bulk-check.js` | scheduled/monitoring schedule entries | persist + read back `autoAcceptSender` (parity) |
| `public/index.html` | auto-accept config card markup | replace single toggle with master toggle + 2 source cards + picker container |
| `public/css/style.css` | styling | add `.aa-src-card` / `.aa-acct-*` classes (reuses existing `.status-bar`/`.soo-user`) |
| `public/js/app.js` | picker render, source toggle, gate, read/restore, launch guard | new helpers + 4 edit sites |
| `tests/accept-task-sender.test.js` | NEW unit test | `buildAcceptTask` + `partitionByBrowser` |
| `tests/normalize-templates-primary.test.js` | extend | `autoAcceptSender` normalize |
| `tests/register-schedule-followup-fields.test.js` | extend | `autoAcceptSender` persistence |

---

## Task 1: Accept task carries `sender`; partitioner routes by it

**Files:**
- Create: `tests/accept-task-sender.test.js`
- Modify: `src/primary-tasks.js:40-52` (`buildAcceptTask`), `src/primary-tasks.js:59-71` (`partitionByBrowser`)

- [ ] **Step 1: Write the failing test**

Create `tests/accept-task-sender.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptTask, partitionByBrowser } from '../src/primary-tasks.js';

test('buildAcceptTask carries sender, defaults to local-browser', () => {
  const a = buildAcceptTask({ campaignProfileId: 'c1', now: 1000 });
  assert.equal(a.sender, 'local-browser');
  const b = buildAcceptTask({ campaignProfileId: 'c1', sender: 'profX', now: 1000 });
  assert.equal(b.sender, 'profX');
});

test('partitionByBrowser routes accept tasks by sender (legacy = local)', () => {
  const due = [
    { type: 'accept', sender: 'local-browser' },
    { type: 'accept', sender: 'profA' },
    { type: 'accept' },                       // legacy task, no sender → local
    { type: 'follow-up', sender: 'profB' },
    { type: 'follow-up', sender: 'local-browser' },
  ];
  const { local, byAccount } = partitionByBrowser(due);
  assert.equal(local.length, 3);             // local accept + legacy accept + local follow-up
  assert.deepEqual(Object.keys(byAccount).sort(), ['profA', 'profB']);
  assert.equal(byAccount.profA.length, 1);
  assert.equal(byAccount.profB.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/accept-task-sender.test.js`
Expected: FAIL — `buildAcceptTask` returns no `sender` (first test); `partitionByBrowser` puts the `sender:'profA'` accept task in `local` because of the `t.type === 'accept'` short-circuit (second test asserts `byAccount.profA`).

- [ ] **Step 3: Implement `buildAcceptTask` sender**

In `src/primary-tasks.js`, change `buildAcceptTask` (currently lines 40-52) to:

```js
export function buildAcceptTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  account = { name: '', profileUrl: '' }, primaryUrl = '', sender = 'local-browser', now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  return {
    id: `accept:${campaignProfileId}:${created}`,
    type: 'accept', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    account, primaryUrl, sender,
  };
}
```

- [ ] **Step 4: Implement `partitionByBrowser` routing**

In `src/primary-tasks.js`, change `partitionByBrowser` (currently lines 59-71) to route every task type by `sender`, defaulting a missing/legacy `sender` to local:

```js
/** Pure: split due tasks into the local-browser bucket and per-account buckets.
 *  Routing is by `sender` for ALL task types. Accept tasks built before the
 *  auto-accept-sender change have no `sender` field → treated as local-browser,
 *  preserving the old "accept always runs locally" behaviour. */
export function partitionByBrowser(due) {
  const local = [];
  const byAccount = {};
  for (const t of due) {
    const sender = t.sender || 'local-browser';
    if (sender === 'local-browser') {
      local.push(t);
    } else {
      (byAccount[sender] ||= []).push(t);
    }
  }
  return { local, byAccount };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/accept-task-sender.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite (no regressions in the partition contract)**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/primary-tasks.js tests/accept-task-sender.test.js
git commit -m "feat(auto-accept): accept task carries sender; partition routes by it"
```

---

## Task 2: Normalize + persist `autoAcceptSender` in campaign templates

**Files:**
- Modify: `src/campaign.js:1329-1334` (normalizeTemplates), `src/campaign.js:3770-3774` (history snapshot)
- Test: `tests/normalize-templates-primary.test.js` (extend)

- [ ] **Step 1: Extend the failing test**

In `tests/normalize-templates-primary.test.js`, add `autoAcceptSender` assertions. In the **defaults** test (after line 11 `assert.equal(t.followUpSender, 'local-browser');`) add:

```js
  assert.equal(t.autoAcceptSender, 'local-browser');
```

In the **honors provided** test, add `autoAcceptSender: 'profile-abc123'` to the input object and after line 26 add:

```js
  assert.equal(t.autoAcceptSender, 'profile-abc123');
```

Add a new test at the end of the file:

```js
test('autoAcceptSender falls back to local-browser for empty/unknown', () => {
  assert.equal(normalizeTemplates({ autoAcceptSender: '' }, 'connect_and_introduce').autoAcceptSender, 'local-browser');
  assert.equal(normalizeTemplates({}, 'connect_and_introduce').autoAcceptSender, 'local-browser');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/normalize-templates-primary.test.js`
Expected: FAIL — `t.autoAcceptSender` is `undefined`.

- [ ] **Step 3: Implement normalize**

In `src/campaign.js`, inside `normalizeTemplates`, add `autoAcceptSender` immediately after the `followUpSender` line (currently line 1333). Unlike `followUpSender` (an enum resolved later), this value is `'local-browser'` or a concrete `profileId`, so pass non-empty non-local values straight through:

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

- [ ] **Step 4: Implement history persistence**

In `src/campaign.js`, in the history snapshot block, add `autoAcceptSender` right after the `followUpSender` line (currently line 3774):

```js
            followUpSender: (templates && templates.followUpSender) || 'local-browser',
            autoAcceptSender: (templates && templates.autoAcceptSender) || 'local-browser',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/normalize-templates-primary.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js tests/normalize-templates-primary.test.js
git commit -m "feat(auto-accept): normalize + persist autoAcceptSender in templates"
```

---

## Task 3: Pass `sender` at the accept enqueue site + source-aware log

**Files:**
- Modify: `src/campaign.js:2458-2467` (the single `buildAcceptTask` call site)

No new automated test (enqueue site is integration-level; covered by Task 1/2 unit tests + manual verification). This is a 2-line change.

- [ ] **Step 1: Pass the sender into `buildAcceptTask`**

In `src/campaign.js`, in the auto-accept enqueue block, add `sender: tpl.autoAcceptSender` to the `buildAcceptTask({…})` call (currently lines 2458-2465). Result:

```js
                    const _task = buildAcceptTask({
                      campaignProfileId: profileId,
                      campaignProfileName: pName,
                      sheetId: _extractSheetIdFromUrl(sheetUrl) || '',
                      sheetUrl,
                      account: _self,
                      primaryUrl: _primaryUrl,
                      sender: tpl.autoAcceptSender,
                    });
```

- [ ] **Step 2: Make the queued-log line source-aware**

In `src/campaign.js`, replace the success log line (currently line 2467) so it names the browser that will accept:

```js
                    const _stored = await enqueuePrimaryTask(_task);
                    if (_stored) {
                      const _where = (tpl.autoAcceptSender && tpl.autoAcceptSender !== 'local-browser')
                        ? 'the chosen GoLogin profile'
                        : 'your local browser';
                      log(`  ⏳ [${pName}] Auto-accept queued — ${_where} will accept this account's invite at the next idle moment.`);
                    }
```

- [ ] **Step 3: Run the full suite (no regressions)**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/campaign.js
git commit -m "feat(auto-accept): enqueue accept task with chosen sender + source-aware log"
```

---

## Task 4: Schedule/monitoring parity for `autoAcceptSender`

**Files:**
- Modify: `src/post-campaign-bulk-check.js:101-103` (params), `:128-132` (persist), `:278-282` (read-back to runAutoIntros)
- Test: `tests/register-schedule-followup-fields.test.js` (extend)

- [ ] **Step 1: Extend the failing test**

In `tests/register-schedule-followup-fields.test.js`, add `autoAcceptSender: 'profile-sched1'` to the `registerSchedule({…})` input (after `followUpSender: 'campaign-account',` on line 18), and after line 26 add:

```js
  assert.equal(entry.autoAcceptSender, 'profile-sched1');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/register-schedule-followup-fields.test.js`
Expected: FAIL — `entry.autoAcceptSender` is `undefined`.

- [ ] **Step 3: Add the param**

In `src/post-campaign-bulk-check.js`, add `autoAcceptSender` to the `registerSchedule` destructured params. Change the tail of the param list (currently line 103 `followUpSender = 'local-browser' }`) to:

```js
                                          followUpSender = 'local-browser',
                                          autoAcceptSender = 'local-browser' }) {
```

- [ ] **Step 4: Persist it on the entry**

In `src/post-campaign-bulk-check.js`, in the object written for the schedule entry, add `autoAcceptSender` right after the `followUpSender` line (currently line 132):

```js
    followUpSender: followUpSender === 'campaign-account' ? 'campaign-account' : 'local-browser',
    autoAcceptSender: (autoAcceptSender && autoAcceptSender !== 'local-browser') ? autoAcceptSender : 'local-browser',
```

- [ ] **Step 5: Read it back into the post-campaign intro templates**

In `src/post-campaign-bulk-check.js`, in the `runAutoIntros({ templates: {…} })` call, add `autoAcceptSender` right after the `followUpSender` line (currently line 282):

```js
                followUpSender: entry.followUpSender,
                autoAcceptSender: entry.autoAcceptSender,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/register-schedule-followup-fields.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/post-campaign-bulk-check.js tests/register-schedule-followup-fields.test.js
git commit -m "feat(auto-accept): schedule + post-campaign parity for autoAcceptSender"
```

---

## Task 5: CSS for the source cards + account picker

**Files:**
- Modify: `public/css/style.css` (append in the CC+IC config cluster, right after the `.intro-config-num` rule at line 4221)

UI task — verification is visual (next tasks). Reuses existing `.status-bar`/`.status-seg`/`.soo-user`/`.status-legend` (rendered by `renderSoOBadges`), so only the new wrappers need styling.

- [ ] **Step 1: Append the styles**

In `public/css/style.css`, after the line `.intro-config-num{…}` (line 4221), add:

```css
/* v2.94.x — Auto-accept source cards (Variant B) + single-select profile picker */
.aa-src-cards{display:flex;flex-direction:column;gap:10px;margin:8px 0 4px;}
.aa-src-card{border:1px solid var(--hairline);border-radius:10px;padding:12px 14px;transition:border-color .15s ease, background .15s ease;}
.aa-src-card:has(input[type="radio"]:checked){border-color:var(--ink);background:var(--hairline-soft);}
.aa-src-head{display:flex;align-items:center;gap:10px;cursor:pointer;margin:0;}
.aa-src-head input[type="radio"]{accent-color:var(--ink);width:15px;height:15px;flex-shrink:0;}
.aa-src-title{font-size:.9rem;font-weight:600;color:var(--ink);}
.aa-src-desc{font-size:.76rem;color:var(--gray);margin:6px 0 0 25px;line-height:1.45;}
.aa-acct-search{width:calc(100% - 25px);margin:12px 0 8px 25px;font-family:var(--mono);font-size:.76rem;padding:7px 12px;border:1px solid var(--hairline);border-radius:9999px;background:var(--card-bg);color:var(--ink);outline:none;}
.aa-acct-search::placeholder{color:var(--gray);}
.aa-acct-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-left:25px;max-height:240px;overflow:auto;}
.aa-acct-row{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--hairline);border-radius:8px;padding:8px 10px;cursor:pointer;transition:opacity .15s ease, border-color .15s ease, background .15s ease;}
.aa-acct-row:hover{opacity:.8;}
.aa-acct-row.sel{border-color:var(--ink);background:var(--card-bg);}
.aa-acct-row input[type="radio"]{accent-color:var(--ink);width:13px;height:13px;margin-top:2px;flex-shrink:0;}
.aa-acct-row .body{min-width:0;flex:1;}
.aa-acct-row .name{font-size:.72rem;font-weight:500;color:var(--ink);word-break:break-all;}
.aa-acct-row .id{font-size:.54rem;color:var(--gray);font-family:ui-monospace,monospace;margin-top:2px;}
.aa-acct-empty{font-size:.72rem;color:var(--gray);padding:8px 4px;margin-left:25px;}
@media(max-width:1100px){.aa-acct-grid{grid-template-columns:1fr;}}
```

- [ ] **Step 2: Commit**

```bash
git add public/css/style.css
git commit -m "style(auto-accept): source-card + profile-picker styles"
```

---

## Task 6: HTML — master toggle + two source cards + picker container

**Files:**
- Modify: `public/index.html:564-577` (the `#auto-accept-block` card body)

- [ ] **Step 1: Replace the auto-accept card body**

In `public/index.html`, replace the current `#auto-accept-block` contents (lines 564-577) with:

```html
          <div id="auto-accept-block" class="intro-config-card" style="display:none;">
            <div class="intro-config-eyebrow">Auto-accept the connection <span class="intro-config-newtag">NEW</span></div>
            <div class="intro-config-toggle-row">
              <span id="auto-accept-label" class="intro-config-toggle-key">Auto-accept the primary's invitation</span>
              <label class="notif-pref-toggle" id="auto-accept-toggle-wrap">
                <input type="checkbox" id="auto-accept-toggle" disabled onchange="savePrimaryPersonFields(); refreshAutoAcceptGate();">
                <span class="notif-pref-slider"></span>
              </label>
            </div>
            <div id="auto-accept-gate" class="intro-config-gate">
              🔒 Add the primary person's LinkedIn URL above to switch this on — without the URL there's nothing to accept from.
            </div>
            <!-- v2.94.x: where the primary accepts — local browser (default) or a GoLogin profile -->
            <div id="auto-accept-source" style="display:none;">
              <div class="aa-src-cards">
                <div class="aa-src-card">
                  <label class="aa-src-head">
                    <input type="radio" name="auto-accept-source" value="local-browser" checked
                           onchange="toggleAutoAcceptSource(); savePrimaryPersonFields();">
                    <span class="aa-src-title">Accept via my local browser</span>
                  </label>
                  <div class="aa-src-desc">You're logged into LinkedIn as the primary in your own Chrome.</div>
                </div>
                <div class="aa-src-card">
                  <label class="aa-src-head">
                    <input type="radio" name="auto-accept-source" value="gologin"
                           onchange="toggleAutoAcceptSource(); savePrimaryPersonFields();">
                    <span class="aa-src-title">Accept via a GoLogin account</span>
                  </label>
                  <div class="aa-src-desc">The primary is one of your GoLogin profiles — pick which one.</div>
                  <div id="auto-accept-picker" style="display:none;">
                    <input type="text" id="auto-accept-search" class="aa-acct-search"
                           placeholder="Search by name or email…" oninput="filterAutoAcceptPicker()">
                    <div id="auto-accept-grid" class="aa-acct-grid"></div>
                    <div class="intro-config-hint" style="margin-top:6px">This profile must be logged into LinkedIn as the primary.</div>
                  </div>
                  <input type="hidden" id="auto-accept-profile-id" value="">
                </div>
              </div>
            </div>
            <div class="intro-config-hint">When an account isn't connected to your primary, it requests them and the chosen browser accepts that one invitation automatically — no manual step before the intro.</div>
          </div>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(auto-accept): Variant B markup — source cards + picker container"
```

---

## Task 7: JS — picker render, source toggle, gate, read/restore, launch guard

**Files:**
- Modify: `public/js/app.js` — replace `refreshAutoAcceptGate` (8201-8212); add helpers next to it; edit two config builders (214/218 area and 3644/3648 area); edit restore (7127-7131 area); add launch guard in `startCampaign` (after the launch config object closes, ~3651).

- [ ] **Step 1: Add picker + source helpers and extend the gate**

In `public/js/app.js`, replace the `refreshAutoAcceptGate` function (currently lines 8201-8212, ending at `window.refreshAutoAcceptGate = refreshAutoAcceptGate;`) with the extended gate plus the new helpers:

```js
// v2.91/2.94.x: Lock auto-accept until a primary URL is present, and reveal the
// source cards (local vs GoLogin) only while the feature is on.
function refreshAutoAcceptGate() {
  const url = (document.getElementById('primary-person-url')?.value || '').trim();
  const toggle = document.getElementById('auto-accept-toggle');
  const gate = document.getElementById('auto-accept-gate');
  const source = document.getElementById('auto-accept-source');
  const hasUrl = /linkedin\.com\/in\//i.test(url);
  if (toggle) {
    toggle.disabled = !hasUrl;
    if (!hasUrl) toggle.checked = false;
  }
  if (gate) gate.style.display = hasUrl ? 'none' : '';
  const showSource = hasUrl && !!toggle?.checked;
  if (source) source.style.display = showSource ? '' : 'none';
  if (showSource) toggleAutoAcceptSource();
}
window.refreshAutoAcceptGate = refreshAutoAcceptGate;

// v2.94.x: show the profile picker only when the GoLogin source is selected.
function toggleAutoAcceptSource() {
  const src = document.querySelector('input[name="auto-accept-source"]:checked')?.value;
  const picker = document.getElementById('auto-accept-picker');
  if (picker) picker.style.display = src === 'gologin' ? '' : 'none';
  if (src === 'gologin') renderAutoAcceptPicker(document.getElementById('auto-accept-search')?.value || '');
}
window.toggleAutoAcceptSource = toggleAutoAcceptSource;

// v2.94.x: single-select profile picker for the primary's GoLogin account.
// Reuses allProfilesData + findSoOForProfile + renderSoOBadges so fields and
// badges match the Browse Accounts grid exactly. Selection is stored in the
// hidden #auto-accept-profile-id input.
function renderAutoAcceptPicker(filter = '') {
  const grid = document.getElementById('auto-accept-grid');
  if (!grid) return;
  const sel = document.getElementById('auto-accept-profile-id')?.value || '';
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
      <input type="radio" name="auto-accept-profile" ${isSel ? 'checked' : ''}>
      <div class="body">
        <div class="name">${escHtml(p.name)}</div>
        ${!soo ? `<div class="id">${p.id.substring(0, 12)}…</div>` : ''}
        ${renderSoOBadges(soo)}
      </div>`;
    row.addEventListener('click', () => {
      const hidden = document.getElementById('auto-accept-profile-id');
      if (hidden) hidden.value = p.id;
      renderAutoAcceptPicker(document.getElementById('auto-accept-search')?.value || '');
      savePrimaryPersonFields();
    });
    grid.appendChild(row);
  });
}
function filterAutoAcceptPicker() {
  renderAutoAcceptPicker(document.getElementById('auto-accept-search')?.value || '');
}
window.filterAutoAcceptPicker = filterAutoAcceptPicker;

// v2.94.x: resolve the configured accept source for the templates payload.
// '' when GoLogin is chosen but no profile picked yet — the launch guard catches
// that; normalizeTemplates also degrades '' to 'local-browser' as a backstop.
function readAutoAcceptSender() {
  if (!document.getElementById('auto-accept-toggle')?.checked) return 'local-browser';
  const src = document.querySelector('input[name="auto-accept-source"]:checked')?.value;
  if (src === 'gologin') return document.getElementById('auto-accept-profile-id')?.value || '';
  return 'local-browser';
}
window.readAutoAcceptSender = readAutoAcceptSender;
```

- [ ] **Step 2: Emit `autoAcceptSender` from the preview/save config builder**

In `public/js/app.js`, in the first config builder, add the field right after the `followUpSender` line (currently line 218):

```js
    followUpSender: _isIntroFlow ? (document.getElementById('follow-up-sender')?.value || 'local-browser') : 'local-browser',
    autoAcceptSender: _isIntroFlow ? readAutoAcceptSender() : 'local-browser',
```

- [ ] **Step 3: Emit `autoAcceptSender` from the launch config builder**

In `public/js/app.js`, in the `startCampaign` config builder, add the field right after the `followUpSender` line (currently line 3648):

```js
    followUpSender: _isIntroFlow ? (document.getElementById('follow-up-sender')?.value || 'local-browser') : 'local-browser',
    autoAcceptSender: _isIntroFlow ? readAutoAcceptSender() : 'local-browser',
```

- [ ] **Step 4: Restore source + selected profile on template/preset load**

In `public/js/app.js`, in the template-restore block, after the `if (t.followUpSender) setV('follow-up-sender', t.followUpSender);` line (currently 7131) and before the `toggleFollowUpFields()` call (7132), add:

```js
  // v2.94.x: restore the auto-accept source + chosen profile. A profileId means
  // the GoLogin source; 'local-browser'/absent means local. refreshAutoAcceptGate()
  // below (line ~7133) reveals the cards + re-renders the picker selection.
  {
    const sender = t.autoAcceptSender || 'local-browser';
    const isGo = !!sender && sender !== 'local-browser';
    const hidden = document.getElementById('auto-accept-profile-id');
    if (hidden) hidden.value = isGo ? sender : '';
    const localR = document.querySelector('input[name="auto-accept-source"][value="local-browser"]');
    const goR = document.querySelector('input[name="auto-accept-source"][value="gologin"]');
    if (localR) localR.checked = !isGo;
    if (goR) goR.checked = isGo;
  }
```

- [ ] **Step 5: Add the launch guard in `startCampaign`**

In `public/js/app.js`, immediately after the launch config object literal closes (the `};` at line 3651, before the `// Show account queue` comment at 3653), add:

```js
  // v2.94.x: if auto-accept is on and set to a GoLogin account, a profile must
  // be chosen — otherwise there is no browser to launch for the acceptance.
  if (_isIntroFlow && document.getElementById('auto-accept-toggle')?.checked) {
    const _aaSrc = document.querySelector('input[name="auto-accept-source"]:checked')?.value;
    if (_aaSrc === 'gologin' && !(document.getElementById('auto-accept-profile-id')?.value || '')) {
      if (typeof showCampaignToast === 'function') {
        showCampaignToast('Pick which GoLogin account is the primary, or switch auto-accept to your local browser.');
      }
      return;
    }
  }
```

- [ ] **Step 6: Manual verification (Electron)**

Bump `package.json` patch (see Task 8 Step 1), then run `npm run dev:app` and Cmd+R. Verify, in CC+IC mode with a primary URL set:
  1. Toggle on → two source cards appear; "local browser" selected by default; no picker.
  2. Select "a GoLogin account" → searchable grid appears, listing your real profiles with email name + SoO badges.
  3. Type in search → grid filters.
  4. Click a profile → it highlights; the others clear (single-select).
  5. Reload (Cmd+R) after a save/preset → source + chosen profile restore.
  6. With "a GoLogin account" selected but no profile picked, hit Start → blocked with the toast.
  7. Switch back to "local browser" → Start proceeds (today's behaviour).

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js
git commit -m "feat(auto-accept): picker render, source toggle, gate, restore, launch guard"
```

---

## Task 8: Version bump, relaunch, full verification

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Patch-bump the version**

Bump `package.json` `"version"` from `2.94.0` to `2.94.1` (operator rule: bump before every relaunch so the UI shows the new build).

- [ ] **Step 2: Relaunch the dev app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 3: Re-run the manual checklist from Task 7 Step 6 against the running build**, confirming the footer/UI shows `2.94.1`.

- [ ] **Step 4: Run the full test suite one final time**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: bump to 2.94.1 for auto-accept GoLogin-primary build"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- UI two source cards + searchable single-select grid → Tasks 5, 6, 7. ✓
- Master toggle + URL gate retained → Task 6 (markup) + Task 7 (gate). ✓
- `autoAcceptSender` persistence mirroring `followUpSender` → Tasks 2 (normalize, history), 4 (schedule/read-back), 7 (config builders, restore). ✓
- Backend routing (`sender` on accept task; partition by sender) → Task 1. ✓
- Enqueue passes chosen sender → Task 3. ✓
- "Trust + soft hint" failure mode → hint copy in Task 6 markup; no identity validation added. ✓
- Launch guard (GoLogin chosen, no profile) → Task 7 Step 5. ✓
- Tests (partition, builder, normalize, schedule) → Tasks 1, 2, 4. ✓
- Off-limits files untouched; runner + accept-invitation unchanged → no task touches them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** field `autoAcceptSender` (templates/entry) and task field `sender` used consistently; helpers `readAutoAcceptSender`/`renderAutoAcceptPicker`/`toggleAutoAcceptSource`/`filterAutoAcceptPicker`/`refreshAutoAcceptGate` referenced with matching names across markup `onchange`/`oninput` and JS definitions; DOM ids (`auto-accept-source`, `auto-accept-picker`, `auto-accept-grid`, `auto-accept-search`, `auto-accept-profile-id`) consistent between Task 6 markup and Task 7 JS. ✓
```
