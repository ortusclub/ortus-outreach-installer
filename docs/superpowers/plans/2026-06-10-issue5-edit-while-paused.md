# Issue #5 — Edit templates / daily limit / cadence while paused

> Execute via subagent-driven-development, TDD. Two commits: **Part A backend** (this plan, fully tested) then **Part B UI** (separate).

**Goal:** While a campaign is paused, the operator can change message templates, daily limit per account, and check cadence; on Resume the running campaign uses the new values. Adding accounts / new leads stays restart-only (out of scope).

**Why it's currently snapshot:** the send loop reads `dailyLimit` / `checkIntervalMinutes` / `tpl` from closure locals built once at `startCampaign`. Pause only flips flags. So edits don't reach the loop.

**Approach:** point the loop's reads at the live `campaign.*` object, and for templates mutate the existing `tpl` object **in place** (`Object.assign`) so the dozens of `tpl.*` read sites need no change. Three setters, gated on `campaign.running && campaign._paused`.

---

### Task A1: `normalizeTemplates` extraction + template setter (TDD)

**Files:** Modify `src/campaign.js`; Test `tests/edit-while-paused.test.js` (new)

- [ ] **Step 1: Write failing test** (new file). Import `{ campaign, normalizeTemplates, setLiveTemplates }` from `../src/campaign.js`.
  ```js
  test('normalizeTemplates maps note/ccDmBody/intro fields', () => {
    const t = normalizeTemplates({ note: 'hi {first name}', ccDmBody: 'dm', primaryIntroBody: 'intro' }, 'connect_and_introduce');
    assert.equal(t.connectionNote, 'hi {first name}');
    assert.equal(t.ccDmBody, 'dm');
    assert.equal(t.primaryIntroBody, 'intro');
  });
  test('setLiveTemplates mutates the SAME tpl object in place (live for the loop)', () => {
    const tplRef = normalizeTemplates({ note: 'old' }, 'connect_only');
    campaign.running = true; campaign._paused = true;
    campaign._liveTpl = tplRef; campaign._liveMode = 'connect_only';
    const r = setLiveTemplates({ note: 'new', ccDmBody: 'x' });
    assert.equal(r.ok, true);
    assert.equal(tplRef.connectionNote, 'new', 'same object reference now has new value');
    assert.equal(campaign.templates.ccDmBody, 'x');
  });
  test('setLiveTemplates rejects when not paused', () => {
    campaign.running = true; campaign._paused = false; campaign._pauseRequested = false;
    assert.equal(setLiveTemplates({ note: 'x' }).ok, false);
  });
  ```
- [ ] **Step 2: Run → FAIL** (`normalizeTemplates`/`setLiveTemplates` undefined). `node --test tests/edit-while-paused.test.js`
- [ ] **Step 3: Implement.**
  - Extract a module-level `export function normalizeTemplates(templates = {}, mode = '')` containing the exact object body currently at lines 1419-1453 (the `tpl = {...}` literal), returning it.
  - At line 1419 replace the literal with: `const tpl = normalizeTemplates(templates, mode);` then immediately `campaign._liveTpl = tpl; campaign._liveMode = mode;`
  - Add the setter:
    ```js
    // v2.86.15: live template edit while paused. Mutates the SAME tpl object the
    // send loop already holds by reference, so no read-site changes are needed.
    export function setLiveTemplates(newTemplates = {}) {
      if (!campaign.running) return { ok: false, reason: 'not-running' };
      if (!campaign._paused) return { ok: false, reason: 'not-paused' };
      if (!campaign._liveTpl) return { ok: false, reason: 'no-templates' };
      Object.assign(campaign._liveTpl, normalizeTemplates(newTemplates, campaign._liveMode));
      campaign.templates = { ...newTemplates };
      log('✎ Templates updated (live) while paused.');
      return { ok: true };
    }
    ```
  - Redirect the in-LOOP raw `templates.*` reads to the live `tpl` (mutated): line 2133 `templates && templates.primaryName && templates.primaryName.trim()` → use `tpl.primaryName` (and any other `templates.X` read INSIDE the worker loop — NOT the setup reads at 1401/1402/1412 which run once before the loop and can stay).
