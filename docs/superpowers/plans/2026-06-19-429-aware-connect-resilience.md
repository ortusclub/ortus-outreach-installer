# 429-Aware Connect Resilience — Implementation Plan (Fix B)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Spec: `docs/superpowers/specs/2026-06-19-429-aware-connect-resilience-design.md`.
> Research: `docs/superpowers/research/2026-06-19-429-rate-limiting.md`. UI: sketch B1/B2.

**Goal:** classify connect failures, reset the page properly on transient glitches,
back off (with operator-chosen pause) on real throttling, and warn off rate-limit-inducing
intervals — entirely in `campaign.js` + server + frontend.

**Hard constraints (every task):** do NOT modify `src/linkedin/outreach.js` or
`src/linkedin/actions.js`. Never `git add -A`/`.`; stage only named files; never stage
`data/`. Pure helpers get `node --test`; campaign/UI manual-verify. Commits `feat:`-prefixed,
ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Pure helpers — classifier + jittered backoff

**Files:** Modify `src/campaign.js`; Test `tests/connect-failure-classify.test.js` (create).

- [ ] **Step 1 — failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectFailure, degradationBackoffMs } from '../src/campaign.js';

test('classifyConnectFailure routes real log strings', () => {
  assert.equal(classifyConnectFailure('VOYAGER_REJECTED: HTTP 429 — HTTP 429'), 'throttle');
  assert.equal(classifyConnectFailure('Page error: rate_limited'), 'throttle');
  assert.equal(classifyConnectFailure('WEEKLY_LIMIT'), 'invite_cap');
  assert.equal(classifyConnectFailure('You’ve reached the weekly invitation limit'), 'invite_cap');
  assert.equal(classifyConnectFailure('Please verify you are a human / checkpoint'), 'challenge');
  assert.equal(classifyConnectFailure('No modal appeared and connection not sent'), 'transient');
  assert.equal(classifyConnectFailure('Execution context was destroyed, most likely because of a navigation.'), 'transient');
  assert.equal(classifyConnectFailure('Already connected'), 'benign');
  assert.equal(classifyConnectFailure(''), 'benign');
});

