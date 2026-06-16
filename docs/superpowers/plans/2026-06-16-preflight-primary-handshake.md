# Pre-flight Primary Handshake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the account↔primary connection links via a deterministic pre-flight handshake at campaign start (senders connect → primary accepts → outreach), best-effort with the existing idle queue as fallback, surfaced as a gold "pre-flight" state on the campaign card.

**Architecture:** A new pure planner module (`src/preflight-handshake.js`) makes the decisions (who needs connecting, progress, proceed-or-not, checklist mapping). A nested `runPreflightHandshake` orchestrator inside `startCampaign` wires that planner to the existing browser helpers (`checkAndConnectPrimary`, `readSelfIdentity`, `acceptInvitationFrom`, the launchers) and runs **before the worker pool spawns**. The accept step gains "Take care when connecting" modal handling (shared by the idle runner). Status gets a `phase` field; the card renders a `is-preflight` branch from `phase` + the existing `primaryConn` map.

**Tech Stack:** Node ≥22 ESM, `node --test`, Express 4, vanilla JS frontend (no bundler), Puppeteer-core via GoLogin.

**Spec:** `docs/superpowers/specs/2026-06-16-preflight-primary-handshake-design.md`

**Repo conventions (READ FIRST):**
- Off-limits — **never** modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- Commits follow the operator's "commit only when asked" rule — the commit steps below are the intended unit boundaries; the operator confirms when they actually land (they may be batched).
- After any commit touching runtime code, **bump `package.json` version** (this feature = minor bump to `2.105.0`) and relaunch `dev:app` (final task).
- Run the full suite with `node --test` (728+ tests today; keep them green).

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `src/preflight-handshake.js` | Pure planner: who-needs-connecting, progress, proceed decision, checklist-state mapping. No Puppeteer, no imports from campaign.js. | **new** |
| `tests/preflight-handshake.test.js` | Unit tests for the planner. | **new** |
| `src/linkedin/accept-invitation.js` | `acceptInvitationFrom` gains "Take care when connecting" modal confirm after the Accept click. | modify |
| `tests/accept-invitation-pick.test.js` | Add label assertions for the modal buttons. | modify |
| `src/campaign.js` | Nested `runPreflightHandshake` orchestrator + call site before the worker pool; `getCampaignStatus` gains `phase`. | modify |
| `public/js/app.js` | `renderActiveCard` `is-preflight` branch + checklist render. | modify |
| `public/js/live-activity.mjs` | Pre-flight beat line. | modify |
| `public/index.html` | Checklist container in `#active-card`. | modify |
| `public/css/dashboard-v0.3.css` | `is-preflight` gold state + `pf-list` styles (port from the sketch). | modify |
| `package.json` / `package-lock.json` | Version → `2.105.0`. | modify |

---

## Task 1: Pure pre-flight planner module

**Files:**
- Create: `src/preflight-handshake.js`
- Test: `tests/preflight-handshake.test.js`

