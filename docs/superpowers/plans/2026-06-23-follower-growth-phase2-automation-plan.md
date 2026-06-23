# Follower Growth Phase 2 — Invite Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Automate the "Invite to follow" click — a dedicated module drives the operator's GoLogin browser to open the page invite modal, read the live credit balance, select the queued (name/headline-verified) people up to that cap, click Invite, and mark them `Invited`.

**Architecture:** New self-contained `src/linkedin/follower-invite.js` (pure helpers + page-driving fns + orchestrator), modeled on `post-amplification.js`, reusing only shared `helpers.js` + `launchProfile`. New `/api/fg/send/*` routes mirror `/api/post-amplification/*`. A "Send invites automatically" button + status strip in the FG workspace. **Never touches `outreach.js` / `actions.js`.**

**Tech Stack:** Node ≥22, puppeteer-core (GoLogin Orbita), Express 4, vanilla JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-23-follower-growth-phase2-automation-design.md`

## Exact LinkedIn modal selectors (captured from live DOM 2026-06-23)

```
Open modal     : navigate to  https://www.linkedin.com/company/<ORTUS_SLUG>/?invite=true
                 (fallback: click button[aria-label="Invite connections to follow page"])
Modal root     : div[data-test-modal-id="invite-to-follow-picker"]
Credits text   : node within modal whose text matches /(\d+)\s*\/\s*\d+\s*credits available/i  (group 1 = available)
Search input   : input.artdeco-typeahead__input   (placeholder/aria-label "Search by name")
Results list   : ul.artdeco-typeahead__results-list[role="listbox"]
Result item    : li[role="option"].artdeco-typeahead__result
Invitable flag : li contains .invitee-picker-connections-result-item--can-invite
Result text    : li innerText = "<Name>\n1st • <Headline>"  (split on degree "1st •/2nd •/3rd •")
Invite button  : within #credit-info-footer-container, button.artdeco-button--primary
                 whose span.artdeco-button__text starts with "Invite"  (disabled when 0 selected)
Close          : button[aria-label="Dismiss"]
Note           : selections PERSIST across searches (right-hand pane) → select all, click Invite ONCE.
```

---

## Task 1: Pure decision helpers (`follower-invite.js`)

**Files:**
- Create: `src/linkedin/follower-invite.js`
- Test: `tests/linkedin/follower-invite.test.js`

- [ ] **Step 1: Write the failing test** — `tests/linkedin/follower-invite.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditsAvailable, headlineMatches, pickInviteResult } from '../../src/linkedin/follower-invite.js';

test('parseCreditsAvailable reads the leading number', () => {
  assert.equal(parseCreditsAvailable('30/30 credits available · Credit refill: June 30, 2026'), 30);
  assert.equal(parseCreditsAvailable('7 / 30 credits available'), 7);
  assert.equal(parseCreditsAvailable('no credits text'), 0);
  assert.equal(parseCreditsAvailable(''), 0);
});

test('headlineMatches: company token or significant title word', () => {
  assert.equal(headlineMatches('Head of Marketing at ADAC', { jobTitle: 'Head of Marketing', company: 'ADAC' }), true);
  assert.equal(headlineMatches('Strategy Manager @ Sector Alarm', { jobTitle: 'VP Growth', company: 'Globex' }), false);
  assert.equal(headlineMatches('Chief Growth Officer', { jobTitle: 'VP Growth', company: '' }), true); // "growth"
  assert.equal(headlineMatches('', { jobTitle: 'Marketing', company: 'X' }), false);
});

test('pickInviteResult: single name match selected without headline', () => {
  const results = [{ name: 'Mara Lee', headline: 'Barista', canInvite: true }];
  const r = pickInviteResult(results, { name: 'Mara Lee', jobTitle: 'Head of Marketing', company: 'Acme' });
  assert.equal(r, results[0]); // unique name → selected even though headline is unrelated
});

test('pickInviteResult: duplicate names disambiguated by headline', () => {
  const results = [
    { name: 'John Smith', headline: 'Chef at Bistro', canInvite: true },
    { name: 'John Smith', headline: 'Head of Marketing at Acme', canInvite: true },
  ];
  const r = pickInviteResult(results, { name: 'John Smith', jobTitle: 'Head of Marketing', company: 'Acme' });
  assert.equal(r, results[1]);
});

