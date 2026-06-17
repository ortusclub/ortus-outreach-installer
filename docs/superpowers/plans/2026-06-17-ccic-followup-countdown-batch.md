# CC+IC Follow-up Countdown & Batched Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live countdown to the CC+IC follow-up send on the live-campaign card, and make a run's follow-ups fire together in one browser session instead of opening/closing the browser per message.

**Architecture:** The one-browser-session drain already exists in `runDueTasks`; the only scheduling change is to slide a campaign's pending follow-up due-times to `now + delay` on each new intro (Part 2). The countdown rides the existing `/api/campaign/status` poll via a pure summary + a ~5s memoized queue read, and renders/ticks through the existing `v3RenderMonitorHero` / `_tickMonHeroCountdown` infra (Part 1).

**Tech Stack:** Node ESM, `node --test` (no Jest), Express 4, vanilla JS frontend, CSS scoped under `body[data-dashboard='v3']`.

---

## File Structure

- `src/primary-tasks.js` — **modify**: add three exports — `slideFollowUpDueDates` (pure), `summarizeFollowUps` (pure), `enqueueFollowUpBatched` (IO). The persisted-queue module is the right home; mirrors its existing `buildFollowUpTask` / `enqueuePrimaryTask`.
- `src/linkedin/auto-intro.js` — **modify**: call `enqueueFollowUpBatched` at the follow-up enqueue site (one-line swap + import).
- `server.js` — **modify**: `/api/campaign/status` becomes async; merges a memoized `followUp` summary.
- `public/index.html` — **modify**: add the `.fu-hero` block to the active card; relabel the follow-up-delay field + hints.
- `public/css/dashboard-v0.3.css` — **modify**: add `.fu-hero` / `.fu-hero-row` / `.fu-count` / `.fu-cap` / `.fu-line` (from the validated sketch).
- `public/js/app.js` — **modify**: render the `.fu-hero` block + tick the countdown.
- `tests/follow-up-batch.test.js` — **create**: unit tests for the three new functions.
- `package.json` — **modify**: version → 2.111.0.

---

## Task 1: `slideFollowUpDueDates` (pure)

**Files:**
- Create: `tests/follow-up-batch.test.js`
- Modify: `src/primary-tasks.js`

- [ ] **Step 1: Write the failing test**

Create `tests/follow-up-batch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideFollowUpDueDates } from '../src/primary-tasks.js';

test('slideFollowUpDueDates bumps pending follow-ups of the target campaign', () => {
  const tasks = [
    { id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'b', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 200 },
  ];
  const out = slideFollowUpDueDates(tasks, 'p1', 999);
  assert.deepEqual(out.map(t => t.dueAt), [999, 999]);
});

test('slideFollowUpDueDates leaves accepts, other campaigns, and non-pending untouched', () => {
  const tasks = [
    { id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'b', type: 'accept',    status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'c', type: 'follow-up', status: 'pending', campaignProfileId: 'p2', dueAt: 100 },
    { id: 'd', type: 'follow-up', status: 'done',    campaignProfileId: 'p1', dueAt: 100 },
  ];
  const out = slideFollowUpDueDates(tasks, 'p1', 999);
  assert.equal(out[0].dueAt, 999);
  assert.equal(out[1].dueAt, 100);
  assert.equal(out[2].dueAt, 100);
  assert.equal(out[3].dueAt, 100);
});

test('slideFollowUpDueDates does not mutate the input array', () => {
  const tasks = [{ id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 }];
  slideFollowUpDueDates(tasks, 'p1', 999);
  assert.equal(tasks[0].dueAt, 100);
});

test('slideFollowUpDueDates on empty input returns []', () => {
  assert.deepEqual(slideFollowUpDueDates([], 'p1', 999), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/follow-up-batch.test.js`
Expected: FAIL — `SyntaxError`/`does not provide an export named 'slideFollowUpDueDates'`.

- [ ] **Step 3: Implement** — add to `src/primary-tasks.js` (after `buildFollowUpTask`):