- [ ] **Step 4: Run → PASS.**

---

### Task A2: daily-limit + cadence live reads + setters (TDD)

**Files:** Modify `src/campaign.js`; same test file

- [ ] **Step 1: Write failing tests.**
  ```js
  test('setLiveDailyLimit clamps and sets campaign.dailyLimit (paused only)', () => {
    campaign.running = true; campaign._paused = true; campaign.dailyLimit = 50;
    assert.equal(setLiveDailyLimit(80).ok, true);
    assert.equal(campaign.dailyLimit, 80);
    campaign._paused = false;
    assert.equal(setLiveDailyLimit(10).ok, false);   // not paused
    assert.equal(campaign.dailyLimit, 80);            // unchanged
  });
  test('setLiveCadence clamps via clampCadenceMinutes and sets campaign.checkIntervalMinutes', () => {
    campaign.running = true; campaign._paused = true;
    assert.equal(setLiveCadence(240).ok, true);
    assert.equal(campaign.checkIntervalMinutes, 240);
    assert.equal(setLiveCadence(5).ok, true);         // 5 -> clamped to MIN (60)
    assert.equal(campaign.checkIntervalMinutes, 60);
  });
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - Setters:
    ```js
    export function setLiveDailyLimit(n) {
      if (!campaign.running) return { ok: false, reason: 'not-running' };
      if (!campaign._paused) return { ok: false, reason: 'not-paused' };
      const v = Math.max(1, Math.min(1000, Math.floor(Number(n) || 0)));
      if (!v) return { ok: false, reason: 'invalid' };
      campaign.dailyLimit = v;
      log(`✎ Daily limit updated (live) → ${v}.`);
      return { ok: true, dailyLimit: v };
    }
    export function setLiveCadence(min) {
      if (!campaign.running) return { ok: false, reason: 'not-running' };
      if (!campaign._paused) return { ok: false, reason: 'not-paused' };
      const v = clampCadenceMinutes(min);
      campaign.checkIntervalMinutes = v;
      log(`✎ Check cadence updated (live) → ${v} min.`);
      return { ok: true, checkIntervalMinutes: v };
    }
    ```
    (`clampCadenceMinutes` is already imported in campaign.js.)
  - Switch the LOOP reads from the closure locals to the live object:
    - daily-limit gates: line 2293, 2310, 2988 (and the display logs 2876, 2989) `dailyLimit` → `campaign.dailyLimit`.
    - cadence: line 2902 (and its log 2903) and 3307 `checkIntervalMinutes` → `campaign.checkIntervalMinutes`.
    - Leave setup/one-time/snapshot uses of the locals (1459, 1478, 1587, 3462, 3499, resume) alone — only the per-lead/per-turn reads must be live.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Full suite** `node --test tests/*.test.js` → ALL pass (no regression to #2/#3/#4/identity/monitoring cadence tests).

---

### Task A3: server routes

**Files:** Modify `server.js` (mirror `/api/campaign/profile-skip`, ~line 1278)

- [ ] Add three POST routes that import + call the setters and return their result:
  - `POST /api/campaign/live/templates` → `setLiveTemplates(req.body?.templates || req.body || {})`
  - `POST /api/campaign/live/daily-limit` → `setLiveDailyLimit(req.body?.dailyLimit)`
  - `POST /api/campaign/live/cadence` → `setLiveCadence(req.body?.checkIntervalMinutes)`
  Each: 400 if missing required value; else `res.json(result)`.
- [ ] Add the three setters to the existing `import { ... } from './src/campaign.js'` in server.js.

---

### Task A4: bump + commit + relaunch (orchestrator) — 2.86.14 → 2.86.15

## Constraints
- Off-limits: `src/linkedin/outreach.js`, `actions.js`, `src/profile-identity.js`. No status-string changes.
- Do NOT change `startCampaign`'s snapshot of settings for the INITIAL run — only add live-edit on top.
- Gate every setter on `campaign.running && campaign._paused`.
- Out of scope: adding accounts / new leads mid-run (restart-only).
