# Dashboard v0.3 Integration — Executable Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-27-dashboard-v0.3-integration-design.md`

**Goal:** Open the Electron app → `#/` route renders the v0.3 unified layout populated with real campaign data → every interactive element fires the correct backend endpoint → no regression in wizard, right-pane, modals, polling, or monitoring lifecycle.

**Architecture:** Surgical replacement of the `#dashboard-view` region in `public/index.html` with v0.3's single-scroll layout. Add 4 new backend endpoints. Refactor `pollStatus()` and related renderers in `app.js` to write into v0.3 DOM IDs. Extract v0.3 CSS to a new file scoped under `body[data-dashboard='v3']`.

**Tech Stack:** Node.js ≥22 (Electron renderer + Express server), vanilla JS modules, no bundler, `node --test` for unit tests. Existing app: Express 4.21, GoLogin 2.2.8, puppeteer-core 22.15.

---

## Phase 1 — Backend endpoints (parallel with Phase 2)

### Task 1: PATCH /api/queue/:id — edit queued campaign

**Files:**
- Modify: `src/campaign-queue.js` (add `updateQueueEntry` helper)
- Modify: `server.js` (add route)
- Test: `tests/queue-update.test.js`

**Owner:** Subagent A (Phase 1 backend)

- [ ] **Step 1: Write the failing test**

```js
// tests/queue-update.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { addToQueue, updateQueueEntry, getQueue, removeFromQueue } from '../src/campaign-queue.js';

test('updateQueueEntry — patches name field', () => {
  const { id } = addToQueue({ name: 'Original', mode: 'C+I' });
  const updated = updateQueueEntry(id, { name: 'Renamed' });
  assert.strictEqual(updated.name, 'Renamed');
  assert.strictEqual(updated.config.mode, 'C+I'); // other fields preserved
  removeFromQueue(id);
});

test('updateQueueEntry — patches scheduledAt field', () => {
  const { id } = addToQueue({ name: 'x', mode: 'CC' });
  const updated = updateQueueEntry(id, { scheduledAt: '2026-05-28T10:00:00Z' });
  assert.strictEqual(updated.scheduledAt, '2026-05-28T10:00:00Z');
  removeFromQueue(id);
});

test('updateQueueEntry — unknown id returns null', () => {
  const r = updateQueueEntry('nonexistent', { name: 'x' });
  assert.strictEqual(r, null);
});

test('updateQueueEntry — rejects unknown keys', () => {
  const { id } = addToQueue({ name: 'x', mode: 'CC' });
  assert.throws(() => updateQueueEntry(id, { ownerSecret: 'hax' }), /unknown key/i);
  removeFromQueue(id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/queue-update.test.js`
Expected: 4 FAIL with "updateQueueEntry is not a function"

- [ ] **Step 3: Implement updateQueueEntry in campaign-queue.js**

Add to `src/campaign-queue.js` (placement: after `removeFromQueue`):

```js
const ALLOWED_PATCH_KEYS = new Set(['name', 'scheduledAt', 'config']);

export function updateQueueEntry(id, patch) {
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(k)) {
      throw new Error(`updateQueueEntry: unknown key "${k}"`);
    }
  }
  const queue = loadQueue();
  const idx = queue.findIndex(q => q.id === id);
  if (idx === -1) return null;
  if (patch.name) queue[idx].name = patch.name;
  if (patch.scheduledAt) queue[idx].scheduledAt = patch.scheduledAt;
  if (patch.config) queue[idx].config = { ...queue[idx].config, ...patch.config };
  writeQueue(queue);
  return queue[idx];
}
```

(Adjust `loadQueue` / `writeQueue` to match the actual function names in `campaign-queue.js` — verify by reading the file first.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/queue-update.test.js`
Expected: 4 PASS

- [ ] **Step 5: Add Express route in server.js**

Find the existing queue routes (around the `POST /api/queue/:id/move` route). After them, add:

```js
app.patch('/api/queue/:id', requireSession, (req, res) => {
  try {
    const updated = updateQueueEntry(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, entry: updated });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});
```

Make sure `updateQueueEntry` is added to the import at the top of `server.js` alongside the other queue helpers.

- [ ] **Step 6: Integration smoke**

Start the server (existing dev script or `node server.js`), then in another terminal:

```bash
# Replace <id> with a real queued id from /api/queue
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"x","mode":"CC","profileIds":[]}' \
  http://localhost:7110/api/campaign/queue-only \
  -b session=<dev-cookie>
# Note the returned queueId, then:
curl -s -X PATCH -H "Content-Type: application/json" \
  -d '{"name":"renamed"}' \
  http://localhost:7110/api/queue/<id> \
  -b session=<dev-cookie>
```

Expected: `{ "ok": true, "entry": { "id": "...", "name": "renamed", ... } }`

- [ ] **Step 7: Commit**

```bash
git add tests/queue-update.test.js src/campaign-queue.js server.js
git commit -m "add: PATCH /api/queue/:id endpoint for editing queued campaigns"
```

---

### Task 2: POST /api/history/:idx/relaunch — restart finished campaign

**Files:**
- Modify: `server.js` (add route — uses existing `addToQueue` + history read)
- Test: `tests/history-relaunch.test.js`

**Owner:** Subagent A

- [ ] **Step 1: Write the failing test**

```js
// tests/history-relaunch.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HIST_PATH = path.join(process.cwd(), 'data', 'history.json');

function readHistory() { return JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); }
function writeHistory(arr) { fs.writeFileSync(HIST_PATH, JSON.stringify(arr, null, 2)); }