State vocabulary (single source of truth, shared producer↔consumer):
`'already_connected' | 'sent' | 'accepting' | 'connected' | 'unverified'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/preflight-handshake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAccountsNeedingConnect, handshakeProgress, shouldProceed, checklistRow,
} from '../src/preflight-handshake.js';

test('planAccountsNeedingConnect: skips local-browser and already-connected', () => {
  const participating = ['p1', 'p2', 'local-browser', 'p3'];
  const primaryConn = new Map([['p1', 'connected'], ['p3', 'no_url']]);
  // p1 already connected → skip; local-browser → skip; p2 (unknown) + p3 → need connect
  assert.deepEqual(planAccountsNeedingConnect(participating, primaryConn), ['p2', 'p3']);
});

test('planAccountsNeedingConnect: empty when all connected or local', () => {
  const participating = ['local-browser', 'p1'];
  const primaryConn = new Map([['p1', 'connected']]);
  assert.deepEqual(planAccountsNeedingConnect(participating, primaryConn), []);
});

test('handshakeProgress: counts accepted vs expected', () => {
  const expected = ['p1', 'p2', 'p3'];
  const primaryConn = new Map([['p1', 'connected'], ['p2', 'sent'], ['p3', 'accepting']]);
  assert.deepEqual(handshakeProgress(primaryConn, expected), { accepted: 1, total: 3, done: false });
});

test('handshakeProgress: done when all accepted', () => {
  const expected = ['p1', 'p2'];
  const primaryConn = new Map([['p1', 'connected'], ['p2', 'connected']]);
  assert.deepEqual(handshakeProgress(primaryConn, expected), { accepted: 2, total: 2, done: true });
});

test('handshakeProgress: total 0 → done true (nothing to do)', () => {
  assert.deepEqual(handshakeProgress(new Map(), []), { accepted: 0, total: 0, done: true });
});

test('shouldProceed: true when all accepted, regardless of time', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 1000, capMs: 120000, accepted: 3, total: 3 }), true);
});

test('shouldProceed: true when cap elapsed even if not all accepted', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 120001, capMs: 120000, accepted: 1, total: 3 }), true);
});

test('shouldProceed: false while waiting inside the cap with stragglers', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 30000, capMs: 120000, accepted: 1, total: 3 }), false);
});

test('checklistRow: maps state → icon + label', () => {
  assert.deepEqual(checklistRow('Angelica', 'connected'),        { name: 'Angelica', state: 'connected',        icon: '✓', label: 'accepted by primary' });
  assert.deepEqual(checklistRow('Miriam',   'accepting'),        { name: 'Miriam',   state: 'accepting',        icon: '↻', label: 'accepting…' });
  assert.deepEqual(checklistRow('Cindy',    'sent'),             { name: 'Cindy',    state: 'sent',             icon: '•', label: 'request sent — waiting' });
  assert.deepEqual(checklistRow('Stan',     'already_connected'),{ name: 'Stan',     state: 'already_connected',icon: '–', label: 'already connected' });
  assert.deepEqual(checklistRow('Unk',      'unverified'),       { name: 'Unk',      state: 'unverified',       icon: '•', label: 'could not verify' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/preflight-handshake.test.js`
Expected: FAIL — `Cannot find module '../src/preflight-handshake.js'`.

- [ ] **Step 3: Write the module**

```js
// src/preflight-handshake.js
/**
 * Pure decision logic for the pre-flight primary handshake. No Puppeteer, no
 * campaign import — fully unit-testable. The campaign orchestrator wires these
 * decisions to the real browser helpers.
 */

// States that mean "this account's link is already done — no connect needed".
const DONE_STATES = new Set(['connected', 'already_connected']);

/** Accounts that still need a connect-to-primary request: non-local, not already done. */
export function planAccountsNeedingConnect(participating, primaryConn) {
  const conn = primaryConn instanceof Map ? primaryConn : new Map(Object.entries(primaryConn || {}));
  return (participating || []).filter((id) => {
    if (!id || id === 'local-browser') return false;
    return !DONE_STATES.has(conn.get(id));
  });
}

/** Accepted-vs-expected progress. done = all expected accepted (or nothing expected). */
export function handshakeProgress(primaryConn, expectedIds) {
  const conn = primaryConn instanceof Map ? primaryConn : new Map(Object.entries(primaryConn || {}));
  const total = (expectedIds || []).length;
  const accepted = (expectedIds || []).filter((id) => conn.get(id) === 'connected').length;
  return { accepted, total, done: accepted >= total };
}

/** Proceed to outreach when every link is accepted OR the bounded poll cap has elapsed. */
export function shouldProceed({ startedAt, now, capMs, accepted, total }) {
  if (accepted >= total) return true;
  return (now - startedAt) >= capMs;
}

const ROWS = {
  connected:         { icon: '✓', label: 'accepted by primary' },
  accepting:         { icon: '↻', label: 'accepting…' },
  sent:              { icon: '•', label: 'request sent — waiting' },
  already_connected: { icon: '–', label: 'already connected' },
  unverified:        { icon: '•', label: 'could not verify' },
};

/** Map one account's state to a checklist row for the UI. */
export function checklistRow(name, state) {
  const r = ROWS[state] || { icon: '•', label: '' };
  return { name, state, icon: r.icon, label: r.label };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/preflight-handshake.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preflight-handshake.js tests/preflight-handshake.test.js
git commit -m "feat(preflight): pure planner for primary handshake"
```

