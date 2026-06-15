# Local-Browser Re-Login Recovery — Implementation Plan

> **For agentic workers:** execute task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Recover a local-browser LinkedIn session-expiry in place (browser on-screen +
in-app "Done" popup, resume on Done-or-auto-detect, 5-min park ceiling) instead of
hard-parking. GoLogin unchanged.

**Architecture:** New campaign-loop helper `awaitLocalLogin` + pure decision helper
`decideLoginWaitAction`, a `confirmLogin()` flag setter exposed via a new server route, and
a status-poll-driven modal. Spec: `docs/superpowers/specs/2026-06-15-local-browser-relogin-recovery-design.md`.

**Tech stack:** Node ≥22, Express 4, puppeteer-core (CDP), vanilla JS UI, `node --test`.

---

### Task 1: Pure decision helper + state fields

**Files:**
- Modify: `src/campaign.js` (campaign object ~531; add helper + export)
- Test: `tests/local-login-wait.test.js`

- [ ] **Step 1 — failing test** `tests/local-login-wait.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLoginWaitAction } from '../src/campaign.js';

test('logged in → resume regardless of elapsed', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 0, loggedIn: true, maxMs: 300000 }), 'resume');
  assert.equal(decideLoginWaitAction({ elapsedMs: 999999, loggedIn: true, maxMs: 300000 }), 'resume');
});
test('not logged in, before deadline → wait', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 60000, loggedIn: false, maxMs: 300000 }), 'wait');
});
test('not logged in, at/after deadline → timeout', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 300000, loggedIn: false, maxMs: 300000 }), 'timeout');
  assert.equal(decideLoginWaitAction({ elapsedMs: 300001, loggedIn: false, maxMs: 300000 }), 'timeout');
});
```

- [ ] **Step 2 — run, expect fail** `node --test tests/local-login-wait.test.js` → fails (not exported).
- [ ] **Step 3 — implement.** Add to `src/campaign.js` (module scope):

```js
export const LOCAL_LOGIN_MAX_WAIT_MS = 5 * 60 * 1000; // 5-min walked-away ceiling

/** Pure: decide whether to resume, keep waiting, or give up the local-login wait. */
export function decideLoginWaitAction({ elapsedMs, loggedIn, maxMs = LOCAL_LOGIN_MAX_WAIT_MS }) {
  if (loggedIn) return 'resume';
  if (elapsedMs >= maxMs) return 'timeout';
  return 'wait';
}
```

Add two fields to the `campaign` object (near `parkedProfiles: [],`):

```js
  // Local-browser re-login recovery (2026-06-15). _loginDone flips when the
  // operator clicks "Done" in the popup; awaitLocalLogin reads + resets it.
  _loginDone: false,
  // When set, the UI shows the "log into LinkedIn" popup. { profileId, pName, since }.
  awaitingLogin: null,
```

- [ ] **Step 4 — run, expect pass.** `node --test tests/local-login-wait.test.js`
- [ ] **Step 5 — commit** `feat(relogin): pure decideLoginWaitAction + campaign state fields`

---

### Task 2: confirmLogin() + getCampaignStatus surfacing

**Files:** Modify `src/campaign.js`; Test `tests/relogin-status.test.js`

- [ ] **Step 1 — failing test** `tests/relogin-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign, confirmLogin, getCampaignStatus } from '../src/campaign.js';

test('confirmLogin sets _loginDone', () => {
  campaign._loginDone = false;
  confirmLogin();
  assert.equal(campaign._loginDone, true);
});
test('getCampaignStatus surfaces awaitingLogin', () => {
  campaign.awaitingLogin = { profileId: 'local-browser', pName: 'You', since: 1 };
  assert.deepEqual(getCampaignStatus().awaitingLogin, { profileId: 'local-browser', pName: 'You', since: 1 });
  campaign.awaitingLogin = null;
  assert.equal(getCampaignStatus().awaitingLogin, null);
});
```

- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** Add export:

```js
/** Operator clicked "Done" in the re-login popup. */
export function confirmLogin() { campaign._loginDone = true; return { ok: true }; }
```