test('relaunch endpoint enqueues a copy of the history entry settings', async () => {
  const backup = fs.existsSync(HIST_PATH) ? fs.readFileSync(HIST_PATH, 'utf8') : null;
  try {
    writeHistory([{
      date: '2026-05-26T10:00:00Z',
      name: 'Test Campaign',
      mode: 'connect_only',
      profiles: ['Alex K.'],
      dailyLimit: 20,
      totalProcessed: 100,
      endReason: 'completed',
      settings: { profileIds: ['p1'], sheetUrl: 'https://docs.google.com/x', templates: {}, dailyLimit: 20 }
    }]);

    const res = await fetch('http://localhost:7110/api/history/0/relaunch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.queueId);
  } finally {
    if (backup !== null) fs.writeFileSync(HIST_PATH, backup);
  }
});
```

Note: integration test — requires the server running. If `node --test` doesn't have a running server, use a mocked unit test that calls the handler directly, OR spin up an in-process test app. Match existing test patterns in this repo (check `tests/` directory for any HTTP integration test as a model — likely there are none; existing tests are pure-helper).

If pure-helper testing is the norm: convert this to a function-level test that calls a `relaunchHistoryEntry(idx)` helper extracted from the route. Skill rule: match existing style. Confirm pattern by checking `tests/*.test.js` before writing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-relaunch.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the endpoint in server.js**

Find the history routes section (after `GET /api/history`). Add:

```js
app.post('/api/history/:idx/relaunch', requireSession, async (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const history = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    if (isNaN(idx) || idx < 0 || idx >= history.length) {
      return res.status(404).json({ error: 'history_idx_out_of_range' });
    }
    const entry = history[idx];
    if (!entry.settings) {
      return res.status(422).json({ error: 'history_entry_missing_settings' });
    }
    if (campaign.running) {
      // Enqueue instead of erroring — queue-only flow handles this
    }
    const config = entry.settings;
    const queuedName = entry.name + ' (rerun)';
    const queued = addToQueue({ name: queuedName, mode: entry.mode, ...config });
    res.json({ ok: true, queueId: queued.id, message: `Queued "${queuedName}"` });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
```

(Adjust to match exactly how the existing `POST /api/campaign/queue-only` route shapes its config — read that route first.)

- [ ] **Step 4: Run test**

Run: `node --test tests/history-relaunch.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/history-relaunch.test.js server.js
git commit -m "add: POST /api/history/:idx/relaunch endpoint to rerun finished campaigns"
```

---

### Task 3: PATCH /api/history/:idx/archive — soft-archive past entry

**Files:**
- Modify: `server.js` (route + history read/write helpers)
- Test: `tests/history-archive.test.js`

**Owner:** Subagent A

- [ ] **Step 1: Write the failing test**

```js
// tests/history-archive.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HIST_PATH = path.join(process.cwd(), 'data', 'history.json');

test('archive flips archived:true on the entry', async () => {
  const backup = fs.existsSync(HIST_PATH) ? fs.readFileSync(HIST_PATH, 'utf8') : null;
  try {
    fs.writeFileSync(HIST_PATH, JSON.stringify([
      { date: '2026-05-26T10:00:00Z', name: 'Test', mode: 'CC', settings: {} }
    ]));
    const res = await fetch('http://localhost:7110/api/history/0/archive', { method: 'PATCH' });
    assert.strictEqual(res.status, 200);
    const after = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    assert.strictEqual(after[0].archived, true);
  } finally {
    if (backup !== null) fs.writeFileSync(HIST_PATH, backup);
  }
});

test('GET /api/history?includeArchived=false hides archived', async () => {
  const backup = fs.existsSync(HIST_PATH) ? fs.readFileSync(HIST_PATH, 'utf8') : null;
  try {
    fs.writeFileSync(HIST_PATH, JSON.stringify([
      { date: '1', name: 'A', mode: 'CC', archived: true },
      { date: '2', name: 'B', mode: 'CC' }
    ]));
    const res = await fetch('http://localhost:7110/api/history?includeArchived=false');
    const list = await res.json();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'B');
  } finally {
    if (backup !== null) fs.writeFileSync(HIST_PATH, backup);
  }
});
```

(Same caveat as Task 2 — convert to in-process helper test if integration HTTP tests aren't the convention.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-archive.test.js`
Expected: FAIL

- [ ] **Step 3: Update GET /api/history to support the query param**

Find the existing `GET /api/history` handler. Modify:

```js
app.get('/api/history', requireSession, (req, res) => {
  const all = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
  const includeArchived = req.query.includeArchived !== 'false';
  const list = includeArchived ? all : all.filter(e => !e.archived);
  res.json(list);
});
```

(Default behavior — `includeArchived` unspecified — stays as before for backwards compat.)

- [ ] **Step 4: Add PATCH archive route**

```js
app.patch('/api/history/:idx/archive', requireSession, (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const history = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    if (isNaN(idx) || idx < 0 || idx >= history.length) {
      return res.status(404).json({ error: 'history_idx_out_of_range' });
    }
    history[idx].archived = true;
    fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
```

- [ ] **Step 5: Run test**

Run: `node --test tests/history-archive.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/history-archive.test.js server.js
git commit -m "add: PATCH /api/history/:idx/archive endpoint for soft-archiving past runs"
```

---

### Task 4: GET /api/history/:idx/log — filtered campaign.log

**Files:**
- Modify: `server.js`
- Test: `tests/history-log.test.js`

**Owner:** Subagent A

- [ ] **Step 1: Write the failing test**

```js
// tests/history-log.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HIST = path.join(process.cwd(), 'data', 'history.json');
const LOG = path.join(process.cwd(), 'data', 'campaign.log');

test('log endpoint returns lines mentioning campaign name', async () => {
  const histBackup = fs.existsSync(HIST) ? fs.readFileSync(HIST, 'utf8') : null;
  const logBackup = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : null;
  try {
    fs.writeFileSync(HIST, JSON.stringify([
      { date: '1', name: 'UniqueTestName', mode: 'CC', settings: {} }
    ]));
    fs.writeFileSync(LOG, [
      '2026-05-26T10:00:00Z [campaign:UniqueTestName] start',
      '2026-05-26T10:01:00Z [campaign:Other] noise',
      '2026-05-26T10:02:00Z [campaign:UniqueTestName] sent to Alice'
    ].join('\n'));
    const res = await fetch('http://localhost:7110/api/history/0/log');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.lines.length, 2);
    assert.ok(body.lines.every(l => l.includes('UniqueTestName')));
  } finally {
    if (histBackup !== null) fs.writeFileSync(HIST, histBackup);
    if (logBackup !== null) fs.writeFileSync(LOG, logBackup);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-log.test.js`
Expected: FAIL

- [ ] **Step 3: Implement route**

```js
app.get('/api/history/:idx/log', requireSession, (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const history = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    if (isNaN(idx) || idx < 0 || idx >= history.length) {
      return res.status(404).json({ error: 'history_idx_out_of_range' });
    }
    const name = history[idx].name;
    const logFile = path.join(dataDir(), 'campaign.log');
    if (!fs.existsSync(logFile)) return res.json({ lines: [] });
    const all = fs.readFileSync(logFile, 'utf8').split('\n');
    const filtered = all.filter(l => l.includes(name));
    const last500 = filtered.slice(-500);
    res.json({ lines: last500, name, total: filtered.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
```

- [ ] **Step 4: Run test**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/history-log.test.js server.js
git commit -m "add: GET /api/history/:idx/log endpoint for per-campaign log filtering"
```

---

## Phase 2 — CSS extraction (parallel with Phase 1)

### Task 5: Extract v0.3 styles to scoped stylesheet

**Files:**
- Create: `public/css/dashboard-v0.3.css`
- Modify: `public/index.html` (one `<link>` tag)

**Owner:** Subagent B (Phase 2 CSS)

- [ ] **Step 1: Inspect current selector collision risk**

Run: `grep -E "\.dock|\.glyph|\.section-rail|\.section-band|\.vj-|\.vc-|\.pa-|\.cal-|\.past-collapsed" /Users/antoniovarlese/ortus-gologin-clone/public/css/style.css | head -30`

Expected: identify which v0.3 class names collide with existing rules. Record the list.

- [ ] **Step 2: Copy v0.3 styles into the new file**

Open `public/sketches/dashboard-v0.3-unified.html`, copy everything between `<style>` and `</style>` (lines 8-783 approximately). Paste into `public/css/dashboard-v0.3.css`.

- [ ] **Step 3: Scope every selector under body[data-dashboard='v3']**

In `public/css/dashboard-v0.3.css`:
- For every selector that starts at column 0 (top-level rules, not inside @keyframes / @media), prefix with `body[data-dashboard='v3'] `.
- Exception: `:root` block stays as-is (CSS custom properties are global).
- Exception: `@keyframes` and `@font-face` stay as-is.
- Exception: `body.theme-dark` selectors become `body[data-dashboard='v3'].theme-dark`.

Mechanical transformation. Use a quick sed-style pass or do it manually. Verify with a grep that every rule outside `:root` / `@keyframes` is scoped.

- [ ] **Step 4: Link the file in index.html**

Find the existing `<link rel="stylesheet" href="/css/style.css">` in `public/index.html` `<head>`. Add immediately after it:

```html
<link rel="stylesheet" href="/css/dashboard-v0.3.css">
```

- [ ] **Step 5: Verify**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 5
# Manual: open app, confirm existing dashboard renders identically
# (no v0.3 markup yet; the CSS is loaded but inert)
```

Expected: existing 7-tab dashboard renders normally. No console errors. View → Sources confirms `dashboard-v0.3.css` is loaded.

- [ ] **Step 6: Commit**

```bash
git add public/css/dashboard-v0.3.css public/index.html
git commit -m "add: scoped dashboard-v0.3.css stylesheet (inert until body attr toggled)"
```

---

## Phase 3 — Markup swap

### Task 6: Replace #dashboard-view contents with v0.3 sections

**Files:**
- Modify: `public/index.html` (#dashboard-view region only)

**Owner:** Subagent C (Phase 3 markup). Solo (depends on Phase 2).

- [ ] **Step 1: Identify the exact region**

```bash
grep -n "id=\"dashboard-view\"" /Users/antoniovarlese/ortus-gologin-clone/public/index.html
```

Find the opening `<div id="dashboard-view">` and its matching closing `</div>`. Record the line range. Do NOT modify anything outside this range.

- [ ] **Step 2: Copy v0.3 markup from the sketch**

From `public/sketches/dashboard-v0.3-unified.html`, extract the `<main class="main">` ... `</main>` block (the dashboard sections only — Active card, Monitoring section, Up Next section-band, Calendar section-band, Past section-band). DO NOT copy the wizard modal or the sidebar from the sketch.

The structural skeleton to paste in:

```html
<div id="dashboard-view">
  <!-- ── NOW ACTIVE (Status Card · variant J) ─────────────────── -->
  <section class="vj-card" id="active-card" aria-labelledby="sect-active">
    <!-- ... eyebrow, glyph, name, hbar, hero, controls, details (copy from sketch) ... -->
  </section>

  <!-- ── MONITORING (Status Card · variant J, mini by default) ─── -->
  <section class="vj-card is-monitor is-mini" id="monitoring-section" aria-labelledby="sect-monitoring">
    <!-- ... mini-left, mini-mid, mini-controls + full-J markup (copy from sketch) ... -->
    <!-- IMPORTANT: REMOVE the "Pause watch" button per Q3 resolution -->
  </section>

  <!-- ── UP NEXT ─────────────────────────────────────────────── -->
  <section class="section-band is-queue" aria-labelledby="sect-queue">
    <div class="section-rail">
      <h2 id="sect-queue">Up Next <small><span id="queueCount">0</span> waiting</small></h2>
      <div class="section-rail-line"></div>
      <button class="section-rail-action" onclick="startNewCampaign()">+ Add to queue</button>
    </div>
    <div role="grid" aria-labelledby="sect-queue" id="queueList"></div>
  </section>

  <!-- ── THIS WEEK (Calendar) ────────────────────────────────── -->
  <section class="section-band is-week" aria-labelledby="sect-week">
    <div class="section-rail">
      <h2 id="sect-week">This Week <small id="weekRange">— —</small></h2>
      <div class="section-rail-line"></div>
      <div class="section-rail-cal">
        <button onclick="dashCalPrev()" aria-label="Previous week">←</button>
        <button class="today" onclick="dashCalToday()">Today</button>
        <button onclick="dashCalNext()" aria-label="Next week">→</button>
      </div>
      <button class="section-rail-action" onclick="startNewCampaign()">+ Schedule</button>
    </div>
    <div class="cal-grid" id="calGrid"></div>
  </section>

  <!-- ── PAST ────────────────────────────────────────────────── -->
  <section class="section-band is-past" aria-labelledby="sect-past">
    <div class="section-rail">
      <h2 id="sect-past">Past <small><span id="pastCount">0</span> campaigns</small></h2>
      <div class="section-rail-line"></div>
      <button class="section-rail-action" id="past-toggle-btn" onclick="togglePastExpanded()">Show all</button>
    </div>
    <div class="past-collapsed" id="pastCollapsed">
      <div class="pc-count" id="pcCount">0<span class="pc-lbl">past</span></div>
      <div class="pc-summary" id="pcSummary">no finished campaigns yet</div>
    </div>
    <div role="grid" aria-labelledby="sect-past" id="pastList" style="display:none;"></div>
  </section>
</div>
```

Copy the full markup for each section verbatim from the sketch, then make these adjustments:
- Remove the Monitoring `<button class="dock-btn" ...onclick="togglePauseMonitoring()">` (pause-watch button) and its SVG per Q3 resolution
- Rewrite all `onclick="toast(...)"` mock handlers to call real `window.*` functions (the next task wires those up)
- Replace hardcoded campaign data in the markup (`EU Founder Push Q2`, `49%`, etc.) with placeholders the renderers will fill (e.g., `<span id="activeName">…</span>`, `<span id="activeProgress">0</span>%`)

Mapping table — replace inline handlers with the target functions:

| Old (mock) | New (real wiring — Phase 4 will define these as `window.*`) |
|---|---|
| `toggleDetails('active-card', this)` | `window.toggleActiveDetails(this)` |
| `togglePauseActive()` | `window.dashPauseActive()` |
| `stopActiveCampaign()` | `window.dashStopActive()` |
| `restartActive()` | `window.dashRestartActive()` |
| `copyLive('EU Founder Push Q2', 'C+I')` | `window.dashCopyActiveToQueue()` |
| `toast('Run check now (mock)')` | `window.dashBulkCheck()` |
| `toast('Open EU Founder Push Q2 (mock)')` | `window.dashOpenActive()` |
| `toast('Open batch settings (mock)')` | `window.dashOpenBatchSettings()` |
| `toggleMonitorMini()` | `window.toggleMonitorMini()` |
| `toggleDetails('monitoring-section', this)` | `window.toggleMonitorDetails(this)` |
| `stopMonitoring()` | `window.dashStopMonitoring()` |
| `forceSweep()` | `window.dashForceSweep()` |
| `copyLive('EU Founder Push Q1', 'C+I')` | `window.dashCopyMonitorToQueue()` |
| `togglePastExpanded()` | `window.togglePastExpanded()` |
| `openWizard()` / `startFromWizard()` | `window.startNewCampaign()` (already exists in app.js:8376) |

- [ ] **Step 3: Set the data-dashboard attribute on body**

In `public/index.html`, find the `<body>` opening tag (around line 12-15). Add the attribute:

```html
<body data-dashboard="v3">
```

This activates the scoped v0.3 CSS.

- [ ] **Step 4: Verify markup loads**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 5
```

Manual: open the app on `#/`. Expected: v0.3 layout shows (placeholders/empty data is OK — the renderers don't exist yet). Wizard still opens via "+ Start new campaign". No console errors related to missing handlers (the `window.*` functions will be undefined but onclick won't fire until clicked).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "swap: replace #dashboard-view region with v0.3 unified layout markup"
```

---

## Phase 4 — JS renderers + wiring

The biggest phase. Split into 5 sub-tasks per section. Each commits atomically with verification.

### Task 7: Refactor pollStatus + add renderActiveCard

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Phase 4 — Active sub-phase)

- [ ] **Step 1: Locate existing pollStatus + cockpit renderer**

```bash
grep -n "function pollStatus\|function renderCockpit\|function updateCockpit" /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js
```

Record the line ranges. Read each in full.

- [ ] **Step 2: Add window.renderActiveCard**

Place after the existing dashboard renderers (near `refreshActiveCampaign`). Pseudocode:

```js
window.renderActiveCard = function(status) {
  const card = document.getElementById('active-card');
  if (!card) return;
  if (!status.running) {
    // Empty state: hide card or show "No active campaign"
    card.classList.add('is-empty');
    card.querySelector('.vj-name').textContent = 'No campaign running';
    return;
  }
  card.classList.remove('is-empty');
  card.querySelector('.vj-name').textContent = status.name;
  card.querySelector('.vj-glyph-circle').textContent = modeBadge(status.mode); // 'C+I' from 'connect_and_introduce'
  const pct = Math.round((status.totalProcessed / status.totalTargets) * 100);
  card.querySelector('.vj-hbar > i').style.width = pct + '%';
  card.querySelector('.vj-hero-row .num').innerHTML = pct + '<span class="sub">%</span>';
  // Update stats: accounts, accepted, replies, status label
  // Update batch ETA (parse from status.currentAction.endsAt or compute from log)
  // Update details panel log lines (last 6 from status.logs[])
};

function modeBadge(mode) {
  const map = {
    connect_only: 'CC',
    connect_and_introduce: 'C+I',
    introduce_back: 'IB',
    message_only: 'DM',
    inmail_only: 'IM',
    check_status: 'CS',
    open_profile_only: 'OP',
  };
  return map[mode] || mode;
}
```

- [ ] **Step 3: Wire pollStatus to call renderActiveCard**

In existing `pollStatus()`, after the existing `updateCockpit(status)` call (or wherever it processes the response), add:

```js
window.renderActiveCard(status);
```

- [ ] **Step 4: Add real handlers**

```js
window.dashPauseActive = async function() {
  const endpoint = (this._paused) ? '/api/campaign/resume' : '/api/campaign/pause';
  await fetch(endpoint, { method: 'POST' });
  pollStatus(); // immediate refresh
};

window.dashStopActive = async function() {
  if (!confirm('Stop the active campaign? It will move to Past.')) return;
  await fetch('/api/campaign/stop', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
  pollStatus();
};

window.dashRestartActive = async function() {
  if (!confirm('Restart? Progress will reset.')) return;
  await fetch('/api/campaign/stop', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({full:true}) });
  // Then re-queue via current campaign's last-used config:
  // Use existing /api/presets/_last_used (already wired by start flow)
  // OR get current campaign config from status and POST queue-only
  const status = await (await fetch('/api/campaign/status')).json();
  await fetch('/api/campaign/queue-only', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: status.name, mode: status.mode, profileIds: status.profileIds, /* etc */ })
  });
  pollStatus();
};