---

## Task 2: "Take care when connecting" modal confirm in acceptInvitationFrom

**Files:**
- Modify: `src/linkedin/accept-invitation.js` (the click site is lines 209–242; add modal handling after the `clicked` evaluate)
- Test: `tests/accept-invitation-pick.test.js`

Context: today `acceptInvitationFrom` clicks the card Accept then waits 1500ms. On some accounts LinkedIn then shows a **"Take care when connecting"** dialog whose **Accept invite** button must be clicked to actually accept. The matcher reuse: `isAcceptLabel('Accept invite') === true` and `isAcceptLabel('View profile') === false`, so the same accept-stem logic distinguishes the modal's two buttons.

- [ ] **Step 1: Write the failing test** (the testable kernel — the matcher distinguishes the modal buttons)

```js
// add to tests/accept-invitation-pick.test.js
test('isAcceptLabel distinguishes the "Take care when connecting" modal buttons', () => {
  assert.equal(isAcceptLabel('Accept invite'), true);   // the confirm we must click
  assert.equal(isAcceptLabel('View profile'), false);   // must NOT click
});
```

- [ ] **Step 2: Run test to verify it passes already** (asserts the existing matcher is sufficient — no code change needed for the label logic itself)

Run: `node --test tests/accept-invitation-pick.test.js`
Expected: PASS. (If `View profile` ever matched an accept stem, this would fail and flag a matcher bug.)

- [ ] **Step 3: Add the modal-confirm handling after the Accept click**

In `acceptInvitationFrom`, after the `const clicked = await page.evaluate(...)` block and its `if (!clicked) return ...`, and the existing `await new Promise((r) => setTimeout(r, 1500));`, add a best-effort confirm. Replace this tail:

```js
  if (!clicked) return { accepted: false, reason: 'matched-row-not-found-at-click' };
  await new Promise((r) => setTimeout(r, 1500));
  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
```

with:

```js
  if (!clicked) return { accepted: false, reason: 'matched-row-not-found-at-click' };
  await new Promise((r) => setTimeout(r, 1500));

  // Some invitations (cold / high-mutual) trigger a "Take care when connecting"
  // confirmation modal AFTER the card Accept — the invite is NOT actually
  // accepted until its "Accept invite" button is clicked. The modal doesn't
  // always appear, so this is best-effort: wait briefly for a dialog, click its
  // accept-stem button (scoped to the dialog, never "View profile" or the X),
  // then settle. Reuses the same locale-aware accept-stem logic as the card.
  try {
    const confirmed = await page.evaluate((acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
      if (!dialog) return false;
      for (const btn of Array.from(dialog.querySelectorAll('button'))) {
        if (isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) { btn.click(); return true; }
      }
      return false;
    }, ACCEPT_STEMS, IGNORE_STEMS).catch(() => false);
    if (confirmed) {
      await new Promise((r) => setTimeout(r, 1200));
      log(`  ✓ Auto-accept: confirmed via "Take care when connecting" for ${target?.name || 'the account'}.`);
    }
  } catch { /* no modal / already accepted — fine */ }

  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
```

(Note: `ACCEPT_STEMS` / `IGNORE_STEMS` are already module-level exports in this file; no new import.)

- [ ] **Step 4: Run the full accept-invitation suite + syntax check**