In `getCampaignStatus()` return object, add: `awaitingLogin: campaign.awaitingLogin || null,`

- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** `feat(relogin): confirmLogin() + awaitingLogin in status`

---

### Task 3: awaitLocalLogin helper (the recovery loop)

**Files:** Modify `src/campaign.js` (add helper near `checkProfileHealth`, ~line 953).
No new unit test (browser/CDP I/O); covered by Task 1 decision logic + manual verification.

- [ ] **Step 1 — implement** `awaitLocalLogin(page, profileId, pName)`:
  - Best-effort bring window on-screen: `page.target().createCDPSession()` →
    `Browser.getWindowForTarget` → `Browser.setWindowBounds {left:100,top:100,width:1366,height:900,windowState:'normal'}` (wrap in try/catch).
  - `campaign.awaitingLogin = { profileId, pName, since: Date.now() }; campaign._loginDone = false;`
  - `const start = Date.now();`
  - Loop: every 3s (`await setTimeout`):
    - `if (campaign._abort) { action = 'timeout'; break; }`
    - Recompute current page: `try { const ps = await page.browser().pages(); if (ps.length) page = ps[ps.length-1]; } catch {}`
    - `let loggedIn = false;` then `try { const u = page.url(); if (u.includes('linkedin.com') && !u.includes('/login') && !u.includes('/authwall') && !u.includes('/checkpoint')) loggedIn = true; } catch {}`
    - If not loggedIn AND `campaign._loginDone`: do a health recheck —
      `const h = await checkProfileHealth(page, pName); loggedIn = !!h.healthy;` and if still
      not healthy `log(\`  ⏳ ${pName}: not logged in yet — finish login, then click Done.\`); campaign._loginDone = false;`
    - `const action = decideLoginWaitAction({ elapsedMs: Date.now()-start, loggedIn });`
    - `if (action === 'resume') { ...success... } if (action === 'timeout') { ...break... }`
    - Heartbeat log every ~30s: `Still waiting for ${pName} login… (${sec}s)`
  - On resume: move window off-screen (`Browser.setWindowBounds {left:-2400,top:-2400}`),
    `log(\`✓ ${pName}: re-logged in — resuming.\`)`, `campaign.awaitingLogin = null;` return `{ ok: true, page }`.
  - On timeout: `log(\`✗ ${pName}: login not completed within 5 min — parking account.\`)`,
    `campaign.awaitingLogin = null;` return `{ ok: false, page }`.

- [ ] **Step 2 — run full suite** `node --test tests/*.test.js` (no regressions).
- [ ] **Step 3 — commit** `feat(relogin): awaitLocalLogin recovery loop`

---

### Task 4: Wire at-open site (ensureProfileLoggedIn)

**Files:** Modify `src/campaign.js:1018` and the `local-browser` branch (~1023).

- [ ] **Step 1 — gate the early return** (line 1018):

```js
if (health.sessionExpired && profileId !== 'local-browser') {
  log(`✗ ${pName}: session expired — parking profile for rest of run.`);
  return { page: null, ok: false, sessionExpired: true };
}
```

- [ ] **Step 2 — inside `if (!health.healthy)` → `if (profileId === 'local-browser')`**, add a
  session-expiry sub-branch BEFORE the existing 120s loop:

```js
if (health.sessionExpired) {
  log(`⚠ ${pName}: session expired — opening browser for you to log in.`);
  const r = await awaitLocalLogin(page, profileId, pName);
  if (!r.ok) return { page: null, ok: false, sessionExpired: true };
  page = r.page || page;
} else {
  /* existing 120s local-browser login-wait — UNCHANGED */
  ...
}
```

(The non-session-expired `else` keeps the current code verbatim.)

- [ ] **Step 3 — run suite** `node --test tests/*.test.js`.
- [ ] **Step 4 — commit** `fix(relogin): at-open local session-expiry routes to login wait`

---

### Task 5: Wire mid-run site (batch loop ~3208)