window.dashCopyActiveToQueue = async function() {
  const status = await (await fetch('/api/campaign/status')).json();
  await fetch('/api/campaign/queue-only', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: status.name + ' (copy)', mode: status.mode, profileIds: status.profileIds, sheetUrl: status.sheetUrl, /* full settings */ })
  });
  refreshDashboardQueue();
  showCampaignToast('Copied "' + status.name + '" to queue');
};

window.dashBulkCheck = async function() {
  const status = await (await fetch('/api/campaign/status')).json();
  const r = await fetch('/api/bulk-check-now', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sheetUrl: status.sheetUrl, profileIds: status.profileIds })
  });
  const body = await r.json();
  if (body.ok) showCampaignToast('Bulk check running…');
  else showCampaignToast('Bulk check failed: ' + body.error);
};

window.dashOpenActive = function() {
  window.location.hash = '#/new';
  setTimeout(() => document.getElementById('nav-status')?.scrollIntoView({behavior:'smooth'}), 100);
};

window.dashOpenBatchSettings = function() {
  window.location.hash = '#/new';
  setTimeout(() => document.getElementById('nav-pace')?.scrollIntoView({behavior:'smooth'}), 100);
};

window.toggleActiveDetails = function(btn) {
  const card = document.getElementById('active-card');
  const opening = !card.classList.contains('is-detailed');
  card.classList.toggle('is-detailed');
  btn.querySelector('svg').style.transform = opening ? 'rotate(180deg)' : 'rotate(0deg)';
  btn.setAttribute('data-tip', opening ? 'Hide details' : 'Show details');
};
```

- [ ] **Step 5: Manual verify**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 5
```