Run: `node --check src/linkedin/accept-invitation.js && node --test tests/accept-invitation-pick.test.js`
Expected: syntax OK; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/accept-invitation.js tests/accept-invitation-pick.test.js
git commit -m "fix(accept): confirm the 'Take care when connecting' modal so invites actually accept"
```

---

## Task 3: runPreflightHandshake orchestrator + call site

**Files:**
- Modify: `src/campaign.js` — add imports; define a nested `runPreflightHandshake` inside `startCampaign`; call it right before the worker pool (`await Promise.all(...)` at line 3953).

No unit test (requires a real browser); correctness is covered by the Task 1 planner unit tests + manual verification in Task 7. Keep the orchestrator THIN — it delegates all decisions to `src/preflight-handshake.js` and all browser work to existing helpers.

- [ ] **Step 1: Add imports at the top of `src/campaign.js`**

Add to the existing import block:

```js
import { planAccountsNeedingConnect, handshakeProgress, shouldProceed } from './preflight-handshake.js';
import { acceptInvitationFrom } from './linkedin/accept-invitation.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
```

Verify whether `launchProfile`/`closeProfile` (gologin-launcher.js) and `readSelfIdentity` (accept-invitation.js) are already imported — `readSelfIdentity` is used at line 2764 so it is imported; `launchProfile`/`closeProfile` are used by the launcher path — add any that are missing.

- [ ] **Step 2: Define the nested orchestrator inside `startCampaign`**

Place it **after** `runProfileTurn` is defined and **before** the worker pool spawn (immediately above `const workerCount = ...` near line 3952). It closes over `tpl`, `sheetUrl`, `log`, `mode`, `campaign`, `_extractSheetIdFromUrl`, `ensureOpen`, and `profileNameCache` (all in scope at that point — confirm each by reading the surrounding closure).

```js
    // ── Pre-flight primary handshake (CC+IC + auto-accept only) ──────────────
    // Front-load the account↔primary links BEFORE lead outreach: each account
    // connects to the primary, then the primary opens alone to accept. Best-
    // effort — never blocks; stragglers fall to the idle primary-task-runner.
    async function runPreflightHandshake() {
      const primaryUrl = (tpl && tpl.primaryUrl || '').trim();
      if (mode !== 'connect_and_introduce' || !tpl?.autoAcceptPrimary || !primaryUrl) return;

      const participating = (campaign.participatingProfileIds || profileIds || []);
      const need = planAccountsNeedingConnect(participating, campaign._primaryConn);
      if (need.length === 0) return; // everyone already connected — self-eliminating

      campaign.phase = 'preflight';
      log(`🤝 Preparing introductions — ${need.length} account(s) need to connect to the primary`);

      // PHASE 0 — sequential sends (reuse the in-loop pattern at campaign.js:2747-2791)
      const sender = tpl.primarySource || 'local-browser';
      const queuedAccepts = [];
      for (const profileId of need) {
        if (campaign._abort) break;
        const session = await ensureOpen(profileId);          // existing helper: open + health-check
        if (!session) { campaign._primaryConn.set(profileId, 'unverified'); continue; }
        const pName = session.pName;
        try {
          const _res = await checkAndConnectPrimary(session.page, primaryUrl, { log, pName, attemptConnect: true });
          campaign._primaryConn.set(profileId, primaryConnState(_res.connected)); // 'connected' | 'pending' | 'unverified'
          if (_res.connectAttempted && _res.connectResult === 'sent') {
            const _self = await readSelfIdentity(session.page);
            if (_self.name || _self.profileUrl) {
              campaign._primaryConn.set(profileId, 'sent');
              queuedAccepts.push(buildAcceptTask({
                campaignProfileId: profileId, campaignProfileName: pName,
                sheetId: _extractSheetIdFromUrl(sheetUrl) || '', sheetUrl,
                account: _self, primaryUrl, sender,
              }));
            }
          }
        } catch (e) {
          log(`  ⚠ [${pName}] Pre-flight connect error: ${e.message}`);
        } finally {
          // close this account's browser so the next opens alone (one-at-a-time)
          try { await closeProfileSession(profileId); } catch { /* use the codebase's close path */ }
        }
      }

      // PHASE 0.5 — primary accepts, bounded ~2-min poll
      if (queuedAccepts.length) {
        const CAP_MS = 120_000, POLL_MS = 30_000;
        const startedAt = Date.now();
        try {
          await browserSemaphore.acquire();
          const launched = (sender === 'local-browser')
            ? await launchLocalBrowser()
            : await launchProfile(sender, process.env.GOLOGIN_API_TOKEN);
          const page = launched.page;
          let pending = [...queuedAccepts];
          while (pending.length && !campaign._abort) {
            const still = [];
            for (const t of pending) {
              campaign._primaryConn.set(t.campaignProfileId, 'accepting');
              const r = await acceptInvitationFrom(page, t.account, { log }).catch(() => ({ accepted: false }));
              if (r.accepted) { campaign._primaryConn.set(t.campaignProfileId, 'connected'); log(`  ✓ primary accepted ${t.campaignProfileName}`); }
              else { campaign._primaryConn.set(t.campaignProfileId, 'sent'); still.push(t); }
            }
            pending = still;
            const { accepted, total } = handshakeProgress(campaign._primaryConn, queuedAccepts.map(t => t.campaignProfileId));
            if (shouldProceed({ startedAt, now: Date.now(), capMs: CAP_MS, accepted, total })) break;
            if (pending.length) await new Promise(r => setTimeout(r, POLL_MS)); // let stragglers surface
          }
          // stragglers → idle-runner fallback
          for (const t of pending) { try { await enqueuePrimaryTask(t); } catch { /* */ } }
          if (pending.length) log(`  ⏳ ${pending.length} link(s) finishing in the background — outreach starting anyway`);
        } catch (e) {
          log(`  ⚠ Pre-flight: primary accept session failed (${e.message}) — queuing for the idle runner`);
          for (const t of queuedAccepts) { try { await enqueuePrimaryTask(t); } catch { /* */ } }
        } finally {
          try { (sender === 'local-browser') ? await closeLocalBrowser() : await closeProfile(sender); } catch { /* */ }
          browserSemaphore.release();
        }
      }

      log('✅ Primary connections ready — starting outreach');
    }

    try { await runPreflightHandshake(); } finally { campaign.phase = null; }