test('pickInviteResult: ambiguous duplicates → null (skip)', () => {
  const results = [
    { name: 'John Smith', headline: 'Marketing Lead at Acme', canInvite: true },
    { name: 'John Smith', headline: 'Marketing Director at Acme', canInvite: true },
  ];
  assert.equal(pickInviteResult(results, { name: 'John Smith', jobTitle: 'Marketing', company: 'Acme' }), null);
});

test('pickInviteResult: non-invitable + zero matches → null', () => {
  assert.equal(pickInviteResult([{ name: 'Mara Lee', headline: 'x', canInvite: false }], { name: 'Mara Lee' }), null);
  assert.equal(pickInviteResult([], { name: 'Nobody' }), null);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/linkedin/follower-invite.test.js` (module not found).

- [ ] **Step 3: Implement the pure helpers** — top of `src/linkedin/follower-invite.js`:

```js
// Follower Growth Phase 2 — automates the LinkedIn page "Invite to follow" modal.
// Self-contained module (mirrors post-amplification.js); reuses only shared
// helpers.js + the launcher. Does NOT touch outreach.js / actions.js.

// "30/30 credits available · …" → 30 (the LEADING number = currently available).
export function parseCreditsAvailable(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*\d+\s*credits available/i);
  return m ? Number(m[1]) : 0;
}

// Used ONLY to disambiguate duplicate same-name results. true if the headline
// contains the company token, or a significant (≥4-char, non-generic) job-title word.
const TITLE_STOP = new Set(['head', 'senior', 'chief', 'lead', 'manager', 'director', 'officer', 'global', 'group', 'team']);
export function headlineMatches(headline, { jobTitle = '', company = '' } = {}) {
  const h = (headline || '').toLowerCase();
  if (!h) return false;
  const co = (company || '').toLowerCase().trim();
  if (co.length >= 3 && h.includes(co)) return true;
  const words = (jobTitle || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w));
  return words.some((w) => h.includes(w));
}

// Decide which search result to select for a queued person.
// results: [{ name, headline, canInvite }]. Returns the chosen result or null (skip).
// Rule: among invitable results whose name matches — exactly one → take it (no
// headline check); several → the one whose headline verifies; else (0 or >1) → null.
export function pickInviteResult(results, person) {
  const target = (person && person.name || '').trim().toLowerCase();
  if (!target) return null;
  const byName = (results || []).filter((r) => r.canInvite && (r.name || '').trim().toLowerCase() === target);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) return null;
  const verified = byName.filter((r) => headlineMatches(r.headline, { jobTitle: person.jobTitle, company: person.company }));
  return verified.length === 1 ? verified[0] : null;
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/linkedin/follower-invite.test.js` (6 tests pass).
- [ ] **Step 5: Commit**

```bash
git add src/linkedin/follower-invite.js tests/linkedin/follower-invite.test.js
git commit -m "feat(fg): Phase 2 pure match helpers (credits, headline, pickInviteResult)"
```

---

## Task 2: Page-driving functions + orchestrator (`follower-invite.js`)

**Files:**
- Modify: `src/linkedin/follower-invite.js` (append the page fns + `runFollowerInvites`)
- Test: `tests/linkedin/follower-invite-run.test.js` (orchestrator via a fake page)

- [ ] **Step 1: Write the failing orchestrator test** — drives `runFollowerInvites` with a fake page object that records calls and returns scripted results, asserting: respects the credit cap, selects matches, skips ambiguous, clicks Invite once, returns the invited memberIds.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFollowerInvites } from '../../src/linkedin/follower-invite.js';

// Fake page: each searchAndMatch is simulated by a scripted results map keyed by name.
function fakePage(resultsByName) {
  const calls = { searches: [], invited: 0 };
  return {
    calls,
    __resultsByName: resultsByName,
    // injected seam: the module calls these (see implementation deps option)
  };
}

test('runFollowerInvites caps at credits, selects, skips ambiguous, invites once', async () => {
  const queued = [
    { name: 'Mara Lee', jobTitle: 'Head of Marketing', company: 'Acme', memberId: '1' }, // select
    { name: 'Dan Roe', jobTitle: 'Brand Lead', company: 'Initech', memberId: '2' },      // select
    { name: 'Amb Ig', jobTitle: 'Marketing', company: 'X', memberId: '3' },              // skip (no match)
    { name: 'Phil Roe', jobTitle: 'Growth', company: 'Z', memberId: '4' },               // select (fills 3rd credit)
    { name: 'Quinn Vee', jobTitle: 'CMO', company: 'Y', memberId: '5' },                 // never reached (cap hit)
  ];
  const calls = { invites: 0 };
  const deps = {
    readCredits: async () => 3,
    selectPerson: async (_page, person) => person.name !== 'Amb Ig', // ambiguous one returns false
    clickInvite: async () => { calls.invites += 1; return true; },
    sleep: async () => {},
  };
  const res = await runFollowerInvites({ page: {}, queued, log: () => {}, shouldAbort: () => false, deps });
  assert.deepEqual(res.invited, ['1', '2', '4']); // 3 selected, in order, fills the 3-credit cap
  assert.deepEqual(res.skipped, ['3']);           // ambiguous skipped (skips don't consume credit)
  assert.ok(!res.invited.includes('5') && !res.skipped.includes('5')); // never reached — cap hit before it
  assert.equal(res.creditsBefore, 3);
  assert.equal(res.creditsAfter, 0);
  assert.equal(calls.invites, 1);                 // Invite clicked exactly once
});

test('runFollowerInvites: nothing selected → no Invite click, all reported skipped', async () => {
  const deps = { readCredits: async () => 5, selectPerson: async () => false, clickInvite: async () => { throw new Error('should not click'); }, sleep: async () => {} };
  const res = await runFollowerInvites({ page: {}, queued: [{ name: 'A', memberId: '1' }], deps });
  assert.deepEqual(res.invited, []);
  assert.deepEqual(res.skipped, ['1']);
  assert.equal(res.sent, false);
});
```