```js
/** Pure: return a COPY of tasks where every PENDING follow-up for this campaign
 *  has its dueAt set to `dueAt`. Accept tasks, other campaigns, and non-pending
 *  tasks are returned unchanged. Used to batch a run's follow-ups so they ripen
 *  together (v2.111). */
export function slideFollowUpDueDates(tasks, campaignProfileId, dueAt) {
  return (tasks || []).map(t =>
    (t && t.type === 'follow-up' && t.status === 'pending' && t.campaignProfileId === campaignProfileId)
      ? { ...t, dueAt }
      : t
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/follow-up-batch.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/follow-up-batch.test.js src/primary-tasks.js
git commit -m "feat(follow-up): slideFollowUpDueDates — pure due-time batcher (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `summarizeFollowUps` (pure)

**Files:**
- Modify: `tests/follow-up-batch.test.js`
- Modify: `src/primary-tasks.js`

- [ ] **Step 1: Add the failing tests** — append to `tests/follow-up-batch.test.js`:

```js
import { summarizeFollowUps } from '../src/primary-tasks.js';

test('summarizeFollowUps returns null when no pending follow-ups', () => {
  assert.equal(summarizeFollowUps([], ['p1']), null);
  assert.equal(summarizeFollowUps([{ id:'a', type:'accept', status:'pending', campaignProfileId:'p1', dueAt:1 }], ['p1']), null);
});

test('summarizeFollowUps reports count, soonest dueAt, and that task sender', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 500, sender: 'local-browser' },
    { id:'b', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 300, sender: 'profile-xyz' },
  ];
  assert.deepEqual(summarizeFollowUps(tasks, ['p1']), { count: 2, dueAt: 300, sender: 'profile-xyz' });
});

test('summarizeFollowUps ignores other campaigns and non-pending', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p2', dueAt: 100, sender:'local-browser' },
    { id:'b', type:'follow-up', status:'done',    campaignProfileId:'p1', dueAt: 100, sender:'local-browser' },
  ];
  assert.equal(summarizeFollowUps(tasks, ['p1']), null);
});