**Files:** Modify `src/campaign.js:3208`.

- [ ] **Step 1 — wrap the park block** so local-browser tries recovery first:

```js
if (isSessionExpired && !weeklyLimited.has(profileId)) {
  let recovered = false;
  if (profileId === 'local-browser') {
    log(`  ⚠ ${pName}: session expired mid-run — opening browser for you to log in.`);
    const r = await awaitLocalLogin(page, profileId, pName);
    recovered = r.ok;
    if (recovered) page = r.page || page;
  }
  if (!recovered) {
    log(`  ⚠ ${pName}: session expired — parking account for rest of run (re-login required).`);
    weeklyLimited.add(profileId);
    recordProfileEnd(profileId, pName, 'Session expired — log in again');
    campaign.parkedProfiles.push({ profileId, pName, parkedAt: Date.now(), reason: 'session_expired' });
    await setAccountNeedsLogin(pName, true);
    await markSoONeedsLogin(pName);
  } else {
    log(`  ✓ ${pName}: re-logged in — staying in rotation.`);
  }
}
```

- [ ] **Step 2 — run suite** `node --test tests/*.test.js`.
- [ ] **Step 3 — commit** `fix(relogin): mid-run local session-expiry routes to login wait`

---

### Task 6: Server route

**Files:** Modify `server.js` (import + route near the other `/api/campaign/*` routes).

- [ ] **Step 1 — import** `confirmLogin` from `./src/campaign.js` (add to existing import).
- [ ] **Step 2 — route:**

```js
app.post('/api/campaign/login-done', (_req, res) => {
  res.json(confirmLogin());
});
```

- [ ] **Step 3 — commit** `feat(relogin): POST /api/campaign/login-done`

---

### Task 7: UI — popup + poll wiring

**Files:** Modify `public/index.html` (modal), `public/js/app.js` (show/hide + Done).

- [ ] **Step 1 — modal** in `index.html` (clone `#campaign-done-modal`, id `login-recover-modal`):

```html
<div id="login-recover-modal" class="modal-backdrop hidden">
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="login-recover-title">
    <span class="ptm-pill">LOG IN REQUIRED</span>
    <h3 id="login-recover-title" class="modal-title">Log into LinkedIn</h3>
    <div id="login-recover-body" class="modal-body"></div>
    <div class="modal-actions" style="flex-direction: column; gap: 10px; align-items: stretch;">
      <button type="button" class="btn btn-start" onclick="confirmLoginDone()">Done — I've logged in</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2 — app.js** add `maybeShowLoginModal(s)` and call it inside `pollStatus()` next to
  `maybeShowCampaignDoneModal`:

```js
function maybeShowLoginModal(s) {
  const modal = document.getElementById('login-recover-modal');
  if (!modal) return;
  if (s && s.awaitingLogin) {
    const who = s.awaitingLogin.pName || 'your account';
    document.getElementById('login-recover-body').innerHTML =
      `<b>${who}</b>'s LinkedIn session expired. The browser window has opened on-screen — ` +
      `log into LinkedIn there, then click <b>Done</b>. (It also resumes automatically once you're back in.)`;
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

async function confirmLoginDone() {
  try { await fetch('/api/campaign/login-done', { method: 'POST' }); } catch {}
  document.getElementById('login-recover-modal').classList.add('hidden');
}
```

- [ ] **Step 3 — commit** `feat(relogin): in-app login popup wired to status poll`

---

### Task 8: Version bump + relaunch + manual verification

- [ ] **Step 1 — bump** `package.json` 2.95.0 → 2.95.1.
- [ ] **Step 2 — full suite** `node --test tests/*.test.js` (green).
- [ ] **Step 3 — relaunch** `pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; npm run dev:app > /tmp/dev-app.log 2>&1 &`
- [ ] **Step 4 — manual checklist (operator):** local-browser session expiry → popup + browser
  on-screen; Done resumes; auto-detect resumes; 5-min no-response parks + Needs Login.
- [ ] **Step 5 — commit** `chore: bump to 2.95.1 (local re-login recovery)`