test('degradationBackoffMs with jitter stays within [0, capped] and grows with streak', () => {
  const base = 1000, opts = { jitter: true, rng: () => 1 }; // rng=1 → max end of jitter
  assert.equal(degradationBackoffMs(base, 0, opts), base);          // streak 0 unchanged
  const s3 = degradationBackoffMs(base, 3, opts);
  assert.ok(s3 <= 1000 * 32 && s3 > 0);
  // rng=0 → bottom of the jitter window
  assert.equal(degradationBackoffMs(base, 3, { jitter: true, rng: () => 0 }), 0);
});
```

- [ ] **Step 2 — run, expect FAIL.** `node --test tests/connect-failure-classify.test.js`
- [ ] **Step 3 — implement** in `src/campaign.js`:
  - `export function classifyConnectFailure(msg)` — lowercase the string; test in PRIORITY
    order: invite_cap → challenge → throttle → transient → benign, using the regexes from the
    spec §B0. (invite_cap before throttle: "weekly invitation limit" must not be caught by a
    generic limit/429 rule.)
  - Extend `degradationBackoffMs(baseMs, streak, opts)` to accept `{ jitter=false, rng=Math.random, retryAfterMs=0, maxMult=32, maxMs=20*60*1000 }`. Compute `capped = min(maxMs, baseMs * min(maxMult, 2**streak))` (streak 0 → baseMs). If `jitter`, `val = Math.floor(rng() * capped)` (full jitter); else `val = capped`. Return `Math.max(val, retryAfterMs)`. Preserve the existing 2-arg call sites (defaults keep them unchanged).
- [ ] **Step 4 — run, expect PASS.** Confirm the wider suite still green.
- [ ] **Step 5 — commit** (`git add src/campaign.js tests/connect-failure-classify.test.js`).

---

### Task 2: Campaign — page-reset retry + failure routing + pauseOnThrottle (HIGH RISK)

**Files:** Modify `src/campaign.js`. Manual-verify. Use the most capable model. Preserve ALL
existing behavior except the additions below.

READ first: the gate loop (`gateConnectIdentity`, ~546–595), the per-lead block + the
3-retry `performOutreach` loop (~3219–3340), the existing `WEEKLY_LIMIT` / `degradationStreak`
/ `consecutiveSkips` / `weeklyLimited` / parking handling, and `isDegradationSignal`.

- [ ] **Step 1 — `pauseOnThrottle`** in `startCampaign({…})` signature (default `true`); store
  `campaign.pauseOnThrottle = pauseOnThrottle !== false`.
- [ ] **Step 2 — gate-retry reset:** in `gateConnectIdentity`'s loop, for `attempt > 1`, before
  the existing `page.goto(navUrl,…)` do `await page.goto('about:blank',{timeout:5000}).catch(()=>{})`.
  (Single-line reset; rest unchanged.)
- [ ] **Step 3 — connect-retry rework:** in the `for (attempt…MAX_RETRIES)` loop, when a retry is
  about to happen (attempt > 1), branch on `classifyConnectFailure(<previous result.error/err.message>)`:
  - `transient` → `await page.goto('about:blank',{timeout:5000}).catch(()=>{})`, then re-run
    `gateConnectIdentity(page,{url,row,sourceName,log})`; if `ok` set `_identityVerified=true` and
    call `performOutreach(..., skipNavigation:true)`; if not ok, break to the existing
    identity-unverified skip path. (Keeps the wrong-person safeguard on every fresh load.)
  - `throttle` → stop retrying this lead; apply throttle handling (Step 4).
  - `invite_cap` / `challenge` → stop retrying; apply Step 4 routing.
  Do not change the success path or the watchdog/preempt races.
- [ ] **Step 4 — failure routing** at the per-lead failure handler (where results/errors are
  finalized), using `classifyConnectFailure`:
  - `invite_cap` → mark the account done-sending for this cycle (reuse the existing WEEKLY_LIMIT /
    `weeklyLimited.add(profileId)` + `recordProfileEnd` path); do NOT keep retrying its leads.
  - `challenge` → halt the account, `recordProfileEnd(profileId, pName, 'LinkedIn checkpoint — needs a human')`,
    surface via `_ops('ERROR','challenge',…)`; never auto-retry.
  - `throttle` → increment `degradationStreak`; compute wait via `degradationBackoffMs(base, streak,
    { jitter:true })`; if `campaign.pauseOnThrottle` → park/pause the account (reuse the existing
    park/backoff path) so others continue; else → keep the account going after the backoff sleep.
  - `transient`/`benign` → existing behavior unchanged.
  Reuse existing helpers; don't duplicate parking logic.
- [ ] **Step 5 — verify** `node --check src/campaign.js`; full suite `node --test tests/*.test.js`
  green. Commit (`git add src/campaign.js`).

---

### Task 3: Server — thread pauseOnThrottle

**Files:** Modify `server.js`.

- [ ] **Step 1** — accept `pauseOnThrottle` in the start/rerun/queue bodies (`buildCampaignConfig`
  and the rerun/queue-only paths); coerce to boolean (default `true` when absent); pass to
  `startCampaign`. Mirror how `delayMin`/`delayMax` are threaded (`server.js:~908`).
- [ ] **Step 2** — `node --check server.js`; commit (`git add server.js`).

---

### Task 4: Frontend — delay disclaimer + pause toggle (match sketch B1/B2)

**Files:** `public/index.html`, `public/js/app.js`, `public/css/style.css`. Manual-verify.

READ: the Throughput "Advanced · pause between leads" block (`index.html:~763–775`, inputs
`#within-batch-min`/`#within-batch-max`); the concurrency toggle pattern (`.alpha-toggle` /
`.alpha-toggle-track`, `index.html:~754`); the start-payload builder + rerun/restore form fill in
`app.js`. Port the sketch's `.delay-danger` CSS into `style.css`.

- [ ] **Step 1 — disclaimer:** add a `.delay-danger` block after the pause-between-leads inputs
  (sketch B1). On `#within-batch-min` input, toggle `.show` when value < 30 (matches the sketch JS).
  Also evaluate on rerun/restore form-fill so an old <30 config surfaces the warning.
- [ ] **Step 2 — toggle:** add a `pause-on-throttle` row using `.alpha-toggle`/`.alpha-toggle-track`
  (or the sketch `.sw`), label + help per sketch B2, **checked by default**. Help text updates with
  state (sketch JS).
- [ ] **Step 3 — payload:** include `pauseOnThrottle: <toggle.checked>` in the start/launch POST body.
  On rerun/restore, set the toggle from saved settings (default ON when absent).
- [ ] **Step 4 — verify** `node --check public/js/app.js`; commit (`git add public/index.html public/js/app.js public/css/style.css`).

---

### Task 5: Version bump, suite, relaunch

- [ ] Bump `package.json` patch (→ 2.112.7). `node --test tests/*.test.js` green. Relaunch dev:app;
  confirm version badge. Commit (`git add package.json`). Note: ships only via manual reinstall (#15).

---

## Self-review (coverage vs spec)

- B0 classify → Task 1,2,4-routing. B1 reset → Task 2 (gate + connect). B2 pacing → Task 4 (+3,2).
- B3 jitter → Task 1. pauseOnThrottle end-to-end → Tasks 1/2(field)→3(server)→4(UI).
- Off-limits `outreach.js`/`actions.js` untouched — only their results/errors are read.