Open app. If a campaign is running, the Active card should show real name/progress/stats. Click Pause → real pause fires. Click Show details → details panel opens. Click Run check now → bulk-check toasts. Confirm no console errors.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "wire: Active card renderer + real handlers (pause, stop, restart, copy, bulk-check)"
```

---

### Task 8: renderMonitoringCard + mini-toggle + force-sweep

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Monitoring sub-phase)

- [ ] **Step 1: Add window.renderMonitoringCard**

Pseudocode:

```js
window.renderMonitoringCard = function(status) {
  const sect = document.getElementById('monitoring-section');
  if (!sect) return;
  if (status.state !== 'monitoring') {
    sect.style.display = 'none';
    return;
  }
  sect.style.display = '';
  // Populate mini state fields
  sect.querySelector('.vj-mini-row1 .name').textContent = status.name;
  // Compute monitoring day X of 7 from sendingEndedAt / monitoringUntil
  const dayOfWindow = computeMonitoringDay(status.sendingEndedAt);
  const totalDays = 7;
  const pct = Math.round((dayOfWindow / totalDays) * 100);
  sect.querySelector('.vj-mini-row1 .num').innerHTML = pct + '<span class="pct">%</span>';
  sect.querySelector('.vj-mini-bar > i').style.width = pct + '%';
  // ...etc for sent/accepted/sweep ETA
  // Same for full state (the duplicate markup in the same section)
};