```

**Implementer notes (must reconcile with the real closures — read 2660–3955 first):**
- `ensureOpen(profileId)` returns `{ page, pName, browser }` or null (see line 2725). Use the codebase's existing per-account **close** path (the same one `runProfileTurn`/the worker `finally` uses) in place of the `closeProfileSession` placeholder — match how a single account browser is closed mid-run.
- `browserSemaphore`, `launchProfile`, `closeProfile`, `buildAcceptTask`, `enqueuePrimaryTask`, `primaryConnState`, `checkAndConnectPrimary`, `readSelfIdentity` are all already imported/used in this file.
- Do **not** duplicate the lead-side logic — Phase 0 mirrors only the connect-to-primary block (2747–2791).

- [ ] **Step 3: Verify the in-loop check now short-circuits**

Confirm the existing block at `campaign.js:2749` (`if (_prev !== 'connected')`) means accounts pre-flight set to `'connected'` are not re-sent in the rotation. No code change — just verify by reading.

- [ ] **Step 4: Syntax check + full suite**

Run: `node --check src/campaign.js && node --test`
Expected: syntax OK; full suite green (no regressions; pre-flight has no unit test of its own).

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js
git commit -m "feat(preflight): run primary handshake before the worker rotation"
```

---

## Task 4: Surface `phase` in the status payload

**Files:**
- Modify: `src/campaign.js` — `getCampaignStatus()` (line 4553 return object).

- [ ] **Step 1: Add the field**

In the object returned by `getCampaignStatus()`, next to `state:` (line 4563), add:

```js
    phase: campaign.phase || null,
```

- [ ] **Step 2: Verify `campaign.phase` initialises cleanly**

Confirm `campaign.phase` is `undefined`/`null` outside pre-flight (it is only set inside `runPreflightHandshake` and cleared in its `finally`). `campaign.phase || null` therefore yields `null` normally. No reset needed at start, but for tidiness set `campaign.phase = null;` near `campaign.state = null;` (line 1670).

- [ ] **Step 3: Full suite (status shape tests)**

Run: `node --test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/campaign.js
git commit -m "feat(preflight): expose campaign.phase in the status payload"
```

---

## Task 5: Card UI — `is-preflight` branch + checklist

**Files:**
- Modify: `public/index.html` — add a checklist container inside `#active-card`.
- Modify: `public/js/app.js` — `renderActiveCard(s)` toggles `is-preflight` and renders the checklist from `s.phase` + `s.primaryConn` + `s.profileNames`.
- Modify: `public/js/live-activity.mjs` — pre-flight beat line.

No automated test (UI) — verified manually in Task 7. Mirror the existing `is-monitor` handling.

- [ ] **Step 1: Add the checklist container to `#active-card`** (after the `vj-live` block, before `vj-hbar` at index.html:211)

