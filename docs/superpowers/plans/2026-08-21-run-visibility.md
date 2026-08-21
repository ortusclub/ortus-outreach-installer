# Run Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it obvious, at a glance and from across the room, what a campaign is doing right now, on both this Mac and the Cloud VM, and let the operator stop a check that is in flight.

**Architecture:** Three independent layers, built bottom-up. First the polling fix and the stop path, because without live polling nothing else can be seen and without stop the operator's only exit is quitting the app. Then one banner component on the card's existing `.vj-live` band, worn by three states (checking, sending, handover). Then the per-account panel as a new grid row on the same card. Logs are filled in last on both sides, since the panel reads them.

**Tech Stack:** Vanilla JS (no bundler), ESM in the app, CommonJS in the engine. `node --test tests/*.test.js` in the app. Standalone `test-*.js` run individually in the engine. Express 4, puppeteer-core, Redis on the engine side.

**Spec:** `docs/superpowers/specs/2026-08-21-run-visibility-design.md`
**Approved sketches:** `public/sketches/2026-08-21-check-visibility-B.html` (panel + checking/sending banner), `public/sketches/2026-08-21-handover-banner.html` (handover banner, interactive)

## Global Constraints

- Bugatti command deck: monochrome, hairlines, radii 0 or 9999 only. **Gold is reserved for the Start CTA and must not appear anywhere in this work.** State colour reuses what the card already has: `var(--green)` for sending, `var(--blue)` for monitoring and for local-bound handover, `var(--ink)` for neutral.
- Every operator-facing string reads out loud in plain English. No bare counters, no field dumps, no internal names: never `Voyager`, `Stage`, `pidMatched`, `HTTP 429`, `profileId`. Say "nobody has accepted this account's 31 invitations yet", not `scanned=31 withUrl=31`.
- **No em dashes** in any operator-facing copy. Use a comma, a colon, or a middot.
- `BATCH_SIZE = 8` (`src/campaign.js:138`) is leads per turn per account. `campaign.dailyLimit` is that account's whole-day cap. Any UI showing one must name which it is; anywhere both are relevant, show both.
- `statusFromItem` in `public/js/vjcard.mjs` is a **whitelist**. Every new field the card reads must be added there by hand or it silently arrives `undefined`.
- Class names must not collide with existing ones. `.skip` is the off-screen skip-to-content link (`dashboard-v0.3.css:55`, `left:-9999px`). `.sn-switch` is the Log/Counts tab switcher (`app.js:9416`). Neither may be reused.
- Off-limits: `src/linkedin/outreach.js` and `src/linkedin/actions.js` may be edited **for logging only** (Task 10). No logic, selector, control-flow, or signature change in those two files, in any task.
- Never `git add data/monitoring-campaign.json`.
- Patch-bump `package.json` `version` and the `?v=` query on both `index.html` script/style tags before any relaunch.
- Engine changes are not delivered until `./deploy.sh` has run from `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`.

## File Structure

**App repo** (`/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input`, ESM):

| File | Responsibility | Change |
|---|---|---|
| `public/js/app.js` | Polling gate, banner render, panel render, handover events, stop button wiring | Modify |
| `public/js/vjcard.mjs` | Pure field mapping for card #2 | Modify (whitelist + panel fields) |
| `public/js/runpanel.mjs` | **New.** Pure builders for the per-account panel: column shape, rail centring index, counter maths | Create |
| `public/css/dashboard-v0.3.css` | Banner CSS, panel CSS, card grid row | Modify |
| `public/index.html` | `#active-card` panel slot, delete `#sn-handover`, `?v=` bump | Modify |
| `src/campaign.js` | `_abortCheck` flag, stop-check entry, sweep abort checks, log promotion | Modify |
| `src/linkedin/bulk-check-connections.js` | Honour `_abortCheck` between rows | Modify |
| `src/linkedin/auto-intro.js`, `src/linkedin/auto-dm.js` | Honour `_abortCheck` between leads | Modify |
| `src/linkedin/outreach.js`, `src/linkedin/actions.js` | **Logging only** | Modify (Task 10 only) |
| `server.js` | `POST /api/campaign/check/stop` | Modify |
| `tests/*.test.js` | Unit tests, one file per task | Create |

**Engine repo** (`/Users/antoniovarlese/ortus-salesnav-scraper-cloud`, CommonJS):

| File | Responsibility | Change |
|---|---|---|
| `campaign-worker.js` | `_evt()` happy-path events, abort check between leads | Modify |
| `campaign-store.js` | `appendMonitorLog` retention cap | Modify |
| `campaign-api.js` | Stop-check route | Modify |
| `test-check-stop.js`, `test-monitor-log-cap.js` | New standalone tests | Create |

`runpanel.mjs` is a new file rather than more `app.js` because `app.js` is already 3946 lines and the panel's maths (which column is centred, how many pips are filled, which lead is current) is pure and must be unit-testable without a DOM. The DOM-touching render stays in `app.js` beside the other card fillers, matching how `vjcard.mjs` and `_fillVjCards` already split.

---

## Task 1: Poll while monitoring

**Files:**
- Modify: `public/js/app.js:1707-1709`
- Test: `tests/poll-gate.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `shouldPoll(status)` exported from `public/js/pollgate.mjs`, consumed by nothing else in this plan but unit-tested here. Signature: `shouldPoll({ running, state }) -> boolean`.

This is the load-bearing fix. Without it every later task renders once at page load and then freezes, which is exactly the bug being fixed. Note the STOP gate at `app.js:13960` already handles monitoring correctly (`&& s.state !== 'monitoring'`); only the START gate is wrong.

- [ ] **Step 1: Write the failing test**

Create `tests/poll-gate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { shouldPoll } from '../public/js/pollgate.mjs';

test('a running campaign polls', () => {
  assert.equal(shouldPoll({ running: true, state: undefined }), true);
});

test('a monitoring campaign polls even though it is not running', () => {
  // The whole bug: monitoring is not `running`, so the old gate never
  // started the interval and the card froze at its page-load render.
  assert.equal(shouldPoll({ running: false, state: 'monitoring' }), true);
});

test('an idle campaign does not poll', () => {
  assert.equal(shouldPoll({ running: false, state: undefined }), false);
});

test('a finished campaign does not poll', () => {
  assert.equal(shouldPoll({ running: false, state: 'done' }), false);
});