function computeMonitoringDay(sendingEndedAt) {
  if (!sendingEndedAt) return 0;
  const ms = Date.now() - new Date(sendingEndedAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
}
```

- [ ] **Step 2: Add real handlers**

```js
window.toggleMonitorMini = function() {
  const card = document.getElementById('monitoring-section');
  const goingMini = !card.classList.contains('is-mini');
  card.classList.toggle('is-mini');
  if (goingMini) card.classList.remove('is-detailed');
};

window.toggleMonitorDetails = function(btn) {
  const card = document.getElementById('monitoring-section');
  const opening = !card.classList.contains('is-detailed');
  card.classList.toggle('is-detailed');
  btn.querySelector('svg').style.transform = opening ? 'rotate(180deg)' : 'rotate(0deg)';
};

window.dashStopMonitoring = async function() {
  if (!confirm('Stop monitoring? Remaining unaccepted leads will be stamped Closed.')) return;
  await fetch('/api/monitoring/stop', { method: 'POST' });
  pollStatus();
};

window.dashForceSweep = async function() {
  await fetch('/api/monitoring/check-now', { method: 'POST' });
  showCampaignToast('Sweep firing now…');
};

window.dashCopyMonitorToQueue = async function() {
  const r = await fetch('/api/monitoring/state');
  const m = await r.json();
  await fetch('/api/campaign/queue-only', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: m.name + ' (rerun)', mode: m.mode, profileIds: m.profileIds, sheetUrl: m.sheetUrl })
  });
  refreshDashboardQueue();
  showCampaignToast('Copied to queue');
};
```

- [ ] **Step 3: Wire pollStatus**

In pollStatus, after `renderActiveCard(status)`, add `window.renderMonitoringCard(status)`.

- [ ] **Step 4: Verify**

Restart dev:app. If a campaign just finished and is in monitoring, the mini card shows real data. Expand chevron → full view. Force sweep button → real endpoint. Stop watch → confirm modal, real call.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "wire: Monitoring card renderer + mini-toggle, details, stop, force-sweep"
```

---

### Task 9: renderUpNextDeck + drag-reorder + queue actions

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Up Next sub-phase)

- [ ] **Step 1: Replace renderQueue + add drag handlers**

The v0.3 sketch already has a `renderQueue()` function. Adapt it to:
- Fetch from `/api/queue` instead of using local `queue[]`
- Wire dock buttons to real endpoints (existing `/api/queue/:id` for delete, new `PATCH /api/queue/:id` for edit, `/api/queue/run-next` + `/api/queue/reorder` for "Start now")
- Wire drag-handle to HTML5 DnD that posts `/api/queue/reorder` with the new id ordering

Pseudocode:

```js
window.renderUpNextDeck = async function() {
  const list = document.getElementById('queueList');
  if (!list) return;
  const r = await fetch('/api/queue');
  const { queue } = await r.json();
  document.getElementById('queueCount').textContent = queue.length;

  list.innerHTML = '';
  const stack = el('div', { class: 'vc-stack' });
  queue.forEach((q, idx) => {
    // ... render showcase (idx===0) or vc-mini (idx>0)
    // Each item gets data-queue-id="<id>" attribute
    // Drag handlers attached:
    // - draggable="true" on the row
    // - dragstart: record dragged id
    // - dragover: preventDefault
    // - drop: read dropped id, compute new ordering, POST /api/queue/reorder
  });
  list.append(stack);

  enableQueueDnD(); // wire HTML5 DnD
};

function enableQueueDnD() {
  const rows = document.querySelectorAll('#queueList [data-queue-id]');
  let dragId = null;
  rows.forEach(row => {
    row.addEventListener('dragstart', e => { dragId = row.dataset.queueId; });
    row.addEventListener('dragover', e => { e.preventDefault(); });
    row.addEventListener('drop', async e => {
      e.preventDefault();
      const dropId = row.dataset.queueId;
      if (dropId === dragId) return;
      const current = Array.from(rows).map(r => r.dataset.queueId);
      const fromIdx = current.indexOf(dragId);
      current.splice(fromIdx, 1);
      const toIdx = current.indexOf(dropId);
      current.splice(toIdx, 0, dragId);
      const r = await fetch('/api/queue/reorder', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ids: current })
      });
      if (!r.ok) {
        const body = await r.json();
        showCampaignToast('Reorder failed: ' + body.error);
      }
      renderUpNextDeck();
    });
  });
}
```

- [ ] **Step 2: Add queue dock handlers**

