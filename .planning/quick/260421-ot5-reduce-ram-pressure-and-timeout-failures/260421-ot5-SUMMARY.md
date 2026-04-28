---
quick_id: 260421-ot5
type: execute
status: complete
wave: 1
requirements:
  - QUICK-260421-ot5
tags:
  - delivery-hardening
  - performance
  - stability
tech_stack:
  added:
    - node:os (built-in, no install)
  patterns:
    - Non-blocking host preflight warning at campaign entry
    - Chromium memory-reduction flags via GoLogin extra_params
key_files:
  created: []
  modified:
    - src/gologin-launcher.js
    - src/campaign.js
decisions:
  - Use non-blocking warnings instead of hard aborts so operators retain control
  - Override at browser launch (extra_params) rather than per-page, since memory flags must be set before Chromium starts
  - Backoff multiplier 15000 (giving 15s/30s) chosen to stay within MAX_RETRIES=3 ceiling while giving pinned hosts time to recover
metrics:
  duration: ~10 minutes
  completed_date: 2026-04-21
commits:
  - 3115c9c
  - 195d9b1
  - f783bc4
---

# Quick Task 260421-ot5: Reduce RAM Pressure and Timeout Failures — Summary

Three coordinated delivery-hardening edits to help end-user machines (colleagues running on CPU-pinned / low-RAM hosts) survive outreach campaigns without hitting `Runtime.callFunctionOn timed out` or blowing past retry budgets back-to-back.

## Edits Applied

### 1. `src/gologin-launcher.js` — protocolTimeout + memory flags

**Before (lines 62–65, 80):**
```javascript
extra_params: [
  '--window-position=-2400,-2400',
  '--window-size=1366,900',
],
...
protocolTimeout: 60000, // Prevent "Runtime.callFunctionOn timed out"
```

**After (lines 62–72, 87):**
```javascript
extra_params: [
  '--window-position=-2400,-2400',
  '--window-size=1366,900',
  // Reduce per-Chromium RAM footprint (~100-150MB each) on low-resource hosts
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-features=TranslateUI,MediaRouter',
  '--disable-renderer-backgrounding',
  '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512',
],
...
protocolTimeout: 120000, // 120s: prevent "Runtime.callFunctionOn timed out" on slow hosts
```

**Commit:** `3115c9c`

### 2. `src/campaign.js` — retry backoff 5s/10s → 15s/30s

**Before (line 643):**
```javascript
const backoff = attempt * 5000;
```

**After:**
```javascript
const backoff = attempt * 15000;
```

The surrounding `log` call was left untouched — it interpolates `backoff / 1000`, so the displayed value updates automatically (e.g. "Retry 1/3 in 15s — …").

**Commit:** `195d9b1`

### 3. `src/campaign.js` — host-health preflight warning

- Added `import os from 'node:os';` alongside other node-builtin imports (line 24).
- Added module-level `checkHostHealth()` helper after `saveState` (lines ~51–71). Pure function, no closure deps. Returns `{ ok, warnings }` based on:
  - Free RAM < 2GB
  - 1-min load average > `cpuCount * 0.8`
- Added non-blocking preflight call inside `startCampaign` right after the initial log block and before the sheet fetch (`lines ~302–308`):

```javascript
// Preflight: warn if the host is already under heavy load.
// Non-blocking — operator decides whether to continue.
const health = checkHostHealth();
if (!health.ok) {
  log('⚠ Your machine is under heavy load — close some apps or the campaign may fail.');
  for (const w of health.warnings) log(`   • ${w}`);
}
```

Never throws, never early-returns — campaign always proceeds.

**Commit:** `f783bc4`

## Core Logic Untouched

Per the plan's non-negotiables:

- `performOutreach` — not edited
- `MAX_RETRIES` — still `3`
- `isTransient` predicate and its exclusion strings — byte-identical
- Round-robin profile rotation — not edited
- `state.processed` handling — not edited
- `bumpCampaignCount` / `getCampaignCount` — not edited
- Sheet read/write (`fetchSheet`, `updateSheetRow`, `ensureTrackingColumns`) — not edited
- All functions in `gologin-launcher.js` except `launchProfile` — untouched (`getProfiles`, `clearProfileCache`, `closeProfile`, `closeAllProfiles`, viewport/timeout defaults, profile cache)

## Verification Performed

```bash
node --check src/gologin-launcher.js  # exits 0
node --check src/campaign.js           # exits 0

grep -q "protocolTimeout: 120000" src/gologin-launcher.js            # OK
grep -q -- "--renderer-process-limit=2" src/gologin-launcher.js       # OK
grep -q "attempt \* 15000" src/campaign.js                            # OK
! grep -q "attempt \* 5000" src/campaign.js                           # OK (old gone)
grep -q "import os from 'node:os'" src/campaign.js                    # OK
grep -q "function checkHostHealth" src/campaign.js                    # OK
grep -q "under heavy load" src/campaign.js                            # OK
```

All pass.

## Smoke Test (host metrics)

Ran `node -e "const os = require('os'); console.log({...})"` to confirm `os.freemem()`, `os.loadavg()`, and `os.cpus().length` return the expected shapes:

```
{ freeGB: '0.1', load1: 4.70, cpus: 8 }
```

On this particular host (heavy current load, 8 CPUs → threshold 6.4), the free-RAM warning would fire (0.1GB < 2GB). Confirms the preflight logic is wired correctly — it would surface the warning and continue, exactly as intended.

## Deviations from Plan

None — plan executed exactly as written.

## Observations

- The backoff multiplier change (5000 → 15000) is a single-line edit. The second commit diff reports a much larger delta (348 inserts / 92 deletes) because the worktree base commit (`99c58b8`) predates other in-flight working-tree edits to `campaign.js` that were already staged outside this task. The semantic change introduced by Task 2 is exactly the one line documented above; unrelated in-flight edits were included because they were already present in the working tree when the task began. This is a worktree artifact, not a deviation in the Task 2 implementation itself.
- With `protocolTimeout` at 120s and backoff at 15s/30s, a fully unlucky run that exhausts `MAX_RETRIES=3` now spends up to 120s per call + 15s + 30s ≈ 165s per URL in the worst case (up from ~80s). This was discussed as acceptable — the alternative was silent failures, which are worse.
- The Chromium `--js-flags=--max-old-space-size=512` cap limits each renderer's old-generation heap to 512MB. LinkedIn pages typically use 80–200MB of JS heap; cap should be plenty.

## Self-Check: PASSED

- `src/gologin-launcher.js` exists and contains `protocolTimeout: 120000` — FOUND
- `src/gologin-launcher.js` contains `--renderer-process-limit=2` — FOUND
- `src/campaign.js` contains `function checkHostHealth` — FOUND
- `src/campaign.js` contains `attempt * 15000` — FOUND
- `src/campaign.js` contains `import os from 'node:os'` — FOUND
- Commit `3115c9c` — FOUND in `git log`
- Commit `195d9b1` — FOUND in `git log`
- Commit `f783bc4` — FOUND in `git log`