> Implementation note for Step 3: `runFollowerInvites` takes an optional `deps` object (`{ readCredits, selectPerson, clickInvite, sleep }`) defaulting to the real page-driven implementations, so the orchestrator loop is unit-testable without a browser. The loop tries queued people in order, stops once it has selected `creditsBefore` people (cap), counts skips, and clicks Invite once if ≥1 selected.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement page fns + orchestrator** — append to `src/linkedin/follower-invite.js`:

```js
import { randomDelay } from './helpers.js';

const SEL = {
  modal: 'div[data-test-modal-id="invite-to-follow-picker"]',
  search: 'input.artdeco-typeahead__input',
  result: 'ul.artdeco-typeahead__results-list[role="listbox"] li[role="option"]',
  dismiss: 'button[aria-label="Dismiss"]',
};
const DEGREE_RE = /\b(1st|2nd|3rd)\s*•\s*/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openInviteModal(page, inviteUrl, { log = () => {} } = {}) {
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(SEL.modal, { timeout: 15000 });
  log('invite modal open');
  return { ok: true };
}

export async function readCredits(page) {
  const txt = await page.$$eval(`${SEL.modal} *`, (els) => {
    const hit = els.find((e) => /\d+\s*\/\s*\d+\s*credits available/i.test(e.textContent || '') && e.children.length === 0);
    return hit ? hit.textContent : '';
  }).catch(() => '');
  return parseCreditsAvailable(txt);
}

export async function scrapeResults(page) {
  return page.$$eval(SEL.result, (lis) => lis.map((li) => {
    const text = (li.innerText || '').trim();
    const canInvite = !!li.querySelector('.invitee-picker-connections-result-item--can-invite');
    const m = text.match(/\b(?:1st|2nd|3rd)\s*•\s*/);
    const name = (m ? text.slice(0, m.index) : text).split('\n')[0].trim();
    const headline = m ? text.slice(m.index).replace(/^\s*(?:1st|2nd|3rd)\s*•\s*/, '').trim() : '';
    return { name, headline, canInvite };
  })).catch(() => []);
}

// Type a name, wait for results, decide via pickInviteResult, click the chosen row.
export async function selectPerson(page, person, { log = () => {} } = {}) {
  await page.click(SEL.search, { clickCount: 3 }).catch(() => {});
  await page.type(SEL.search, person.name, { delay: 40 });
  await sleep(await randomDelay(900, 1600));
  const results = await scrapeResults(page);
  const choice = pickInviteResult(results, person);
  if (!choice) { log(`skip "${person.name}" (${results.length} results, no confident match)`); return false; }
  // Click the li whose name matches the chosen result (first occurrence).
  const clicked = await page.evaluate((sel, targetName) => {
    const lis = [...document.querySelectorAll(sel)];
    const li = lis.find((l) => (l.innerText || '').trim().toLowerCase().startsWith(targetName.toLowerCase()));
    if (!li) return false;
    const box = li.querySelector('input[type="checkbox"], [role="checkbox"]') || li;
    box.click();
    return true;
  }, SEL.result, choice.name);
  log(`${clicked ? 'selected' : 'click-miss'} "${person.name}"`);
  return clicked;
}

export async function clickInvite(page, { log = () => {} } = {}) {
  const ok = await page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return false;
    const btn = [...modal.querySelectorAll('button.artdeco-button--primary')]
      .find((b) => /invite/i.test((b.querySelector('.artdeco-button__text') || b).textContent || ''));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, SEL.modal);
  log(ok ? 'clicked Invite' : 'Invite button not clickable');
  return ok;
}

// Orchestrator. `deps` is a test seam (defaults to the real page fns above).
export async function runFollowerInvites({ page, inviteUrl, queued = [], log = () => {}, shouldAbort = () => false, deps } = {}) {
  const d = {
    openModal: openInviteModal, readCredits, selectPerson, clickInvite, sleep,
    ...(deps || {}),
  };
  if (inviteUrl) await d.openModal(page, inviteUrl, { log }); // real runs pass inviteUrl; unit tests omit it
  const creditsBefore = await d.readCredits(page);
  log(`credits available: ${creditsBefore}`);
  const invited = [], skipped = [];
  for (const person of queued) {
    if (shouldAbort()) { log('aborted'); break; }
    if (invited.length >= creditsBefore) { log('credit cap reached'); break; }
    const ok = await d.selectPerson(page, person, { log });
    (ok ? invited : skipped).push(person.memberId);
    await d.sleep(await randomDelay(700, 1400));
  }
  let sent = false;
  if (invited.length) sent = await d.clickInvite(page, { log });
  const creditsAfter = sent ? Math.max(0, creditsBefore - invited.length) : creditsBefore;
  return { invited: sent ? invited : [], skipped: sent ? skipped : skipped.concat(invited), creditsBefore, creditsAfter, sent };
}
```