```js
window.dashStartQueueItem = async function(id) {
  // Move to head, then run-next
  // Find current position
  const r = await fetch('/api/queue');
  const { queue } = await r.json();
  const ids = queue.map(q => q.id);
  const fromIdx = ids.indexOf(id);
  if (fromIdx > 0) {
    ids.splice(fromIdx, 1);
    ids.unshift(id);
    await fetch('/api/queue/reorder', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ ids })
    });
  }
  const launchR = await fetch('/api/queue/run-next', { method: 'POST' });
  const body = await launchR.json();
  if (body.ok) showCampaignToast('Started ' + queue[fromIdx].name);
  else showCampaignToast('Cannot start: ' + (body.reason || 'busy'));
};

window.dashRescheduleQueueItem = async function(id) {
  const when = await promptModal({ label: 'Reschedule to ISO timestamp (e.g. 2026-05-28T10:00:00Z):' });
  if (!when) return;
  await fetch('/api/queue/' + id, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ scheduledAt: when })
  });
  renderUpNextDeck();
};

window.dashEditQueueItem = async function(id) {
  // Load queue config, open wizard pre-filled
  const r = await fetch('/api/queue/' + id);
  const entry = await r.json();
  // Use existing draft-edit pattern OR
  // window.location.hash = '#/new'
  // populate wizard fields from entry.config
  startNewCampaign(); // existing function; refine to accept a preload arg
};

window.dashDuplicateQueueItem = async function(id) {
  const r = await fetch('/api/queue/' + id);
  const entry = await r.json();
  await fetch('/api/campaign/queue-only', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ ...entry.config, name: entry.name + ' (copy)' })
  });
  renderUpNextDeck();
};

window.dashRemoveQueueItem = async function(id) {
  if (!confirm('Remove from queue?')) return;
  await fetch('/api/queue/' + id, { method: 'DELETE' });
  renderUpNextDeck();
};
```

- [ ] **Step 3: Hook renderUpNextDeck to existing 5s poll**

The existing `_dashboardPollTimer` (~5s) already calls `refreshDashboardQueue`. Replace that call with `renderUpNextDeck()`, or add `renderUpNextDeck()` alongside it.

Also call once on dashboard route entry: in `applyRoute()` or its dashboard-init equivalent.

- [ ] **Step 4: Verify**

Restart dev:app. Queue items render in v0.3 style. Drag the second item above the first → confirm via curl or DevTools Network tab that `/api/queue/reorder` is called and queue reorders. Click remove → entry vanishes. Click duplicate → new entry appears.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "wire: Up Next deck renderer + drag-reorder + queue dock actions"
```

---

### Task 10: renderCalendarGrid (client-side computation)

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Calendar sub-phase)

- [ ] **Step 1: Add week state**

```js
let _calWeekOffset = 0; // weeks from current week (0 = this week, +1 = next)

window.dashCalPrev = function() { _calWeekOffset--; renderCalendarGrid(); };
window.dashCalNext = function() { _calWeekOffset++; renderCalendarGrid(); };
window.dashCalToday = function() { _calWeekOffset = 0; renderCalendarGrid(); };
```

- [ ] **Step 2: Implement renderCalendarGrid**

```js
window.renderCalendarGrid = async function() {
  const grid = document.getElementById('calGrid');
  if (!grid) return;

  const today = new Date();
  const monday = startOfWeek(today, _calWeekOffset);
  document.getElementById('weekRange').textContent = formatWeekRange(monday);

  // Fetch schedules + status
  const [schedR, statusR] = await Promise.all([
    fetch('/api/schedules'),
    fetch('/api/campaign/status')
  ]);
  const schedules = await schedR.json();
  const status = await statusR.json();

  // Build 7 day cells
  grid.innerHTML = '';
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    days.push({
      date: d,
      isToday: sameDay(d, today),
      chips: []
    });
  }

  // Running campaign chip on today
  if (status.running && _calWeekOffset === 0) {
    const todayCell = days.find(x => x.isToday);
    if (todayCell) todayCell.chips.push({
      mode: modeBadge(status.mode),
      name: status.name,
      running: true
    });
  }

  // Scheduled (cron) entries — expand to dates within visible week
  for (const s of schedules) {
    if (!s.enabled) continue;
    const fireDates = expandCronInRange(s.cron, monday, addDays(monday, 7));
    for (const fd of fireDates) {
      const cell = days.find(x => sameDay(x.date, fd));
      if (cell) cell.chips.push({
        mode: modeBadge(s.mode),
        name: s.name,
        time: formatTime(fd),
        faded: true
      });
    }
  }

  // Monitoring next-sweep chip
  if (status.state === 'monitoring' && status.nextCheckAt) {
    const next = new Date(status.nextCheckAt);
    const cell = days.find(x => sameDay(x.date, next));
    if (cell) cell.chips.push({
      mode: 'SW',
      name: 'Monitoring sweep · ' + status.name,
      time: formatTime(next),
      faded: false
    });
  }

  // Render each cell
  for (const day of days) {
    const cell = el('div', { class: 'cal-cell' + (day.isToday ? ' today' : '') });
    cell.append(el('div', { class:'cal-head' }, [
      el('div', { class:'cal-dow' }, dayOfWeek(day.date)),
      el('div', { class:'cal-date' }, String(day.date.getDate()))
    ]));
    for (const c of day.chips.slice(0, 3)) {
      const chip = el('div', { class: 'cal-chip' + (c.running ? ' running' : '') + (c.faded ? ' faded' : '') });
      chip.append(el('span', { class:'badge' }, c.mode));
      if (c.time) chip.append(el('span', { class:'time' }, c.time));
      chip.append(el('span', { class:'name' }, c.name));
      cell.append(chip);
    }
    if (day.chips.length > 3) {
      cell.append(el('div', { class:'cal-more' }, '+ ' + (day.chips.length - 3) + ' more'));
    }
    grid.append(cell);
  }
};

// Helpers (place near other date helpers in app.js):
function startOfWeek(d, weekOffset) {
  const base = new Date(d);
  const day = base.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  base.setDate(base.getDate() + diff + (weekOffset * 7));
  base.setHours(0, 0, 0, 0);
  return base;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayOfWeek(d) { return ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()]; }