test('summarizeFollowUps counts across multiple accounts', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 400, sender:'local-browser' },
    { id:'b', type:'follow-up', status:'pending', campaignProfileId:'p2', dueAt: 200, sender:'profile-2' },
  ];
  assert.deepEqual(summarizeFollowUps(tasks, ['p1','p2']), { count: 2, dueAt: 200, sender: 'profile-2' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/follow-up-batch.test.js`
Expected: FAIL — `does not provide an export named 'summarizeFollowUps'`.

- [ ] **Step 3: Implement** — add to `src/primary-tasks.js`:

```js
/** Pure: summary of the soonest pending follow-up batch for the given campaign
 *  profile ids → { count, dueAt, sender } or null when none pending. count is
 *  ALL pending follow-ups for those ids; dueAt is the soonest; sender is that
 *  soonest task's sender. Feeds the live-campaign countdown (v2.111). */
export function summarizeFollowUps(tasks, campaignProfileIds) {
  const ids = new Set(campaignProfileIds || []);
  const pending = (tasks || []).filter(
    t => t && t.type === 'follow-up' && t.status === 'pending' && ids.has(t.campaignProfileId)
  );
  if (pending.length === 0) return null;
  const soonest = pending.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
  return { count: pending.length, dueAt: soonest.dueAt, sender: soonest.sender || 'local-browser' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/follow-up-batch.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add tests/follow-up-batch.test.js src/primary-tasks.js
git commit -m "feat(follow-up): summarizeFollowUps — soonest-batch summary for the countdown (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `enqueueFollowUpBatched` (IO)

**Files:**
- Modify: `tests/follow-up-batch.test.js`
- Modify: `src/primary-tasks.js`

- [ ] **Step 1: Add the failing tests** — append to `tests/follow-up-batch.test.js`:

```js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueFollowUpBatched, loadTasks, saveTasks, buildFollowUpTask } from '../src/primary-tasks.js';

function tmpFile() { return join(mkdtempSync(join(tmpdir(), 'fu-')), 'primary-tasks.json'); }

test('enqueueFollowUpBatched aligns the new task + existing siblings to now+delay', async () => {
  const file = tmpFile();
  const now = 1_000_000;
  await saveTasks([
    { id:'old', type:'follow-up', status:'pending', campaignProfileId:'p1', leadUrl:'x', dueAt: now - 50_000, sender:'local-browser' },
  ], file);
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'y', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 10, now, file);
  const all = await loadTasks(file);
  const expected = now + 10 * 60_000;
  assert.equal(stored.dueAt, expected);
  assert.deepEqual(all.map(t => t.dueAt).sort((a,b)=>a-b), [expected, expected]);
});

test('enqueueFollowUpBatched returns null on a duplicate lead but still slides siblings', async () => {
  const file = tmpFile();
  const now = 2_000_000;
  await saveTasks([
    { id:'dup', type:'follow-up', status:'pending', campaignProfileId:'p1', leadUrl:'y', dueAt: now - 99_000, sender:'local-browser' },
  ], file);
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'y', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 10, now, file);
  const all = await loadTasks(file);
  assert.equal(stored, null);
  assert.equal(all.length, 1);
  assert.equal(all[0].dueAt, now + 10 * 60_000);
});

test('enqueueFollowUpBatched defaults to 10 minutes for an invalid delay', async () => {
  const file = tmpFile();
  const now = 3_000_000;
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'z', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 0, now, file);
  assert.equal(stored.dueAt, now + 10 * 60_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/follow-up-batch.test.js`
Expected: FAIL — `does not provide an export named 'enqueueFollowUpBatched'`.

- [ ] **Step 3: Implement** — add to `src/primary-tasks.js` (after `enqueuePrimaryTask`; it relies on `loadTasks`, `saveTasks`, `dedupeKey`, `slideFollowUpDueDates`, `PRIMARY_TASKS_FILE`, all in this file):

```js
/** Enqueue a follow-up so the whole campaign's pending follow-ups ripen together:
 *  align this task AND existing pending siblings (same campaignProfileId) to
 *  now + delayMinutes, then dedupe like enqueuePrimaryTask. Returns the stored
 *  task, or null on a duplicate lead (siblings are still slid + persisted, since
 *  a new intro DID fire). (v2.111) */
export async function enqueueFollowUpBatched(task, delayMinutes, now, file = PRIMARY_TASKS_FILE) {
  const created = Number.isFinite(now) ? now : Date.now();
  const delay = Number(delayMinutes) > 0 ? Number(delayMinutes) : 10;
  const batchDue = created + delay * 60_000;
  const tasks = slideFollowUpDueDates(await loadTasks(file), task.campaignProfileId, batchDue);
  const key = dedupeKey(task);
  if (tasks.some(t => t.status === 'pending' && dedupeKey(t) === key)) {
    await saveTasks(tasks, file);
    return null;
  }
  const stored = { ...task, dueAt: batchDue };
  tasks.push(stored);
  await saveTasks(tasks, file);
  return stored;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/follow-up-batch.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add tests/follow-up-batch.test.js src/primary-tasks.js
git commit -m "feat(follow-up): enqueueFollowUpBatched — align a run's follow-ups into one batch (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `auto-intro.js` to batch

**Files:**
- Modify: `src/linkedin/auto-intro.js`

- [ ] **Step 1: Add the import.** Find the existing import from `'../primary-tasks.js'` (it imports `enqueuePrimaryTask`, `buildFollowUpTask`, `buildAcceptTask`). Add `enqueueFollowUpBatched` to that import list.

- [ ] **Step 2: Swap the follow-up enqueue call.** Replace:

```js
        const stored = await enqueuePrimaryTask(_fu);
```

with:

```js
        const stored = await enqueueFollowUpBatched(_fu, tpl.followUpDelayMinutes, Date.now());
```

(Leave the `accept`-task `enqueuePrimaryTask(buildAcceptTask(...))` call unchanged — only the follow-up enqueue changes.)

- [ ] **Step 3: Run the full suite to confirm no regression**

Run: `node --test tests/*.test.js`
Expected: PASS, 0 fail (805 tests: prior 793 + 12 new... follow-up-batch adds 11; count is informational — the gate is **0 fail**).

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/auto-intro.js
git commit -m "feat(cc+ic): route the follow-up enqueue through the batcher (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `/api/campaign/status` exposes the follow-up summary

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the import.** At the top of `server.js`, alongside the other `./src/...` imports, add:

```js
import { loadTasks as loadPrimaryTasks, summarizeFollowUps } from './src/primary-tasks.js';
```

- [ ] **Step 2: Add the memoized summary helper.** Immediately above `app.get('/api/campaign/status'`, add:

```js
// v2.111: follow-up batch summary for the live-campaign countdown. Reads the
// queue at most once per 5s so the 2s status poll stays off the synchronous
// hot path (see campaign.js getCampaignStatus perf note).
let _fuCache = { at: 0, tasks: [] };
async function _activeFollowUpSummary(base) {
  const ids = (base.profileIds && base.profileIds.length) ? base.profileIds : (base.participatingProfileIds || []);
  if (!ids.length) return null;
  const now = Date.now();
  if (now - _fuCache.at > 5000) _fuCache = { at: now, tasks: await loadPrimaryTasks() };
  return summarizeFollowUps(_fuCache.tasks, ids);
}
```

- [ ] **Step 3: Make the route async and merge `followUp`.** Replace:

```js
app.get('/api/campaign/status', (_req, res) => {
  const base = getCampaignStatus();
```

with:

```js
app.get('/api/campaign/status', async (_req, res) => {
  const base = getCampaignStatus();
```

and replace the final `res.json(base);` of that handler with:

```js
  let followUp = null;
  try { followUp = await _activeFollowUpSummary(base); } catch { /* non-fatal — countdown just hides */ }
  res.json({ ...base, followUp });
```

(The `postAmp.running` early-return branch above stays as-is — no countdown during post-amplification.)

- [ ] **Step 4: Verify the route still serves and carries the key.** With the app running (`npm run dev:app`), run:

Run: `curl -s http://localhost:7847/api/campaign/status | grep -o '"followUp":[^,}]*'`
Expected: prints `"followUp":null` when no CC+IC campaign with queued follow-ups is active (key present, no error).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(api): surface follow-up batch summary on /api/campaign/status (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Countdown UI on the live-campaign card

**Files:**
- Modify: `public/index.html` (active card markup)
- Modify: `public/css/dashboard-v0.3.css`
- Modify: `public/js/app.js`

- [ ] **Step 1: Add the `.fu-hero` block.** In `public/index.html`, inside `#active-monitor`, immediately after `<div class="vj-mon-line" id="monLine">— sent</div>`, add:

```html
          <!-- v2.111: follow-up batch countdown — shown by v3RenderMonitorHero when a batch is pending -->
          <div class="fu-hero" id="active-fu-hero" hidden>
            <div class="fu-hero-row"><span class="fu-count" id="fuCount">—</span><span class="fu-cap">until follow-ups send</span></div>
            <div class="fu-line">⏳ <b id="fuQueued">0</b> queued · sent together in one batch · from <b id="fuSender">you</b></div>
          </div>
```

- [ ] **Step 2: Add the CSS.** In `public/css/dashboard-v0.3.css`, after the `.vj-mon-line` rules (~line 448), add:

```css
  /* v2.111 — follow-up batch countdown (twin hero, under the check countdown) */
  body[data-dashboard='v3'] .fu-hero { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--hairline-soft); }
  body[data-dashboard='v3'] .fu-hero[hidden] { display: none; }
  body[data-dashboard='v3'] .fu-hero-row { display: flex; align-items: flex-end; gap: 12px; }
  body[data-dashboard='v3'] .fu-count {
    font-family: var(--display); font-weight: 500; font-size: 2.0rem; line-height: 0.85;
    letter-spacing: 0.01em; color: var(--ink); font-variant-numeric: tabular-nums;
  }
  body[data-dashboard='v3'] .fu-cap {
    font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--gray); padding-bottom: 5px;
  }
  body[data-dashboard='v3'] .fu-line { font-family: var(--mono); font-size: 0.78rem; color: var(--gray); margin-top: 9px; }
  body[data-dashboard='v3'] .fu-line b { color: var(--ink); font-weight: 600; }
```

- [ ] **Step 3: Declare the cached due-time.** In `public/js/app.js`, immediately after `let _monHeroNextCheckAt = null;`, add:

```js
let _fuHeroDueAt = null; // v2.111: cached follow-up batch dueAt for the 1s tick
```

- [ ] **Step 4: Render the block in `v3RenderMonitorHero`.** In `public/js/app.js`, inside `v3RenderMonitorHero(status)`, immediately before its closing `}` (after the `monLine` block), add:

```js
  // v2.111: follow-up batch countdown.
  const fu = status.followUp;
  const fuHero = document.getElementById('active-fu-hero');
  if (fuHero) {
    if (fu && fu.count > 0) {
      _fuHeroDueAt = fu.dueAt || null;
      const q = document.getElementById('fuQueued');
      const s = document.getElementById('fuSender');
      const c = document.getElementById('fuCount');
      if (q) q.textContent = String(fu.count);
      if (s) s.textContent = (fu.sender && fu.sender !== 'local-browser') ? 'the primary' : 'you';
      if (c) { const ms = (fu.dueAt || 0) - Date.now(); c.textContent = ms <= 0 ? 'Sending…' : v3FmtCountdown(ms); }
      fuHero.hidden = false;
    } else {
      _fuHeroDueAt = null;
      fuHero.hidden = true;
    }
  }
```

- [ ] **Step 5: Tick the countdown.** In `public/js/app.js`, inside `_tickMonHeroCountdown()`, immediately before its closing `}` (after the `monCount` update), add:

```js
  if (_fuHeroDueAt) {
    const fuEl = document.getElementById('fuCount');
    if (fuEl) { const ms = _fuHeroDueAt - Date.now(); fuEl.textContent = ms <= 0 ? 'Sending…' : v3FmtCountdown(ms); }
  }
```

- [ ] **Step 6: Manual verification.** Restart the app (`pkill -f "npm.*dev:app"; pkill -f "electron \."; npm run dev:app > /tmp/dev-app.log 2>&1 &`). Confirm: (a) with no follow-up pending, the live-campaign card looks unchanged (the block is hidden — regression check); (b) the sketch at `/sketches/followup-countdown.html` still matches the chosen Variant A styling. Full live behaviour (the count populating + ticking) is verified during the next real CC+IC run.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/css/dashboard-v0.3.css public/js/app.js
git commit -m "feat(ui): live follow-up batch countdown on the campaign card (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Relabel the follow-up-delay wizard field

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Relabel the unit.** Replace:

```html
                  <span class="intro-config-prefix">minutes</span>
```

with:

```html
                  <span class="intro-config-prefix">minutes after the last intro</span>
```

- [ ] **Step 2: Update the toggle key.** Replace:

```html
              <span class="intro-config-toggle-key">Send a first follow-up after the intro</span>
```

with:

```html
              <span class="intro-config-toggle-key">Send a first follow-up (batched after the last intro)</span>
```

- [ ] **Step 3: Update the message-section subtitle.** Replace:

```html
      <h2 data-edit="h2-followup">First Follow-up Message <small>sent in the group thread, ~10 min after the intro</small></h2>
```

with:

```html
      <h2 data-edit="h2-followup">First Follow-up Message <small>sent in the group thread — all queued follow-ups go together, after the last intro</small></h2>
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "ui(cc+ic): wizard copy — follow-ups batch after the last intro (v2.111)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Version bump + final gate + relaunch

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the version.** In `package.json`, change `"version": "2.110.1"` to `"version": "2.111.0"` (minor — genuine new feature).

- [ ] **Step 2: Full suite gate.**

Run: `node --test tests/*.test.js`
Expected: 0 fail.

- [ ] **Step 3: Apps Script syntax (unchanged this feature, but cheap insurance).**

Run: `node --check google-apps-script.js`
Expected: prints nothing (exit 0).

- [ ] **Step 4: Relaunch for verification.**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "electron \." 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
Then confirm the banner reads `v2.111.0` (`grep -m1 v2.111 /tmp/dev-app.log` after a moment).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: bump to 2.111.0 — CC+IC follow-up countdown + batched send

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** countdown data → Task 5 (`summarizeFollowUps` from Task 2); countdown UI + tick → Task 6; batching slide → Task 1; batched enqueue → Task 3; wiring → Task 4; wizard relabel → Task 7; version → Task 8. All spec sections covered.
- **Type consistency:** `slideFollowUpDueDates(tasks, campaignProfileId, dueAt)`, `summarizeFollowUps(tasks, campaignProfileIds)`, `enqueueFollowUpBatched(task, delayMinutes, now, file)` — used identically in Tasks 4 (`enqueueFollowUpBatched(_fu, tpl.followUpDelayMinutes, Date.now())`) and 5 (`summarizeFollowUps(_fuCache.tasks, ids)`). The `followUp: { count, dueAt, sender }` payload produced in Task 5 is consumed field-for-field in Task 6. Element ids `fuCount` / `fuQueued` / `fuSender` / `active-fu-hero` match across Tasks 6's markup, render, and tick. `_fuHeroDueAt` declared (Task 6 Step 3), written (Step 4), read (Step 5).
- **Placeholder scan:** every code step has complete code; every run step has an exact command + expected result. No TBDs.
- **Note on non-unit-tested tasks:** Tasks 4 (one-line wiring), 5 (Express route), 6 (DOM) follow the repo convention of pure-helper unit tests + manual verification for glue/DOM. The behavioural logic all lives in the Task 1-3 pure functions, which are fully tested.