test('a missing status does not poll', () => {
  assert.equal(shouldPoll(null), false);
  assert.equal(shouldPoll(undefined), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/poll-gate.test.js`
Expected: FAIL, cannot resolve `../public/js/pollgate.mjs`.

- [ ] **Step 3: Write the module**

Create `public/js/pollgate.mjs`:

```js
// Whether the dashboard should keep polling /api/campaign/status.
//
// A monitoring campaign is NOT `running`, so the original gate
// (`if (__cockpit.running) startPolling()`) started the interval for a sending
// campaign and never for a monitoring one. The card then rendered once at page
// load and froze, which is indistinguishable from a hung app: pressing "Run
// check now" appeared to do nothing for the whole sweep.
//
// The matching STOP gate in app.js already excluded monitoring correctly; only
// the start side was wrong.
export function shouldPoll(status) {
  if (!status) return false;
  return !!status.running || status.state === 'monitoring';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/poll-gate.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it at the call site**

In `public/js/app.js`, add to the import block at the top, next to the existing `vjcard.mjs` import (line 34):

```js
import { shouldPoll } from '/js/pollgate.mjs';
```

Then replace lines 1707-1709. The existing code is:

```js
  pollStatus().then(() => {
    if (__cockpit.running) startPolling();
  }).catch(() => {});
```

Replace with:

```js
  pollStatus().then(() => {
    // Monitoring campaigns poll too. See pollgate.mjs for why this used to
    // render once and freeze.
    if (shouldPoll(__cockpit)) startPolling();
  }).catch(() => {});
```

- [ ] **Step 6: Verify by measurement, not by reading**

Relaunch and attach to the renderer, per the repo's measurement rule:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
ORTUS_DATA_DIR="$HOME/Library/Application Support/The Ortus Outreach/data" \
  ./node_modules/.bin/electron . --remote-debugging-port=9222 > /tmp/dev-app.log 2>&1 &
```

With a campaign in monitoring, evaluate over CDP:

```js
// Count status polls over 10 seconds. Expect >= 4 (the interval is 2000ms).
(() => { let n = 0; const o = window.fetch;
  window.fetch = function (u, ...r) { if (String(u).includes('/api/campaign/status')) n++; return o.call(this, u, ...r); };
  return new Promise((res) => setTimeout(() => res(n), 10000)); })()
```

Expected: 4 or more. A result of 0 or 1 means the gate still does not fire and the task is not done, regardless of how the code reads.

- [ ] **Step 7: Commit**

```bash
git add public/js/pollgate.mjs tests/poll-gate.test.js public/js/app.js
git commit -m "fix: keep polling while a campaign is monitoring

A monitoring campaign is not \`running\`, so the start gate never fired and the
card rendered once at page load then froze. Pressing Run check now looked like
it did nothing for the whole sweep."
```

---

## Task 2: Stop a check, immediately

**Files:**
- Modify: `src/campaign.js` (near `_abort: false` at line 813; `runMonitoringCheckAll` at 6406; the monitoring tick at 6057-6135)
- Modify: `src/linkedin/bulk-check-connections.js:692` (row loop)
- Modify: `src/linkedin/auto-intro.js:379`, `src/linkedin/auto-dm.js:131`
- Modify: `server.js` (new route beside the check-now route at 4795)
- Test: `tests/check-stop.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `campaign._abortCheck` (boolean) on the campaign object
  - `stopMonitoringCheck() -> { ok: boolean, wasRunning: boolean, interrupted: string|null }` exported from `src/campaign.js`
  - `POST /api/campaign/check/stop` returning that same shape
  - `getCampaignStatus().checkStopping` (boolean), consumed by Task 5's banner

**A separate flag is required.** `campaign._abort` already exists and is honoured mid-lead in roughly twenty places, but `stopCampaign()` (`src/campaign.js:5507`) sets it together with `_stoppedManually` and tears the whole campaign down. Reusing it for "stop this check" would stop monitoring as well. `_abortCheck` is checked in the same places but cleared at the end of the sweep, leaving `state`, `nextCheckAt` and the monitoring window untouched.

**Immediate means mid-lead**, by the operator's explicit decision. A lead already in flight can be left read but not stamped. The mitigation is to name the interrupted person in the log and leave them unstamped so the next sweep re-reads them. A partially-read lead must never be written as finished.

- [ ] **Step 1: Write the failing test**

Create `tests/check-stop.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { campaign, stopMonitoringCheck, setCheckInProgress, getCampaignStatus } from '../src/campaign.js';

test('stopping when no check is running is a no-op', () => {
  setCheckInProgress(false);
  campaign._abortCheck = false;
  const r = stopMonitoringCheck();
  assert.equal(r.ok, true);
  assert.equal(r.wasRunning, false);
  assert.equal(campaign._abortCheck, false, 'must not arm the flag with nothing to stop');
});

test('stopping a running check arms the flag and reports the interrupted person', () => {
  setCheckInProgress(true);
  campaign._abortCheck = false;
  campaign._checkingLead = 'Rina Chandran';
  const r = stopMonitoringCheck();
  assert.equal(r.ok, true);
  assert.equal(r.wasRunning, true);
  assert.equal(r.interrupted, 'Rina Chandran');
  assert.equal(campaign._abortCheck, true);
});

test('stopping a check does NOT stop the campaign', () => {
  // The whole reason _abortCheck exists rather than reusing _abort.
  setCheckInProgress(true);
  campaign.state = 'monitoring';
  campaign._abort = false;
  campaign.nextCheckAt = '2026-08-21T12:00:00.000Z';
  stopMonitoringCheck();
  assert.equal(campaign._abort, false, 'the campaign-wide abort must stay untouched');
  assert.equal(campaign.state, 'monitoring', 'monitoring must survive a stopped check');
  assert.equal(campaign.nextCheckAt, '2026-08-21T12:00:00.000Z', 'the cadence must be unchanged');
});

test('the status payload reports a stopping check', () => {
  setCheckInProgress(true);
  campaign._abortCheck = true;
  assert.equal(getCampaignStatus().checkStopping, true);
  campaign._abortCheck = false;
  assert.equal(getCampaignStatus().checkStopping, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/check-stop.test.js`
Expected: FAIL, `stopMonitoringCheck is not a function`.

- [ ] **Step 3: Add the flag and the stop function**

In `src/campaign.js`, beside `_abort: false,` at line 813, add:

```js
  // Stop THIS acceptance check, not the campaign. _abort tears the whole run
  // down (stopCampaign sets it with _stoppedManually), so a check that reused
  // it would end monitoring too. Cleared when the sweep unwinds; state,
  // nextCheckAt and the monitoring window are never touched by it.
  _abortCheck: false,
  // The person the sweep is reading right now, so a stop can name them.
  _checkingLead: null,
```

Then add, next to the existing `setCheckInProgress` export near line 5982:

```js
/**
 * Stop an acceptance check that is in flight. Immediate: the abort is read
 * between leads inside the sweep, so it lands within one person rather than at
 * the end of the account.
 *
 * The interrupted person is left UNSTAMPED and named in the log. A lead that
 * was read but not written must never be recorded as finished, or the next
 * sweep skips them and their acceptance is lost.
 */
export function stopMonitoringCheck() {
  if (!_checkInProgress) return { ok: true, wasRunning: false, interrupted: null };
  campaign._abortCheck = true;
  const who = campaign._checkingLead || null;
  log(who
    ? `🛑 Check stopped by you while reading ${who}. Nothing was recorded for ${who}, so the next check reads them again.`
    : '🛑 Check stopped by you. Closing the browsers now.');
  return { ok: true, wasRunning: true, interrupted: who };
}
```

- [ ] **Step 4: Report it in the status payload**

In `getCampaignStatus()` (`src/campaign.js:5796`), beside `monitoringCheckInProgress: _checkInProgress,` add:

```js
    // The banner shows STOPPING between the press and the browsers actually
    // closing, so the operator does not press Stop three more times.
    checkStopping: !!campaign._abortCheck,
```

- [ ] **Step 5: Honour the flag in the sweep**

In `runMonitoringCheckAll()` (`src/campaign.js:6411`), the existing between-account guard is:

```js
    if (campaign._abort || campaign.state !== 'monitoring') break;
```

Replace with:

```js
    if (campaign._abort || campaign._abortCheck || campaign.state !== 'monitoring') break;
```

In the monitoring tick's `finally` block (`src/campaign.js:6133`), the existing line is:

```js
      _checkInProgress = false;
```

Replace with:

```js
      // Clear the stop AFTER the sweep unwinds, never before: an early clear
      // lets the next account start while the browsers from this one are still
      // closing. nextCheckAt is deliberately untouched above, so a stopped
      // check does not shift the cadence.
      campaign._abortCheck = false;
      campaign._checkingLead = null;
      _checkInProgress = false;
```

Apply the same two lines to the outer `catch` at `src/campaign.js:6135`.

- [ ] **Step 6: Honour it mid-lead**

In `src/linkedin/bulk-check-connections.js`, inside the row loop that begins at line 692, add as the first statement of the loop body:

```js
    // Stop lands within one person, not at the end of the account. The current
    // row is abandoned WITHOUT a stamp so the next sweep reads it again.
    if (campaign._abortCheck) break;
    campaign._checkingLead = row.fullName || row.name || null;
```

In `src/linkedin/auto-intro.js` (`runAutoIntros`, line 379) and `src/linkedin/auto-dm.js` (`runAutoDms`, line 131), add the same guard as the first statement of each per-lead loop body, using whichever local variable holds the lead in that file. Do not add the `_checkingLead` assignment in these two: the bulk-check loop already owns it and two writers would race.

- [ ] **Step 7: Add the route**

In `server.js`, beside the check-now route at line 4795:

```js
app.post('/api/campaign/check/stop', requireAuth, async (req, res) => {
  const { stopMonitoringCheck } = await import('./src/campaign.js');
  res.json(stopMonitoringCheck());
});
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/check-stop.test.js`
Expected: PASS, 4 tests.

Run the full suite to confirm nothing regressed: `node --test tests/*.test.js`
Expected: no new failures against the pre-task baseline.

- [ ] **Step 9: Commit**

```bash
git add src/campaign.js src/linkedin/bulk-check-connections.js src/linkedin/auto-intro.js src/linkedin/auto-dm.js server.js tests/check-stop.test.js
git commit -m "feat: stop an acceptance check that is in flight

Separate _abortCheck flag: reusing _abort would have torn the whole campaign
down, since stopCampaign sets it. Lands within one lead. The interrupted person
is left unstamped and named in the log so the next sweep reads them again."
```

---

## Task 3: The banner CSS

**Files:**
- Modify: `public/css/dashboard-v0.3.css` (append after the existing `.vj-live` rules)
- Modify: `package.json`, `public/index.html` (`?v=` bump)

**Interfaces:**
- Consumes: nothing
- Produces: CSS classes consumed by Tasks 4, 5 and 6. On `.vj-live`: `is-checking`, `is-sending`, `is-handover`, plus `to-cloud` / `to-local` / `landed` / `out` on `is-handover`. Child elements: `.ck-beacon`, `.ck-right`, `.ho-track`, `.ho-end` (`.a` / `.b` / `.lit`), `.ho-rail`, `.ho-dot`, `.ho-right`.

**The exact CSS is already written and committed**, verified rendering headless in both themes. Copy it verbatim:

- Checking and sending banner, beacon, and `.ck-right` readout: `public/sketches/2026-08-21-check-visibility-B.html`, the block beginning `/* ── THE CHECKING BANNER ─` through the `.ck-right span` rule, plus the `.vj-live.is-sending` block.
- Handover banner, shuttle track and `.ho-right` readout: `public/sketches/2026-08-21-handover-banner.html`, the block beginning `/* ══ AFTER: the handover wears the SAME banner` through the `.ho-right span` rule.

Two rules in the sketches exist because rendering exposed a defect and must not be dropped:

```css
/* The card's own .vj-live-l2 truncates to one line with an ellipsis, which is
   right for a status line and wrong for the sentence that explains what is
   happening to the operator's run. Without this it cut off mid-word. */
body[data-dashboard='v3'] .vj-live.is-handover .vj-live-l2 {
  white-space: normal; overflow: visible; text-overflow: clip;
}
body[data-dashboard='v3'] .vj-live.is-handover .vj-live-txt { flex: 1 1 auto; min-width: 0; }

/* Nothing is travelling once it has landed, so the shuttle goes. Parked at one
   end it reads as a smudge on the glyph, not as an arrival. */
body[data-dashboard='v3'] .vj-live.is-handover.landed .ho-dot { display: none; }
```

- [ ] **Step 1: Copy the CSS in**

Append both blocks to `public/css/dashboard-v0.3.css`, immediately after the existing `.vj-live` rules so the promotions sit beside what they promote. Keep every comment: they record why each rule exists.

- [ ] **Step 2: Verify no gold and no new colour entered**

Run:

```bash
grep -nE "gold|#F7BE68|--accent" public/css/dashboard-v0.3.css | grep -iE "vj-live|ck-|ho-"
```

Expected: no output. Any match is a constraint violation and must be removed.

- [ ] **Step 3: Bump the version**

Patch-bump `version` in `package.json` (3.1.37 to 3.1.38) and update the `?v=` query on every stylesheet and script tag in `public/index.html` to match.

- [ ] **Step 4: Commit**

```bash
git add public/css/dashboard-v0.3.css package.json public/index.html
git commit -m "style: banner CSS for checking, sending and handover states"
```

---

## Task 4: The checking and sending banner

**Files:**
- Modify: `public/js/app.js` (the `.vj-live` filler used by `renderActiveCard` and `_fillVjCards`)
- Modify: `public/js/vjcard.mjs` (`statusFromItem` whitelist)
- Test: `tests/live-banner.test.js` (create)

**Interfaces:**
- Consumes: `shouldPoll` (Task 1), `checkStopping` from the status payload (Task 2), the CSS classes from Task 3.
- Produces: `bannerFor(status) -> { tone, l1, l2, big, cap } | null` exported from `public/js/runpanel.mjs`. `tone` is one of `'check' | 'send' | 'stopping'`. Returns `null` when no banner should show. Consumed by Task 6 for the handover variant and by Task 9's panel for the account name.

Monitoring deliberately returns `null`. Between checks nothing is running, and a card that shouts continuously teaches the operator to stop seeing the shout.

- [ ] **Step 1: Write the failing test**

Create `tests/live-banner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { bannerFor } from '../public/js/runpanel.mjs';

test('a sweep in flight gets the checking banner', () => {
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true,
    liveAccount: 'camillec@ortus.solutions', accountsDone: 1, accountsTotal: 3, elapsedSec: 41 });
  assert.equal(b.tone, 'check');
  assert.equal(b.l1, 'Checking right now');
  assert.equal(b.big, '2 of 3');
  assert.match(b.l2, /camillec@ortus\.solutions/);
});

test('monitoring between checks gets NO banner', () => {
  // By design. A card that shouts continuously stops being heard.
  assert.equal(bannerFor({ state: 'monitoring', monitoringCheckInProgress: false }), null);
});

test('sending names the person before the account', () => {
  const b = bannerFor({ running: true, live: true, liveAccount: 'camillec@ortus.solutions',
    currentAction: { leadName: 'Rina Chandran', company: 'Reuters' },
    batchDone: 5, batchSize: 8, elapsedSec: 12, runsOn: 'local' });
  assert.equal(b.tone, 'send');
  assert.equal(b.l1, 'Sending right now');
  assert.equal(b.big, '6 of 8');
  assert.match(b.l2, /^Rina Chandran/, 'the person comes first, the account second');
  assert.match(b.l2, /on this Mac/);
});

test('a cloud run says so', () => {
  const b = bannerFor({ running: true, live: true, liveAccount: 'karen.d@ortus.solutions',
    currentAction: { leadName: 'Rina Chandran' }, batchDone: 5, batchSize: 8, runsOn: 'vm' });
  assert.match(b.l2, /on the Cloud VM/);
});

test('a stopping check outranks everything and says so plainly', () => {
  const b = bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, checkStopping: true });
  assert.equal(b.tone, 'stopping');
  assert.equal(b.l1, 'Stopping the check');
  assert.match(b.l2, /closing/i);
});

test('an idle campaign gets no banner', () => {
  assert.equal(bannerFor({ running: false }), null);
  assert.equal(bannerFor(null), null);
});

test('no copy contains an em dash', () => {
  const all = [
    bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, liveAccount: 'a@b.c', accountsDone: 0, accountsTotal: 2 }),
    bannerFor({ running: true, live: true, liveAccount: 'a@b.c', currentAction: { leadName: 'X' }, batchDone: 1, batchSize: 8 }),
    bannerFor({ state: 'monitoring', monitoringCheckInProgress: true, checkStopping: true }),
  ];
  for (const b of all) {
    assert.ok(!`${b.l1}${b.l2}${b.cap || ''}`.includes('—'), `em dash in: ${b.l1}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/live-banner.test.js`
Expected: FAIL, cannot resolve `../public/js/runpanel.mjs`.

- [ ] **Step 3: Write the builder**

Create `public/js/runpanel.mjs`:

```js
// Pure builders for the live banner and the per-account panel. No DOM, so
// node --test can drive them. The DOM render lives in app.js beside the other
// card fillers, matching how vjcard.mjs already splits.

const mmss = (s) => {
  const n = Math.max(0, Math.floor(Number(s) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

/** Where the work is happening, in the operator's words. */
export function whereLabel(runsOn) {
  return String(runsOn || 'vm') === 'local' ? 'on this Mac' : 'on the Cloud VM';
}

/**
 * The banner shown while something is genuinely in flight, or null.
 *
 * Monitoring between checks returns null ON PURPOSE: nothing is running, and a
 * banner that is always up is a banner nobody reads.
 */
export function bannerFor(status) {
  const s = status || {};

  // A stop in progress outranks everything: the operator just pressed it and
  // needs to see that it landed, or they press it three more times.
  if (s.checkStopping) {
    return {
      tone: 'stopping',
      l1: 'Stopping the check',
      l2: 'Closing the browsers now. Monitoring carries on, the next check is still scheduled.',
      big: '', cap: '',
    };
  }

  if (s.monitoringCheckInProgress) {
    const done = Number(s.accountsDone) || 0;
    const total = Number(s.accountsTotal) || 0;
    const el = s.elapsedSec != null ? ` · ${mmss(s.elapsedSec)} elapsed` : '';
    return {
      tone: 'check',
      l1: 'Checking right now',
      l2: `${s.liveAccount || 'an account'} · reading its sent invitations · ${whereLabel(s.runsOn)}`,
      big: total ? `${Math.min(done + 1, total)} of ${total}` : '',
      cap: `accounts${el}`,
    };
  }

  if (s.running && s.live) {
    const a = s.currentAction || {};
    const done = Number(s.batchDone) || 0;
    const size = Number(s.batchSize) || 8;
    // The person first. The operator is watching a human being get contacted,
    // not an account do work.
    const who = [a.leadName, a.company].filter(Boolean).join(' · ');
    const el = s.elapsedSec != null ? ` · ${mmss(s.elapsedSec)} elapsed` : '';
    return {
      tone: 'send',
      l1: 'Sending right now',
      l2: `${who || 'the next person'} · from ${s.liveAccount || 'an account'} · ${whereLabel(s.runsOn)}`,
      big: `${Math.min(done + 1, size)} of ${size}`,
      // BATCH_SIZE is the turn, never the day. Naming it here is what stops the
      // "8" being read as the daily cap.
      cap: `this batch${el}`,
    };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/live-banner.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Whitelist the new fields**

`statusFromItem` in `public/js/vjcard.mjs` is a whitelist: a field absent from it arrives `undefined` on the board's card and the banner silently never shows there. Add inside the returned object, beside `monitoringCheckInProgress`:

```js
    // Task 2's stop flag and the banner's counters. statusFromItem is a
    // WHITELIST: every one of these is invisible on the board's card unless it
    // is named here. Same trap that once dropped the cadence fields.
    checkStopping: !!it.checkStopping,
    accountsDone: Number(it.accountsDone) || 0,
    accountsTotal: Number(it.accountsTotal) || Number(it.accounts) || 0,
    batchDone: Number(it.batchDone) || 0,
    batchSize: Number(it.batchSize) || 8,
    sentToday: Number(it.sentToday) || 0,
    dailyLimit: Number(it.dailyLimit) || 0,
    elapsedSec: it.elapsedSec == null ? null : Number(it.elapsedSec),
```

- [ ] **Step 6: Render it**

In `public/js/app.js`, import `bannerFor` from `/js/runpanel.mjs` in the same import block as Task 1's addition. In the function that fills `.vj-live` (the one setting `.vj-live-l1` and `.vj-live-l2`), after the existing text assignment, apply the banner:

```js
  // The banner is the SAME .vj-live band, promoted. One component, three tones,
  // so checking, sending and handover all read alike.
  const _b = bannerFor(status);
  live.classList.remove('is-checking', 'is-sending');
  live.querySelector('.ck-beacon')?.remove();
  live.querySelector('.ck-right')?.remove();
  if (_b) {
    live.querySelector('.vj-live-l1').textContent = _b.l1;
    live.querySelector('.vj-live-l2').textContent = _b.l2;
    live.classList.add('is-checking');
    if (_b.tone === 'send') live.classList.add('is-sending');
    const beacon = document.createElement('i');
    beacon.className = 'ck-beacon';
    live.prepend(beacon);
    if (_b.big) {
      const right = document.createElement('div');
      right.className = 'ck-right';
      right.innerHTML = `<b>${escHtml(_b.big)}</b><span>${escHtml(_b.cap)}</span>`;
      live.append(right);
    }
  }
```

Remove and rebuild the beacon and readout on every render rather than reusing them: the filler runs on every 2s poll, and appending without removing stacks a new beacon every two seconds.

- [ ] **Step 7: Add the Stop control**

Inside the same `if (_b)` block, when `_b.tone === 'check'`, append a Stop button that calls the Task 2 route:

```js
    if (_b.tone === 'check') {
      const stop = document.createElement('button');
      stop.className = 'btn-pill ck-stop';
      stop.textContent = 'Stop the check';
      stop.onclick = async () => {
        stop.disabled = true;
        try { await fetch('/api/campaign/check/stop', { method: 'POST' }); } catch (_) { stop.disabled = false; }
      };
      live.append(stop);
    }
```

- [ ] **Step 8: Verify in the real app**

Relaunch, start a check, and confirm from the rendered page (not from the source) that the banner appears, that the beacon does not multiply across polls, and that Stop closes the browsers. Check the beacon count over CDP:

```js
document.querySelectorAll('#active-card .ck-beacon').length
```

Expected: exactly 1 at any moment. A number that climbs means Step 6's removal is not running.

- [ ] **Step 9: Commit**

```bash
git add public/js/runpanel.mjs public/js/vjcard.mjs public/js/app.js tests/live-banner.test.js
git commit -m "feat: loud banner while a check or a send is in flight

Same .vj-live band, promoted, so checking and sending read alike. Monitoring
stays quiet on purpose. Carries the Stop control for a check in flight."
```

---

## Task 5: The handover banner, on both surfaces

**Files:**
- Modify: `public/js/runpanel.mjs` (add `handoverBanner`)
- Modify: `public/js/app.js:223-237` (`_snShowHandover`)
- Modify: `public/index.html:984` (delete `#sn-handover`), `public/index.html:1688-1697` (delete its CSS)
- Test: `tests/handover-banner.test.js` (create)

**Interfaces:**
- Consumes: the `is-handover` CSS from Task 3, the `.vj-live` render path from Task 4.
- Produces: `handoverBanner({ to, name }) -> { tone, l1, l2, right, cap }` from `runpanel.mjs`, where `to` is `'cloud' | 'local'`.

The board's card is a clone of the dashboard's card, so putting the banner on `.vj-card` lands it on **both** surfaces with one implementation. The standalone `#sn-handover` above the board is deleted, not left running alongside, or the operator is told twice in two different voices.

**The five-second timeout goes.** `app.js:236` currently removes the banner after 5000ms whether or not the switch has finished, which is the frozen-card bug again: the UI reporting a state it has not verified.

The interactive sketch `public/sketches/2026-08-21-handover-banner.html` is the reference for exact copy, both directions, and the landed beat. Copy the `COPY` object from its script verbatim.

- [ ] **Step 1: Write the failing test**

Create `tests/handover-banner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { handoverBanner } from '../public/js/runpanel.mjs';

test('moving to the VM names both ends and says what to do', () => {
  const b = handoverBanner({ to: 'cloud', name: 'MAEN_ANZ_HOB' });
  assert.equal(b.tone, 'to-cloud');
  assert.equal(b.l1, 'Moving to the Cloud VM');
  assert.match(b.l2, /MAEN_ANZ_HOB/);
  assert.match(b.l2, /this Mac/);
  assert.match(b.l2, /VM/);
  assert.equal(b.right[0], 'Leave it open');
});

test('coming back to this Mac reverses the tone', () => {
  const b = handoverBanner({ to: 'local', name: 'MAEN_ANZ_HOB' });
  assert.equal(b.tone, 'to-local');
  assert.equal(b.l1, 'Coming back to this Mac');
  assert.match(b.right[1], /stops the run/);
});

test('the landed state says what the operator can now do', () => {
  const a = handoverBanner({ to: 'cloud', name: 'X', landed: true });
  assert.match(a.right[1], /[Ss]afe to close/);
  const b = handoverBanner({ to: 'local', name: 'X', landed: true });
  assert.match(b.right[1], /[Kk]eep the app open/);
});

test('never a bare Handover, and never an em dash', () => {
  for (const to of ['cloud', 'local']) {
    for (const landed of [false, true]) {
      const b = handoverBanner({ to, name: 'X', landed });
      const all = `${b.l1} ${b.l2} ${b.right.join(' ')}`;
      assert.ok(!all.includes('—'), `em dash in ${to}/${landed}`);
      assert.notEqual(b.l1.trim(), 'Handover');
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/handover-banner.test.js`
Expected: FAIL, `handoverBanner is not a function`.

- [ ] **Step 3: Write the builder**

Append to `public/js/runpanel.mjs`:

```js
// Copy is verbatim from the approved interactive sketch
// public/sketches/2026-08-21-handover-banner.html. It names BOTH ends every
// time: the shipped banner said only "Handover", which told the operator
// neither direction nor what to do.
const HANDOVER = {
  cloud: {
    tone: 'to-cloud',
    l1: 'Moving to the Cloud VM',
    l2: (n) => `Taking ${n} off this Mac and handing it to the VM, so it keeps going after you close the app.`,
    right: ['Leave it open', 'This takes a moment. Nothing is lost if you wait.'],
    doneL1: 'Now running on the VM',
    doneL2: (n) => `${n} is on the Cloud VM. You can close the app, it keeps going.`,
    doneRight: ['Done', 'Safe to close the app now.'],
  },
  local: {
    tone: 'to-local',
    l1: 'Coming back to this Mac',
    l2: (n) => `Taking ${n} off the Cloud VM so it runs here, in your own browsers.`,
    right: ['Leave it open', 'This takes a moment. Closing now stops the run.'],
    doneL1: 'Now running on this Mac',
    doneL2: (n) => `${n} is running here. Closing the app now stops it.`,
    doneRight: ['Done', 'Keep the app open to keep it running.'],
  },
};

export function handoverBanner({ to, name, landed = false }) {
  const k = HANDOVER[to === 'local' ? 'local' : 'cloud'];
  const n = name || 'this campaign';
  return {
    tone: k.tone,
    l1: landed ? k.doneL1 : k.l1,
    l2: (landed ? k.doneL2 : k.l2)(n),
    right: landed ? k.doneRight : k.right,
    landed,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/handover-banner.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Render it on the card, on both surfaces**

Replace `_snShowHandover` (`public/js/app.js:223-237`) so it paints the `.vj-live` band of every `.vj-card` on screen instead of the standalone strip. The shuttle track markup, verbatim from the sketch:

```js
function _snShowHandover(campaigns, stopped, started) {
  // Both surfaces at once: #active-card on the dashboard and the .sn-vjcard
  // clone inside every expanded board strip. One component, no second
  // implementation to keep in sync.
  const to = started ? 'cloud' : 'local';
  const name = _snName(campaigns, started || stopped);
  const b = handoverBanner({ to, name });
  document.querySelectorAll('.vj-card').forEach((card) => _paintHandover(card, b));
  // NO five-second timeout. It is cleared when the handover actually finishes,
  // by _snClearHandover below. A banner that outlives its own switch is the
  // frozen-card bug: the UI reporting a state it has not verified.
}
```

`_paintHandover(card, b)` sets `.vj-live` to `is-handover` plus `b.tone`, fills `.vj-live-l1` and `.vj-live-l2`, builds `.ho-track` (two `.ho-end` glyphs `💻` and `☁︎`, a `.ho-rail`, a `.ho-dot`) and the `.ho-right` readout from `b.right`. Lights the origin end while moving and the destination end once landed. Take the markup and the `paint()` function from the sketch's script verbatim.

`_snClearHandover()` is called when the next poll shows the campaign has actually settled on the new side: it adds `landed` and repaints with `handoverBanner({ ..., landed: true })`, waits 2600ms for the confirmation beat, then fades with `out` and hides. Both timings are in the sketch.

- [ ] **Step 6: Delete the old banner**

Remove `public/index.html:984` (`<div id="sn-handover" ...>`) and its CSS block at `public/index.html:1688-1697`. Then confirm nothing still references it:

```bash
grep -rn "sn-handover" public/ src/ server.js
```

Expected: no output. A surviving reference means two banners fire at once in two different voices.

- [ ] **Step 7: Verify against a real switch**

Trigger an actual local-to-VM handover and confirm the banner is still up when the switch completes, then shows the landed beat, then clears. A banner gone at five seconds means Step 5's timeout removal did not take.

- [ ] **Step 8: Commit**

```bash
git add public/js/runpanel.mjs public/js/app.js public/index.html tests/handover-banner.test.js
git commit -m "feat: handover banner on both the dashboard and the board strip

Same .vj-live band as checking and sending. Names both ends and says what to do.
Holds until the switch actually finishes: the old 5s timeout hid it mid-switch.
Deletes the standalone #sn-handover, which only ever showed above the board."
```

---

## Task 6: Panel data

**Files:**
- Modify: `public/js/runpanel.mjs` (add `accountColumns`, `railIndex`, `batchPips`)
- Modify: `src/campaign.js` (`getCampaignStatus()`: per-account block)
- Test: `tests/run-panel.test.js` (create)

**Interfaces:**
- Consumes: `normalizeSkipReason()` (`src/campaign.js:431-478`, 22 reasons) and `recordProfileEnd()` (`src/campaign.js:905`, 15 park reasons) for the miss list.
- Produces:
  - `getCampaignStatus().accountPanel` : `Array<{ email, state, live, batchDone, batchSize, sentToday, dailyLimit, sub, reached: string[], missed: Array<{ who, why }>, steps: Array<[state, label, time]>, result }>`
  - `accountColumns(status) -> Column[]`, `railIndex(cols) -> number`, `batchPips(done, size, live) -> Array<'on'|'now'|''>` from `runpanel.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/run-panel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { railIndex, batchPips, accountColumns } from '../public/js/runpanel.mjs';

test('the live account is centred, so the previous sits left and the next right', () => {
  const cols = [{ live: false }, { live: false }, { live: true }, { live: false }];
  assert.equal(railIndex(cols), 2);
});

test('the first account is flush left, because there is no previous', () => {
  assert.equal(railIndex([{ live: true }, { live: false }, { live: false }]), 0);
});

test('nothing live falls back to the first column', () => {
  assert.equal(railIndex([{ live: false }, { live: false }]), 0);
  assert.equal(railIndex([]), 0);
});

test('pips mark done, current and remaining', () => {
  assert.deepEqual(batchPips(2, 4, true), ['on', 'on', 'now', '']);
});

test('a finished batch has no current pip', () => {
  assert.deepEqual(batchPips(4, 4, true), ['on', 'on', 'on', 'on']);
});

test('an idle account has no current pip even mid-batch', () => {
  // Nothing is happening, so nothing may look like it is happening.
  assert.deepEqual(batchPips(2, 4, false), ['on', 'on', '', '']);
});

test('steps are carried only by the account that is working', () => {
  const [live, idle] = accountColumns({ accountPanel: [
    { email: 'a@b.c', live: true, steps: [['done', 'Opened the browser', '00:04']] },
    { email: 'd@e.f', live: false, steps: [['done', 'Opened the browser', '00:04']] },
  ] });
  assert.equal(live.steps.length, 1);
  assert.deepEqual(idle.steps, [], 'a frozen checklist on an idle account reads as live');
});

test('both numbers survive: the batch and the day', () => {
  const [c] = accountColumns({ accountPanel: [
    { email: 'a@b.c', live: true, batchDone: 5, batchSize: 8, sentToday: 21, dailyLimit: 50 },
  ] });
  assert.equal(c.batchDone, 5);
  assert.equal(c.batchSize, 8);
  assert.equal(c.sentToday, 21);
  assert.equal(c.dailyLimit, 50);
});

test('a missing panel yields no columns rather than throwing', () => {
  assert.deepEqual(accountColumns({}), []);
  assert.deepEqual(accountColumns(null), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/run-panel.test.js`
Expected: FAIL, `railIndex is not a function`.

- [ ] **Step 3: Write the builders**

Append to `public/js/runpanel.mjs`:

```js
/**
 * Which column the rail scrolls to. The account that is working sits in the
 * CENTRE, so the previous one is visible to its left and the next to its right.
 * The first account is the exception: it sits flush left, because there is no
 * previous one to show.
 */
export function railIndex(cols) {
  const i = (cols || []).findIndex((c) => c && c.live);
  return i > 0 ? i : 0;
}

/** One mark per lead in the turn: done, the one going out now, or still to come. */
export function batchPips(done, size, live) {
  const d = Math.max(0, Number(done) || 0);
  const n = Math.max(0, Number(size) || 0);
  return Array.from({ length: n }, (_, k) => (k < d ? 'on' : (live && k === d ? 'now' : '')));
}

/**
 * One column per account.
 *
 * Steps are dropped from every column except the one that is working. An idle
 * account showing a frozen six-row checklist reads as if it were live, which is
 * the same lie the frozen card told.
 */
export function accountColumns(status) {
  const rows = (status && Array.isArray(status.accountPanel)) ? status.accountPanel : [];
  return rows.map((a) => ({
    email: a.email || '',
    state: a.state || '',
    live: !!a.live,
    batchDone: Number(a.batchDone) || 0,
    batchSize: Number(a.batchSize) || 8,
    sentToday: Number(a.sentToday) || 0,
    dailyLimit: Number(a.dailyLimit) || 0,
    sub: a.sub || '',
    reached: Array.isArray(a.reached) ? a.reached : [],
    missed: Array.isArray(a.missed) ? a.missed : [],
    steps: a.live && Array.isArray(a.steps) ? a.steps : [],
    result: a.result || '',
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/run-panel.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Build the payload server-side**

In `getCampaignStatus()` (`src/campaign.js:5796`), add an `accountPanel` array, one entry per id in `campaign.participatingProfileIds`. Each entry:

- `email`: the account's display email, from the same map the existing status fields use. Never a raw profile id: it means nothing to the operator.
- `live`: whether this account is the one currently working.
- `batchDone` / `batchSize`: position in this turn. `batchSize` is `BATCH_SIZE` (or 15 for `open_profile_only` / `inmail_only`, per `src/campaign.js:3046`).
- `sentToday` / `dailyLimit`: the day's tally and cap.
- `reached`: the names sent to today by this account.
- `missed`: `{ who, why }` per lead not reached, `why` from `normalizeSkipReason()` and `recordProfileEnd()`, rewritten as a sentence. Never the raw reason key.
- `result`: one line carrying only what the counters cannot, that is how many were missed and whether anything is wrong. It must NOT restate the sent count the counters already show, and must never contradict them.

- [ ] **Step 6: Whitelist it**

Add to `statusFromItem` in `public/js/vjcard.mjs`:

```js
    // The per-account panel. Absent from this whitelist it never reaches the
    // board's card and the panel is dashboard-only for no visible reason.
    accountPanel: Array.isArray(it.accountPanel) ? it.accountPanel : [],
```

- [ ] **Step 7: Commit**

```bash
git add public/js/runpanel.mjs public/js/vjcard.mjs src/campaign.js tests/run-panel.test.js
git commit -m "feat: per-account panel data, batch and day counters kept distinct"
```

---

## Task 7: Panel CSS and the card grid row

**Files:**
- Modify: `public/css/dashboard-v0.3.css`
- Modify: `public/index.html` (panel slot in `#active-card`, `?v=` bump), `package.json`

**Interfaces:**
- Consumes: `.vj-card`'s named-area grid (`dashboard-v0.3.css:347`).
- Produces: `.sp` (panel), `.sp-grid` (rail), `.sp-col`, `.sp-steps`, `.sp-step`, `.sp-count`, `.sp-cbar`, `.sp-day`, `.miss`.

**Copy the CSS verbatim** from `public/sketches/2026-08-21-check-visibility-B.html`, the block beginning `/* ══ THE ONE NEW COMPONENT: the per-account step panel ═` through the `.sp-day span` rule. It is already rendered and reviewed.

The grid row, which must be exact or the card reflows:

```css
body[data-dashboard='v3'] .vj-card:has(.sp) {
  grid-template-areas:
    "eyebrow eyebrow" "name name" "live live" "bar bar"
    "hero hero" "panel panel" "stats controls";
}
body[data-dashboard='v3'] .sp { grid-area: panel; border-top: 1px solid var(--hairline); }
body[data-dashboard='v3'] .vj-card:has(.sp) .vj-details { grid-row: 8; }
```

Three visible columns, live centred, first flush left:

```css
.sp-grid { display: flex; margin-top: 13px; overflow-x: auto; scroll-behavior: smooth;
           scroll-snap-type: x mandatory; }
.sp-col { flex: 0 0 33.3333%; scroll-snap-align: center; min-width: 0; }
.sp-col:first-child { scroll-snap-align: start; }
```

- [ ] **Step 1: Copy the CSS in**

Append to `public/css/dashboard-v0.3.css`, keeping every comment.

- [ ] **Step 2: Use `.miss`, never `.skip`**

The app already owns `.skip` (`dashboard-v0.3.css:55`) for the off-screen skip-to-content link at `left:-9999px`. A step row given that class silently vanishes. Verify:

```bash
grep -n "sp-step\.skip\|class=\"skip\"" public/css/dashboard-v0.3.css public/js/app.js
```

Expected: no output from the panel's own rules.

- [ ] **Step 3: Add the slot**

In `public/index.html`, inside `#active-card`, between the `.vj-hero` block (ends line 366) and `#primary-panel` (line 367):

```html
        <!-- Per-account panel: one column per account, three visible, the one
             working centred. Filled by renderRunPanel() in app.js. -->
        <div class="sp" id="active-panel" hidden></div>
```

- [ ] **Step 4: Bump the version and confirm the card did not reflow**

Patch-bump `package.json` and both `?v=` queries. Relaunch, then verify over CDP that the panel occupies its own row and has not been placed on top of the stats row:

```js
getComputedStyle(document.querySelector('#active-card')).gridTemplateAreas
```

Expected: the seven-row string above, including `"panel panel"`.

- [ ] **Step 5: Commit**

```bash
git add public/css/dashboard-v0.3.css public/index.html package.json
git commit -m "style: per-account panel as a new card grid row"
```

---

## Task 8: Panel render

**Files:**
- Modify: `public/js/app.js` (add `renderRunPanel`, call it from the card fillers)

**Interfaces:**
- Consumes: `accountColumns`, `railIndex`, `batchPips` (Task 6); the CSS from Task 7.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the renderer**

In `public/js/app.js`, beside the other card fillers:

```js
function renderRunPanel(card, status) {
  const host = card.querySelector('.sp');
  if (!host) return;
  const cols = accountColumns(status);
  if (!cols.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;

  const idx = railIndex(cols);
  host.innerHTML = `
    <div class="sp-head"><span class="sp-pos">‹ ${idx + 1} of ${cols.length} ›</span></div>
    <div class="sp-grid">${cols.map((c) => `
      <div class="sp-col${c.live ? ' is-live' : ''}">
        <div class="sp-acct">${escHtml(c.email)}</div>
        <div class="sp-state">${escHtml(c.state)}</div>
        ${c.steps.length ? `<div class="sp-steps">${c.steps.map((s) => `
          <div class="sp-step ${escHtml(s[0])}"><i class="sp-mk"></i><span>${escHtml(s[1])}</span><span class="sp-t">${escHtml(s[2] || '')}</span></div>`).join('')}
        </div>` : ''}
        <div class="sp-count"><b>${c.batchDone} of ${c.batchSize}</b><span>this batch</span></div>
        <div class="sp-cbar">${batchPips(c.batchDone, c.batchSize, c.live).map((k) => `<i class="${k}"></i>`).join('')}</div>
        <div class="sp-day"><b>${c.sentToday}</b> of <b>${c.dailyLimit}</b> sent today<span>${escHtml(c.sub)}</span></div>
        ${c.reached.length ? `<div class="sp-lt">Reached today</div><ul class="sp-list">${
          c.reached.map((w) => `<li>${escHtml(w)}</li>`).join('')}</ul>` : ''}
        ${c.missed.length ? `<div class="sp-lt">Nobody reached and why</div><ul class="sp-list miss">${
          c.missed.map((m) => `<li><b>${escHtml(m.who)}</b> ${escHtml(m.why)}</li>`).join('')}</ul>` : ''}
        <div class="sp-res">${escHtml(c.result)}</div>
      </div>`).join('')}
    </div>`;

  // Centre the working account. The first one sits flush left instead, because
  // there is no previous account to show beside it.
  const rail = host.querySelector('.sp-grid');
  const w = rail.scrollWidth / cols.length;
  rail.scrollLeft = idx <= 0 ? 0 : Math.max(0, (idx - 1) * w);
}
```

- [ ] **Step 2: Call it**

Call `renderRunPanel(card, status)` from both `renderActiveCard` (dashboard) and `_fillVjCards` (board strips), so both surfaces render from one implementation.

- [ ] **Step 3: Verify at both sizes, in all three states**

Relaunch. Confirm in the real app, not the sketch, at 3 accounts and at 13, while sending, while checking, and while monitoring:

- Only the working column shows steps.
- The working column is centred, unless it is the first, which is flush left.
- The batch counter and the day counter are both present and are different numbers.
- The result line does not restate or contradict the counters.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat: render the per-account panel on both surfaces"
```

---

## Task 9: Local log, promoted and readable

**Files:**
- Modify: `src/campaign.js`
- Modify: `src/linkedin/outreach.js`, `src/linkedin/actions.js` (**logging only**)
- Test: `tests/log-voice.test.js` (create)

**Interfaces:**
- Consumes: `log()` (`src/campaign.js:995`).
- Produces: `plainLine(kind, fields) -> string` from `src/log-voice.js`.

**The off-limits exception applies here and only here.** `outreach.js` and `actions.js` may be edited to promote existing `console.log` calls onto the campaign log bus. No logic, no selectors, no control flow, no signature changes. Every diff hunk in those two files must be a logging statement and nothing else.

- [ ] **Step 1: Write the failing test**

Create `tests/log-voice.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { plainLine } from '../src/log-voice.js';

const BANNED = [/Voyager/i, /pidMatched/, /\bStage\b/, /HTTP\s*4\d\d/, /profileId/, /—/];

test('a sweep that found nobody says so in words, not counters', () => {
  const s = plainLine('sweep-empty', { account: 'camillec@ortus.solutions', outstanding: 31 });
  assert.match(s, /nobody has accepted/i);
  assert.ok(!/scanned=/.test(s), 'no field dumps');
});

test('a rate limit is described by what it means, not by its status code', () => {
  const s = plainLine('rate-limited', { account: 'camillec@ortus.solutions', waitMin: 12 });
  assert.ok(!/429/.test(s), 'the operator does not know what a 429 is');
  assert.match(s, /LinkedIn/);
});

test('no line contains an internal name or an em dash', () => {
  const kinds = ['sweep-empty', 'rate-limited', 'sent', 'skipped', 'turn-start', 'turn-end'];
  for (const k of kinds) {
    const s = plainLine(k, { account: 'a@b.c', who: 'Rina Chandran', outstanding: 3, waitMin: 5, done: 8, size: 8, why: 'no LinkedIn link on the row' });
    for (const re of BANNED) assert.ok(!re.test(s), `${k} contains ${re}: ${s}`);
    assert.ok(s.length > 20, `${k} is too terse to read out loud: ${s}`);
  }
});

test('a sent line names the person, not just a count', () => {
  const s = plainLine('sent', { account: 'a@b.c', who: 'Rina Chandran', done: 6, size: 8 });
  assert.match(s, /Rina Chandran/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/log-voice.test.js`
Expected: FAIL, cannot resolve `../src/log-voice.js`.

- [ ] **Step 3: Write the voice module**

Create `src/log-voice.js` with a `plainLine(kind, fields)` covering at minimum `sweep-empty`, `sweep-found`, `rate-limited`, `sent`, `skipped`, `turn-start`, `turn-end`, `check-stopped`. Every line is a sentence naming the account by email and the person by name.

The engine's existing `_evt()` lines in `campaign-worker.js` are the house style. Match their register, for example:

```
✉ Rina Chandran at Reuters got a connection request from camillec@ortus.solutions. That is 6 of this turn of 8, and 21 of the 50 this account can send today.
🛏 Nobody has accepted camillec@ortus.solutions' 31 outstanding invitations yet. Checking again at 14:20.
⏸ LinkedIn is asking camillec@ortus.solutions to slow down. Waiting about 12 minutes, then carrying on by itself. Nothing is lost.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/log-voice.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Promote the outreach logging**

In `src/linkedin/outreach.js` and `src/linkedin/actions.js`, route existing `console.log` calls that describe a per-lead outcome through `log()` so they reach the operator instead of only stdout. Leave every other statement byte-identical.

Then prove the exception was respected:

```bash
git diff --unified=0 src/linkedin/outreach.js src/linkedin/actions.js | grep '^[+-]' | grep -v '^[+-][+-]'
```

Expected: every line is a logging statement. Any changed condition, selector, await, or signature is a constraint violation and must be reverted.

- [ ] **Step 6: Add the missing local lines**

Emit `turn-start` and `turn-end` around each account's turn, and `sent` per successful lead, using `plainLine`.

- [ ] **Step 7: Read the real feed**

Run a real local campaign and read `data/campaign.log`. Confirm no line contains a bare counter, a field dump, or an internal name. This is the acceptance test, not the unit test.

- [ ] **Step 8: Commit**

```bash
git add src/log-voice.js src/campaign.js src/linkedin/outreach.js src/linkedin/actions.js tests/log-voice.test.js
git commit -m "feat: local log reads out loud, per-lead outcomes promoted

outreach.js and actions.js touched for LOGGING ONLY, under the scoped exception.
No logic, selector or control-flow change in either file."
```

---

## Task 10: Engine happy-path events and log retention

**Files:** (engine repo, `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`, CommonJS)
- Modify: `campaign-worker.js` (`_evt()` call sites), `campaign-store.js:1721` (`appendMonitorLog`), `campaign-api.js` (stop-check route)
- Test: `test-monitor-log-cap.js`, `test-check-stop.js` (create)

**Interfaces:**
- Consumes: `this._evt(campaign, line)` (`campaign-worker.js:894`).
- Produces: the same `monitorLog` the app already reads.

The engine emits 27 event lines and they already read in plain English. Almost all are exception paths, so a turn where nothing goes wrong is silent from turn start (no line) to browser close (`campaign-worker.js:875`). A five-minute gap then looks identical to a hang.

- [ ] **Step 1: Write the failing retention test**

Create `test-monitor-log-cap.js`:

```js
// Fifty lines is under one account's turn once the happy path is instrumented,
// so the feed truncated before the operator could read it. The 7-day TTL stays.
const assert = require('assert');
const { MONITOR_LOG_CAP } = require('./campaign-store.js');

assert.ok(MONITOR_LOG_CAP >= 400, `cap is ${MONITOR_LOG_CAP}, too small for one instrumented turn`);
console.log('ok: monitor log cap is', MONITOR_LOG_CAP);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-monitor-log-cap.js`
Expected: FAIL, `MONITOR_LOG_CAP` is undefined.

- [ ] **Step 3: Raise the cap**

In `campaign-store.js`, export the constant and use it. The current code at line 1727 is:

```js
      await this.redis.ltrim(key, 0, 49);          // keep the 50 most-recent
```

Replace with:

```js
      await this.redis.ltrim(key, 0, MONITOR_LOG_CAP - 1);
```

and define, near the top of the file:

```js
// One instrumented turn is roughly 8 sent lines plus turn start and end, per
// account. At 13 accounts that is well over the old cap of 50, so the feed
// truncated before the operator read it. The 7-day TTL still bounds memory.
const MONITOR_LOG_CAP = 500;
```

Export it alongside the store. Choose the final number against a real per-turn line count measured after Step 4, not by guess: if 13 accounts produce more than 500 lines per sweep, raise it and say so in the commit.

- [ ] **Step 4: Add the missing events**

In `campaign-worker.js`, add `_evt()` calls, matching the register of the existing 27:

- **Turn start**, where the account's turn begins: which account is opening and how many leads it intends this turn.
- **Per-lead success**, beside the existing failure branches: the person's name, the account, position in the turn, and the day's tally.
- **Sweep progress**, per account rather than only on the tail: which account is being checked and what it found.
- **Next check**: when the feed will speak again.

- [ ] **Step 5: Add the stop-check route**

Mirror Task 2 on the engine side: a route that arms an abort the worker reads between leads, and a `_evt()` line naming the interrupted person.

- [ ] **Step 6: Run the engine tests**

Run each affected standalone test individually:

```bash
node test-monitor-log-cap.js
node test-check-stop.js
node test-monitor-backoff.js
node test-monitor-per-account-sheet-sync.js
```

Expected: all pass.

- [ ] **Step 7: Deploy**

An engine change is not delivered until this has run:

```bash
./deploy.sh
```

- [ ] **Step 8: Read the real feed**

Watch a live cloud campaign's `monitorLog` through a clean turn. Confirm there is no silent gap longer than one lead, and that no line contains a bare counter, a field dump, or an internal name.

- [ ] **Step 9: Commit**

```bash
git add campaign-worker.js campaign-store.js campaign-api.js test-monitor-log-cap.js test-check-stop.js
git commit -m "feat: emit the happy path, raise the monitor log cap

27 event lines existed but nearly all were exception paths, so a clean turn was
silent from turn start to browser close and a five-minute gap looked like a hang.
Cap raised from 50: one instrumented turn exceeds it."
```

---

## Final verification

After Task 10, before `superpowers:finishing-a-development-branch`:

- [ ] `node --test tests/*.test.js` in the app repo: no new failures against the pre-plan baseline.
- [ ] Each engine `test-*.js` touched: passes individually.
- [ ] `./deploy.sh` has run and the live feed reflects it.
- [ ] A monitoring campaign polls continuously (measured over CDP, not read).
- [ ] Stop lands within one lead, leaves `state` and `nextCheckAt` untouched, and names the interrupted person, who is re-read on the next sweep.
- [ ] The handover banner survives past five seconds and clears when the switch actually finishes.
- [ ] `grep -rn "sn-handover" public/ src/ server.js` returns nothing.
- [ ] The `outreach.js` / `actions.js` diff contains logging statements and nothing else.
- [ ] No gold outside the Start CTA; no em dash in any operator-facing string.