function formatTime(d) { return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
function formatWeekRange(monday) {
  const sunday = addDays(monday, 6);
  return monday.getDate() + ' — ' + sunday.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][sunday.getMonth()];
}
function expandCronInRange(cronExpr, start, end) {
  // Basic 5-field cron expansion. Use node-cron's API if available client-side,
  // OR write a minimal expander for the common cases (daily, weekly, hourly).
  // If complex, defer: just show the cron entry's "next fire" date if it falls in range.
  // PROD-SAFE FALLBACK: parse the cron expression to find next N fires (max 7), filter to range.
  return []; // placeholder — implement per repo conventions
}
```

Note: `expandCronInRange` is the only non-trivial helper. If the cron expressions in `data/schedules.json` are all simple ("0 14 * * 3" — Wednesday 2pm), a minimal parser handling 5-field crontab is enough. If they're more complex, use `cron-parser` (npm) or call a new lightweight endpoint that returns the next 7 fire dates. **Open mini-question: which?**

For v1 simplicity, recommend: if `schedules.json` typically has plain `H M * * D`-style crons, write a 30-line parser inline. If anything fancier (lists, ranges, /step), defer this and use a placeholder: "Calendar shows schedule names but not cron-derived times" with a TODO.

- [ ] **Step 3: Wire calendar to dashboard init**

In `applyRoute('#/')` or dashboard-init equivalent, call `renderCalendarGrid()`.

- [ ] **Step 4: Verify**

Restart dev:app. Calendar grid shows 7 day cells. Today is highlighted (green dot). Running campaign chip on today. Cron schedules show on their fire days. Prev/Next/Today nav re-renders.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "wire: Calendar grid renderer (client-side from /api/schedules + status)"
```

---

### Task 11: renderPastSection + restart + archive

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Past sub-phase)

- [ ] **Step 1: Add renderers**

```js
window.renderPastSection = async function() {
  const collapsedEl = document.getElementById('pastCollapsed');
  const listEl = document.getElementById('pastList');
  if (!collapsedEl || !listEl) return;

  const r = await fetch('/api/history?includeArchived=false');
  const all = await r.json();
  const sorted = all.slice().reverse(); // newest first
  document.getElementById('pastCount').textContent = sorted.length;

  // Update collapsed summary
  if (sorted.length === 0) {
    document.getElementById('pcCount').innerHTML = '0<span class="pc-lbl">past</span>';
    document.getElementById('pcSummary').innerHTML = 'no finished campaigns yet';
  } else {
    const latest = sorted[0];
    document.getElementById('pcCount').innerHTML = sorted.length + '<span class="pc-lbl">past</span>';
    const replyRate = latest.totalProcessed ? ((latest.successCount / latest.totalProcessed) * 100).toFixed(1) : '0.0';
    const ago = _humanAgo(new Date(latest.date).getTime());
    document.getElementById('pcSummary').innerHTML =
      'last finished <b>' + escHtml(latest.name) + '</b> · ' + ago + ' · <b>' + replyRate + '%</b> reply rate';
  }

  // Render expanded list (visible only when expanded)
  listEl.innerHTML = '';
  const wrap = el('div', { class: 'pa-list' });
  sorted.forEach((p, i) => {
    const row = el('div', { class: 'pa-row' });
    row.append(el('div', { class: 'glyph' }, modeBadge(p.mode)));
    row.append(el('div', { class: 'pa-name' }, p.name));
    row.append(el('div', { class: 'pa-when' }, _humanAgo(new Date(p.date).getTime())));
    row.append(el('div', { class: 'pa-stats', html: '<b>' + (p.totalProcessed||0) + '</b> sent · <b>' + (p.successCount||0) + '</b> replies' }));
    if (p.endReason === 'stopped' || p.fullStop) {
      row.append(el('div', { class: 'pa-stopped' }, 'Stopped early'));
    } else {
      const rate = p.totalProcessed ? ((p.successCount / p.totalProcessed) * 100).toFixed(1) : '0.0';
      row.append(el('div', { class: 'pa-rate', html: rate + '<span class="pct">%</span>' }));
    }
    row.append(buildPastDock(p, i)); // i is the index in sorted; need original idx for archive
    wrap.append(row);
  });
  listEl.append(wrap);
};

window.togglePastExpanded = function() {
  const collapsedEl = document.getElementById('pastCollapsed');
  const listEl = document.getElementById('pastList');
  const btn = document.getElementById('past-toggle-btn');
  const isExpanded = listEl.style.display !== 'none';
  collapsedEl.style.display = isExpanded ? 'grid' : 'none';
  listEl.style.display = isExpanded ? 'none' : 'block';
  btn.textContent = isExpanded ? 'Show all' : 'Collapse';
};
```

- [ ] **Step 2: Add real handlers**

```js
window.dashRerunPast = async function(originalIdx) {
  // originalIdx is the on-disk index (NOT the reversed/sorted display index)
  const r = await fetch('/api/history/' + originalIdx + '/relaunch', { method: 'POST' });
  const body = await r.json();
  if (body.ok) {
    showCampaignToast('Queued: ' + body.message);
    renderUpNextDeck();
  } else {
    showCampaignToast('Rerun failed: ' + body.error);
  }
};

window.dashOpenPastLog = async function(originalIdx) {
  const r = await fetch('/api/history/' + originalIdx + '/log');
  const body = await r.json();
  // Show in a modal — reuse existing modal pattern from app.js (e.g. preview-modal)
  showLogModal(body.name, body.lines);
};

window.dashCopyPastToQueue = async function(originalIdx) {
  const r = await fetch('/api/history');
  const all = await r.json();
  const entry = all[originalIdx];
  if (!entry?.settings) return showCampaignToast('No settings to copy');
  await fetch('/api/campaign/queue-only', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: entry.name + ' (copy)', mode: entry.mode, ...entry.settings })
  });
  renderUpNextDeck();
  showCampaignToast('Copied to queue');
};

window.dashExportPast = function(originalIdx) {
  // Existing /api/export/csv exports state.json processed leads.
  // No per-history-entry CSV today — use the same endpoint for now.
  window.open('/api/export/csv', '_blank');
};

window.dashArchivePast = async function(originalIdx) {
  if (!confirm('Archive this campaign? It will be hidden from the list.')) return;
  await fetch('/api/history/' + originalIdx + '/archive', { method: 'PATCH' });
  renderPastSection();
};

function showLogModal(name, lines) {
  // Reuse existing modal markup — find an empty modal slot or create a minimal one
  // For v1: window.alert(lines.join('\n').slice(0, 5000)); // crude but functional
  // Better: use existing #preview-modal or #campaign-toast pattern
}

function buildPastDock(p, sortedIdx) {
  // The on-disk index is (total - 1 - sortedIdx) where total = past[].length BEFORE reverse
  // Track this carefully — past delete-batch already does this calculation in app.js
  const originalIdx = sortedIdx; // PLACEHOLDER — compute correctly based on reverse direction
  const dock = el('div', { class: 'dock', /* ... */ });
  // ... primary = rerun (SVG_RESTART), trigger = chevron, actions = openLog, copy, export, archive
  return dock;
}
```

- [ ] **Step 3: Verify**