```html
        <div class="pf-list" id="active-preflight-list" hidden></div>
```

- [ ] **Step 2: Render in `renderActiveCard`** — find where the card classes are toggled (the `is-monitor` branch). Add, using the same `s` status object:

```js
  // v2.105: pre-flight primary handshake state (gold). Mirrors is-monitor.
  const _isPreflight = s.phase === 'preflight';
  activeCard.classList.toggle('is-preflight', _isPreflight);
  const _pfList = document.getElementById('active-preflight-list');
  if (_pfList) {
    if (_isPreflight) {
      const ICONS = { connected: '✓', accepting: '↻', sent: '•', already_connected: '–', unverified: '•', pending: '•', no_url: '–' };
      const LABEL = { connected: 'accepted by primary', accepting: 'accepting…', sent: 'request sent — waiting', already_connected: 'already connected', unverified: 'could not verify', pending: 'request sent — waiting', no_url: 'no primary URL' };
      const conn = s.primaryConn || {};
      const names = s.profileNames || [];
      const ids = s.participatingProfileIds || s.profileIds || [];
      const rows = ids.filter((id) => id && id !== 'local-browser' && conn[id]).map((id, i) => {
        const st = conn[id]; const nm = names[ids.indexOf(id)] || id;
        const cls = st === 'connected' ? 'pf-done' : st === 'accepting' ? 'pf-active' : (st === 'already_connected' || st === 'no_url') ? 'pf-skip' : 'pf-wait';
        return `<div class="pf-row ${cls}"><span class="pf-ic">${ICONS[st] || '•'}</span><span class="pf-acct">${nm}</span><span class="pf-state">${LABEL[st] || ''}</span></div>`;
      }).join('');
      _pfList.innerHTML = rows;
      _pfList.hidden = !rows;
    } else {
      _pfList.hidden = true; _pfList.innerHTML = '';
    }
  }
```

(Use the actual variable name for the active card element in this function — likely `activeCard`/`card`; confirm by reading the `is-monitor` toggle.)

- [ ] **Step 3: Pre-flight beat in `live-activity.mjs`** — in `buildLiveActivity(status)`, before the running/monitoring branches:

```js
  if (status && status.phase === 'preflight') {
    const conn = status.primaryConn || {};
    const ids = (status.participatingProfileIds || status.profileIds || []).filter((id) => id && id !== 'local-browser' && conn[id]);
    const accepted = ids.filter((id) => conn[id] === 'connected').length;
    return { icon: '↻', l1: 'Preparing introductions — primary handshake', l2: `${accepted} of ${ids.length} connected · outreach starts when ready`, cls: 'is-checking' };
  }
```

(Match the exact return shape `buildLiveActivity` already uses — read it first.)

- [ ] **Step 4: Manual check deferred to Task 7. Commit**

```bash
git add public/index.html public/js/app.js public/js/live-activity.mjs
git commit -m "feat(preflight): render the gold pre-flight card state + checklist"
```

---

## Task 6: CSS — gold `is-preflight` state + checklist (port from sketch)

**Files:**
- Modify: `public/css/dashboard-v0.3.css` — add next to the `.vj-card` / `is-monitor` rules (around line 309–340).

- [ ] **Step 1: Add the styles** (ported from `public/sketches/preflight-visibility.html`)

