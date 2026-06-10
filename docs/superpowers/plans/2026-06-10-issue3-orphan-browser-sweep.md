# Issue #3 — No orphaned Orbita browsers after a campaign ends

> Execute via subagent-driven-development, TDD.

**Goal:** After a campaign ends / Stop, no GoLogin/Orbita browser we launched is left open. When a close fails, we log *why*.

**Honest status:** Root cause of the original 2-orphan overnight case is NOT proven (the code already SIGKILLs on close). So this is: (1) a real root-cause fix for ONE documented leak, (2) a precise safety-net sweep over PIDs **we** spawned, (3) instrumentation to capture any remaining failure mode. No kill-by-name (too risky).

**Findings (src/gologin-launcher.js):**
- `closeProfile` kills via `GL.killBrowser()` (SIGTERM) + a 2s SIGKILL fallback, then drops the profile from `activeProfiles`.
- **Leak vector (documented by the file itself):** in `launchProfile`, when `GL.start()` returns a non-success status (lines 147-150) the code calls `GL.stop()` — which the file's own comment (217-219) says does NOT kill the Orbita process — then throws. The profile is never in `activeProfiles`, so nothing ever kills it → orphan.
- `closeAllProfiles()` (the central teardown, called from campaign-end `campaign.js:3360`, stop `server.js:1335`, restore, shutdown) only closes `activeProfiles` — it can't see escaped PIDs.

**Architecture:** Add a module-level `spawnedPids` Map (profileId→pid) recording every Orbita PID we spawn. A pure exported helper `selectOrphanPids(...)` decides which tracked PIDs are orphans. `closeAllProfiles` SIGKILLs them after the normal close.

---

### Task 1: Pure orphan-selection helper (TDD)

**Files:** Modify `src/gologin-launcher.js`; Create `tests/orphan-pids.test.js`

- [ ] **Step 1: Write failing test** `tests/orphan-pids.test.js`:
  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { selectOrphanPids } from '../src/gologin-launcher.js';

  test('orphan = spawned + alive + NOT active', () => {
    const spawned = new Map([['p1', 101], ['p2', 102], ['p3', 103]]);
    const activePids = new Set([101]);            // p1 still tracked-active
    const isAlive = (pid) => pid !== 102;          // p2 already dead
    // p1 active → skip; p2 dead → skip; p3 alive + not active → orphan
    assert.deepEqual(selectOrphanPids({ spawned, activePids, isAlive }), [103]);
  });

  test('no orphans when all spawned are active or dead', () => {
    const spawned = new Map([['p1', 101], ['p2', 102]]);
    assert.deepEqual(selectOrphanPids({ spawned, activePids: new Set([101]), isAlive: (p) => p === 101 }), []);
  });

  test('ignores null/undefined pids', () => {
    const spawned = new Map([['p1', null], ['p2', undefined]]);
    assert.deepEqual(selectOrphanPids({ spawned, activePids: new Set(), isAlive: () => true }), []);
  });
  ```
- [ ] **Step 2: Run → FAIL** (`selectOrphanPids` undefined). `node --test tests/orphan-pids.test.js`

- [ ] **Step 3: Implement** the pure helper in `src/gologin-launcher.js`:
  ```js
  /**
   * Pick PIDs we spawned that are still alive but no longer tracked as active
   * (escaped activeProfiles — e.g. a failed launch, or a close that didn't take).
   * Pure + exported for unit testing; closeAllProfiles wires it to real signals.
   */
  export function selectOrphanPids({ spawned, activePids, isAlive }) {
    const out = [];
    for (const pid of spawned.values()) {
      if (typeof pid !== 'number') continue;
      if (activePids.has(pid)) continue;
      if (!isAlive(pid)) continue;
      out.push(pid);
    }
    return out;
  }
  ```
- [ ] **Step 4: Run → PASS.**

---

### Task 2: Track spawned PIDs, fix the non-success leak, wire the sweep + instrumentation

**Files:** Modify `src/gologin-launcher.js`

- [ ] **Step 1:** Add module state near `activeProfiles` (line 6): `const spawnedPids = new Map(); // profileId → Orbita pid (every spawn, even failed launches)`.
- [ ] **Step 2:** In `launchProfile`, immediately AFTER `const { status, wsUrl } = await GL.start();` (line 145), record the pid unconditionally:
  ```js
  const _spawnedPid = GL?.processSpawned?.pid;
  if (_spawnedPid) spawnedPids.set(profileId, _spawnedPid);
  ```
- [ ] **Step 3: Fix the non-success leak.** Replace the `if (status !== 'success')` block (lines 147-150) so it force-kills before throwing:
  ```js
  if (status !== 'success') {
    console.warn(`[gologin] start failed for ${profileId} (status="${status}") — force-killing any spawned process`);
    try { GL.killBrowser(); } catch { /* */ }
    if (_spawnedPid) { try { process.kill(_spawnedPid, 'SIGKILL'); } catch { /* already dead */ } }
    spawnedPids.delete(profileId);
    await GL.stop().catch(() => {});   // cloud-commit only; kill already done
    throw new Error(`GoLogin start failed: status="${status}"`);
  }
  ```
- [ ] **Step 4:** In `closeProfile`, after `activeProfiles.delete(profileId);` (line 250) add `spawnedPids.delete(profileId);`. Add instrumentation at the top of the kill block:
  ```js
  const _proc = GL?.processSpawned;
  console.log(`[gologin] closeProfile ${profileId}: pid=${_proc?.pid ?? 'NONE'} killed=${_proc?.killed ?? '?'}${_proc?.pid ? '' : ' (no process handle — orphan risk)'}`);
  ```
  (Keep existing killBrowser + SIGKILL-fallback logic intact.)
- [ ] **Step 5: Wire the sweep into `closeAllProfiles`.** After the `await Promise.all(...)` line, before `return`:
  ```js
  // v2.86.14: safety net — SIGKILL any browser WE spawned that escaped
  // activeProfiles (failed launch / close that didn't take). Only PIDs we
  // recorded in spawnedPids — never a name-matched or operator-opened browser.
  const activePids = new Set(getActiveBrowserPids());
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const orphans = selectOrphanPids({ spawned: spawnedPids, activePids, isAlive });
  for (const pid of orphans) {
    console.warn(`[gologin] orphan Orbita pid ${pid} survived close — SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  }
  for (const [pidProfile, pid] of [...spawnedPids.entries()]) {
    if (orphans.includes(pid) || !isAlive(pid)) spawnedPids.delete(pidProfile);
  }
  ```
- [ ] **Step 6: Run full suite** `node --test tests/*.test.js` → ALL pass (no regression to #2/#4/identity).

---

### Task 3: Bump + commit + relaunch (orchestrator)
2.86.13 → 2.86.14.

## Constraints
- Off-limits: `src/linkedin/outreach.js`, `actions.js`, `src/profile-identity.js`. No status-string changes.
- The sweep must NEVER kill a PID not in `spawnedPids` (no operator-opened browsers, no name-matching).
- Don't change `closeProfile`'s existing killBrowser/SIGKILL behaviour — only ADD pid-tracking + instrumentation.