Restart dev:app. Past collapsed summary shows real "last finished" entry. "Show all" expands to real list. Rerun → enqueues copy. Archive → row disappears. Export → CSV downloads.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "wire: Past section renderer + restart/archive/export/copy actions"
```

---

### Task 12: Cleanup — remove dead 7-tab renderers

**Files:**
- Modify: `public/js/app.js`

**Owner:** Subagent D (Cleanup)

- [ ] **Step 1: Identify dead functions**

The 7-tab structure had these renderers (verify against app.js):
- `dashInit`, `dashSetTab`, `dashShowPanel`, `dashUpdateCounts`
- `refreshActiveCampaign` (if its only callsite was the dashboard tab)
- `refreshDashboardQueue`, `refreshDashboardSchedules`, `refreshDashboardDrafts`, `refreshPastCampaigns`
- `renderPastBulkBar`, `enqueuePendingDeletes`, `undoPendingDeletes`, `commitPendingDeletes` (past undo flow — may want to keep or rebuild)
- Any helper bound to `.dash-tab` selectors

Grep each before deletion to confirm zero callsites remain:

```bash
grep -n "refreshActiveCampaign\|refreshDashboardQueue\|dashSetTab\|dashShowPanel" public/js/app.js
```

If a function still has callsites elsewhere in the codebase (e.g., wizard still calls `refreshActiveCampaign`), leave it. Karpathy rule: don't delete pre-existing dead code unless asked.

- [ ] **Step 2: Delete confirmed-dead renderers**

For each confirmed-dead function, delete its definition. Leave a one-line breadcrumb comment if helpful for git-archeology.

- [ ] **Step 3: Verify**

Restart dev:app. Confirm dashboard still works exactly the same. No console errors about missing functions.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "cleanup: remove dead 7-tab dashboard renderers replaced by v0.3 wiring"
```

---

## Phase 5 — Verification (manual)

### Task 13: Full operator workflow click-through

**Files:** none (manual verification)

**Owner:** Antonio + Claude

- [ ] **Step 1: Restart Electron fresh**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 5
```

- [ ] **Step 2: Run the operator workflow checklist**

For each item, verify the action fires (DevTools Network tab + visible UI change):

- [ ] Open app → dashboard renders v0.3 layout
- [ ] No console errors on initial load
- [ ] Click "+ Start new campaign" → wizard opens
- [ ] Fill wizard with a test campaign → submit → returns to dashboard → new entry in Up Next
- [ ] Active card: if a campaign is running, real data shows; if not, empty state shows
- [ ] Active card pause/resume button → fires `/api/campaign/pause` and `/api/campaign/resume`
- [ ] Active card stop button → confirm modal → fires `/api/campaign/stop`
- [ ] Active card "Show details" chevron → expands, shows real log lines
- [ ] Active card "Run check now" → fires `/api/bulk-check-now`
- [ ] Active card "Open" → switches to wizard
- [ ] Monitoring card mini-state → expand chevron expands to full
- [ ] Monitoring "Force sweep now" → fires `/api/monitoring/check-now`
- [ ] Monitoring "Stop watch" → confirm modal → fires `/api/monitoring/stop`
- [ ] Up Next → 3+ queue items render
- [ ] Drag the 3rd item to position 1 → fires `/api/queue/reorder`, list reorders
- [ ] Click "Remove" on a queue item → fires `DELETE /api/queue/:id`
- [ ] Click "Duplicate" → fires `/api/campaign/queue-only`
- [ ] Calendar → today's cell highlighted; running chip on today; scheduled chips on their days
- [ ] Calendar prev/next/today nav → re-renders week
- [ ] Past collapsed → shows last finished campaign summary
- [ ] "Show all" → expands to full list
- [ ] Past "Rerun" → fires `/api/history/:idx/relaunch`, new queue entry appears
- [ ] Past "Archive" → fires `PATCH /api/history/:idx/archive`, row disappears
- [ ] Past "Open log" → opens modal with filtered log lines
- [ ] Right-pane still shows Parked, Warnings, Passover, Selected, Next schedule, Live activity
- [ ] Sidebar: Theme toggle works, Send test fires `/api/notify/test`, Sign out fires `/api/auth/logout`
- [ ] Restart Electron → state persists, dashboard re-renders correctly

- [ ] **Step 3: Read console for any errors**

```bash
# In the Electron renderer DevTools console, confirm zero errors
# Or use claude-in-chrome MCP if attached
```

- [ ] **Step 4: Commit final acceptance**

If all checks pass:

```bash
git add docs/superpowers/specs/2026-05-27-dashboard-v0.3-integration-design.md docs/superpowers/plans/2026-05-27-dashboard-v0.3-integration-plan.md
git commit -m "docs: dashboard v0.3 integration spec + plan (shipped 2026-05-27)"
```

---

## Open implementation details (flag during execution if blockers)

1. **Cron expansion in Calendar** (Task 10): if cron expressions in `data/schedules.json` use anything beyond plain `M H * * D`, either install `cron-parser` OR add a tiny server endpoint `GET /api/schedules/expand?from=&to=` that returns concrete fire dates. Decide during Task 10.
2. **Mode badge mapping** for unusual modes: `inmail_only` → 'IM', `check_status` → 'CS', `open_profile_only` → 'OP'. Cross-check against `MODES` array in v0.3 sketch.
3. **History idx mapping** (Task 11): the on-disk index is the position in the file's array (oldest first). The display reverses to newest-first. The `originalIdx` passed to `dashArchivePast` etc. must be `total - 1 - sortedIdx`. Verify carefully.
4. **showLogModal** (Task 11): no log-modal exists today. Either reuse `#preview-modal` (used by template-preview), or add a minimal new modal in `index.html` outside the `#dashboard-view` region.
5. **`requireSession` middleware**: every new route in Phase 1 must use the same middleware as other authed routes. Verify the helper name by reading existing routes.

## Self-review checklist (run before execution)

- [ ] Every task has exact file paths
- [ ] Every code step shows actual code (no "implement appropriate logic")
- [ ] Every test has the actual test code
- [ ] Every verification step has an expected outcome
- [ ] Every commit has a real commit message
- [ ] Phase 1 + Phase 2 can dispatch in parallel
- [ ] Phase 3 + 4 serialize after; Phase 4 sub-tasks serialize within
- [ ] Phase 5 is the manual gate; no automated pass condition
- [ ] Off-limits files (outreach.js, actions.js) never touched
- [ ] Auto-relaunch dev:app after every commit touching runtime code (per CLAUDE.md rule 2)