```css
  /* v2.105 — pre-flight primary handshake (gold; green=running, blue=monitoring) */
  body[data-dashboard='v3'] .vj-card.is-preflight::before { background: var(--gold, #caa24a); }
  body[data-dashboard='v3'] .vj-card.is-preflight .vj-eyebrow .vj-tag .dot { background: var(--gold, #caa24a); }
  body[data-dashboard='v3'] .vj-card.is-preflight .vj-live-ico { color: var(--gold, #caa24a); }
  body[data-dashboard='v3'] .vj-card.is-preflight .vj-hbar > i { background: var(--gold, #caa24a); }
  body[data-dashboard='v3'] .pf-list { grid-area: hero; display: flex; flex-direction: column; gap: 2px; }
  body[data-dashboard='v3'] .pf-list[hidden] { display: none; }
  body[data-dashboard='v3'] .pf-row { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 12px; padding: 9px 2px; border-bottom: 1px solid var(--hairline-soft, rgba(0,0,0,.06)); }
  body[data-dashboard='v3'] .pf-row:last-child { border-bottom: none; }
  body[data-dashboard='v3'] .pf-ic { font-family: var(--mono); text-align: center; font-size: 0.95rem; }
  body[data-dashboard='v3'] .pf-acct { color: var(--ink); font-weight: 500; }
  body[data-dashboard='v3'] .pf-state { font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.04em; color: var(--gray); }
  body[data-dashboard='v3'] .pf-done .pf-ic { color: var(--green, #1a7f4b); }
  body[data-dashboard='v3'] .pf-active .pf-ic { color: var(--gold, #caa24a); }
  body[data-dashboard='v3'] .pf-wait .pf-ic { color: var(--gray); }
  body[data-dashboard='v3'] .pf-skip .pf-ic, body[data-dashboard='v3'] .pf-skip .pf-acct, body[data-dashboard='v3'] .pf-skip .pf-state { color: var(--gray-faint, #b8b8b6); }
```

- [ ] **Step 2: Commit**

```bash
git add public/css/dashboard-v0.3.css
git commit -m "style(preflight): gold pre-flight card state + checklist"
```

---

## Task 7: Version bump, relaunch, manual verification

**Files:**
- Modify: `package.json`, `package-lock.json` → `2.105.0`.

- [ ] **Step 1: Bump version**

```bash
node -e 'const fs=require("fs");for(const f of ["package.json","package-lock.json"]){const j=JSON.parse(fs.readFileSync(f,"utf8"));if(j.version)j.version="2.105.0";if(j.packages&&j.packages[""]&&j.packages[""].version)j.packages[""].version="2.105.0";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");}console.log("version ->",JSON.parse(fs.readFileSync("package.json","utf8")).version);'
```

- [ ] **Step 2: Full suite + relaunch**

```bash
node --test 2>&1 | tail -8
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
until grep -q "Dashboard:" /tmp/dev-app.log 2>/dev/null; do :; done
grep -E "Ortus Outreach v|Dashboard:" /tmp/dev-app.log | tail -2
```
Expected: full suite green; boots `v2.105.0`.

- [ ] **Step 3: Manual verification (operator)**

A CC+IC campaign with auto-accept ON and at least one account NOT yet connected to the primary:
1. On Start, the campaign card shows the **gold PRE-FLIGHT** state with the per-account checklist (✓/↻/•/–) and the live beat.
2. Live log shows: `🤝 Preparing introductions…` → `✓ primary accepted <account>` → `✅ Primary connections ready — starting outreach`.
3. The card then morphs into the normal running state and outreach begins.
4. Re-running the same campaign (accounts now connected) skips pre-flight entirely.
5. Force a "Take care when connecting" account and confirm the invite actually accepts (no longer stuck pending).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump to 2.105.0 — pre-flight primary handshake"
```

---

## Self-review notes (author)

- **Spec coverage:** Phases 0/0.5/1 → Task 3; bounded poll + fallback → Task 3 (`shouldProceed`, `enqueuePrimaryTask`); confirm modal → Task 2; scope gating (CC+IC + autoAccept) → Task 3 Step 2 guard; status `phase` → Task 4; Variant C UI → Tasks 5–6; pure planner → Task 1; self-eliminating → Task 1 `planAccountsNeedingConnect` + Task 3 early return; IC out of scope → Task 3 mode guard. ✓
- **Off-limits:** `outreach.js`/`actions.js` untouched across all tasks. ✓
- **Type/name consistency:** `planAccountsNeedingConnect`, `handshakeProgress`, `shouldProceed`, `checklistRow` used identically in Tasks 1/3/5; state vocabulary (`connected`/`accepting`/`sent`/`already_connected`/`unverified`) consistent across planner, orchestrator, and UI. ✓
- **Known soft spots flagged for the implementer:** the exact single-account close path in Task 3 (placeholder `closeProfileSession` → use the codebase's real close), and the exact `renderActiveCard`/`buildLiveActivity` variable names + return shapes — all marked "read first."