> The orchestrator uses `parseCreditsAvailable`/`pickInviteResult` from the same file (defined in Task 1). `deps` is the unit-test seam (defaults to the real page fns). The modal is opened only when `inviteUrl` is passed, so unit tests (which omit `inviteUrl` and pass `page: {}`) never touch a browser.

- [ ] **Step 4: Run both follower-invite tests; confirm pass. Then `node --check src/linkedin/follower-invite.js`.**
- [ ] **Step 5: Commit** — `git add src/linkedin/follower-invite.js tests/linkedin/follower-invite-run.test.js && git commit -m "feat(fg): Phase 2 modal-driving fns + runFollowerInvites orchestrator"`

---

## Task 3: Routes + config + wiring (`server.js`, `sheets-webapp-url.js`)

**Files:**
- Modify: `src/sheets-webapp-url.js` (add `ORTUS_PAGE_INVITE_URL`)
- Modify: `server.js` (import the module; add `/api/fg/send/start|stop|status`)

- [ ] **Step 1: Add the invite-URL constant** to `src/sheets-webapp-url.js`:

```js
// Follower Growth Phase 2 — the Ortus Club page "Invite to follow" modal URL.
// CONFIRM the exact page slug. <ORTUS_SLUG> placeholder — replace before live use.
export const ORTUS_PAGE_INVITE_URL = 'https://www.linkedin.com/company/<ORTUS_SLUG>/?invite=true';
```

- [ ] **Step 2: Add routes** to `server.js`, modeled on `/api/post-amplification/*` (study that block first). Sketch:

```js
import { runFollowerInvites } from './src/linkedin/follower-invite.js';
import { ORTUS_PAGE_INVITE_URL } from './src/sheets-webapp-url.js';
// (getFgState, markFgInvited already imported from fg-sync.js)

let _fgSend = { running: false, phase: 'idle', invited: 0, skipped: 0, creditsBefore: null, creditsAfter: null, error: null };
let _fgAbort = false;

app.get('/api/fg/send/status', (_req, res) => res.json(_fgSend));
app.post('/api/fg/send/stop', (_req, res) => { _fgAbort = true; res.json({ ok: true }); });

app.post('/api/fg/send/start', async (req, res) => {
  if (_fgSend.running) return res.status(409).json({ error: 'A send is already running.' });
  const b = req.body || {};
  const profileId = b.profileId;            // operator's GoLogin profile (picked in UI)
  const operator = b.operator;
  if (!profileId || !operator) return res.status(400).json({ error: 'profileId and operator are required' });
  const month = b.month || new Date().toISOString().slice(0, 7);
  res.json({ started: true });              // respond immediately; run in background
  _fgSend = { running: true, phase: 'launching', invited: 0, skipped: 0, creditsBefore: null, creditsAfter: null, error: null };
  _fgAbort = false;
  (async () => {
    let launched;
    try {
      const { invites } = await getFgState();
      const queued = (invites || [])
        .filter((r) => r['Status'] === 'Queued' && r['Account'] === operator)
        .map((r) => ({ name: r['Target Name'], jobTitle: r['Job Title'], company: r['Company'], memberId: String(r['Member ID'] || '') }));
      launched = await launchProfile(profileId, GOLOGIN_API_TOKEN); // reuse the app's token resolution
      const page = launched.page;            // match launchProfile's return shape
      _fgSend.phase = 'inviting';
      const out = await runFollowerInvites({
        page, inviteUrl: ORTUS_PAGE_INVITE_URL, queued,
        log: (m) => { campaignLog(`[FG-invite] ${m}`); },
        shouldAbort: () => _fgAbort,
      });
      _fgSend = { ...(_fgSend), ...out, running: true, phase: 'marking' };
      if (out.invited.length) await markFgInvited({ memberIds: out.invited, account: operator, operator, month });
      _fgSend = { running: false, phase: 'done', invited: out.invited.length, skipped: out.skipped.length, creditsBefore: out.creditsBefore, creditsAfter: out.creditsAfter, error: null };
    } catch (err) {
      _fgSend = { ..._fgSend, running: false, phase: 'error', error: err.message };
    } finally {
      try { if (launched) await closeProfile(profileId); } catch (_) {}
    }
  })();
});
```

> Match the REAL `launchProfile` return shape and token var used by the post-amplification route (`/api/post-amplification/start`) — copy that block's launch/teardown exactly (`preventSleep`, profile pid, `closeProfile`). Wire `campaignLog`/logging the same way.

- [ ] **Step 3:** `node --check server.js`; run full test suite (`node --test tests/**/*.test.js` — adjust glob to the repo's pattern). Confirm no regressions.
- [ ] **Step 4: Commit** — `git add src/sheets-webapp-url.js server.js && git commit -m "feat(fg): /api/fg/send routes + invite-URL config"`

---

## Task 4: UI — "Send invites automatically" button + status strip

**Files:** Modify `public/index.html`, `public/js/app.js`, `public/css/style.css` (done directly — tightly-coupled UI).

- [ ] **Step 1:** In the FG workspace step 2 (`index.html`), add a **"Send invites automatically"** button next to Queue / Mark, plus a hidden status strip `#fg-send-status`.
- [ ] **Step 2:** In `app.js`, add `fgSendStart()` (POST `/api/fg/send/start` with `{ operator, profileId }` — `profileId` from the account picker / operator's selected account), `fgSendPoll()` (GET `/api/fg/send/status`, render phase + "invited N · skipped M · credits X→Y", stop polling on `done`/`error`, then `fgLoadDb()`), `fgSendStop()`. Mirror the post-amplification polling helpers.
- [ ] **Step 3:** CSS for the status strip (monochrome).
- [ ] **Step 4: Manual verify** — `npm run dev:app`; FG mode shows the button; clicking with no queued rows is disabled/toasts; with the dev cache, the button calls the route (full run validated in the calibration run).
- [ ] **Step 5: Commit** — `git add public/index.html public/js/app.js public/css/style.css && git commit -m "feat(fg): Send-invites-automatically button + live status"`

---

## Task 5: Version bump, relaunch, calibration run

- [ ] Bump `package.json` (→ `2.114.0`, new feature).
- [ ] Relaunch `dev:app` (operator rule).
- [ ] **Calibration run (with Antonio):** confirm `ORTUS_PAGE_INVITE_URL` slug is set; queue a small test batch for one operator; click "Send invites automatically"; watch the `[FG-invite]` log lines (modal open, credits read, each select/skip, Invite click). Tune any selector that logs a miss. This is the expected one-time DOM calibration.
- [ ] Commit the version bump.

---

## Out of scope / open items
- Exact **Ortus Club page slug** (fill `ORTUS_PAGE_INVITE_URL`).
- Operator-email → GoLogin-profileId resolution (UI passes the picked `profileId`; reuse the existing account picker mapping).
- Multi-operator parallel sends; follow-conversion tracking; scheduled sends (all later).
