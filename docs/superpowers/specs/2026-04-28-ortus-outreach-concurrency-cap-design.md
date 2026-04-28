# Ortus Outreach — Concurrency Cap (RAM Reduction)

**Date:** 2026-04-28
**Lens:** G (RAM/CPU reduction) — first of potentially several optimization patches; this one ships only the hard concurrency cap
**Approach:** Single-sweep, two patches in one branch
**Target version:** 2.8.25
**Memory anchors:** never modify `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits — user has been burned); be careful with working code (additive only, no behavior changes to per-lead processing); verify-before-asserting (no guessing); colleagues run on slow/overloaded machines.

## Background

A campaign with N selected accounts opens N Chromium browsers simultaneously today (each ~250-500 MB). On the 8 GB MacBooks colleagues use, this drives the system to RAM starvation — verified live this session: a 3-account campaign produced 0.1 GB free of 8 GB and load average 7.0 on an 8-core machine, causing Connect-button-detection timeouts.

Existing resource infrastructure (already shipped, not changing):
- 11.1: pidusage sampling, hysteresis throttle (RAM 90%/80%, CPU 0.9×/0.7× cores), parkProfile between leads, THROTTLE_MULTIPLIER for delay scaling
- 11.2: lazy profile launch, batches-per-hour rate limits, close-between-batches when gap > CLOSE_GAP_MIN, hidden Chromium windows on macOS
- 260421-ot5: Chromium memory flags `--disable-extensions`, `--disable-background-networking`, `--disable-features=TranslateUI,MediaRouter`, `--disable-renderer-backgrounding`

The remaining lever is **the absolute number of concurrent open browsers**. Today there's no hard cap — the only signal is a soft warning printed to the campaign log when `profileIds.length > 3`. This lens introduces the cap.

## Scope

Two patches in one branch (`concurrency-cap-2.8.25`), shipped as a single version bump.

| Patch | Theme | Risk |
|---|---|---|
| **P1** | Launch gate — read env var, gate browser launch on `sessions.size < cap` | Low (additive — single check before launch) |
| **P2** | Forced close at batch boundary when others are waiting | Low (extends existing `shouldCloseBetweenBatches` decision; one new condition) |

Plus FINAL: env-var documentation in `.env.example` + version bump.

**Verification cadence:** Single end-of-branch verification — `npm test` + manual smoke (set `MAX_CONCURRENT_PROFILES=2`, start a campaign with 4 accounts, confirm only 2 browsers open at any moment and they rotate through).

**Out of scope (explicit):**
- Any UI knob for runtime adjustment of the cap (env-only per user choice)
- Auto-derivation of the cap from system RAM (env-only per user choice)
- Display of "Slots: 2/3" in the dashboard (could add later as a polish patch)
- Display of the wait queue in the dashboard
- New unit tests for the gating logic (additive; the existing 120-test suite is the regression net; manual smoke verifies the new behavior)
- All other RAM/CPU levers discussed in the brainstorm (more aggressive Chromium flags, critical-close, periodic page reload, JS memory purge via CDP, dashboard polling backoff, etc.) — deferred for future lenses
- Any change to `src/linkedin/*` (off-limits)
- Any change to per-lead processing, retry logic, watchdog, parking, throttle, or weeklyLimited transitions
- Any change to the existing `shouldCloseBetweenBatches` time-based heuristic itself — the new condition is additive (close if EITHER existing heuristic says yes OR a profile is waiting for a slot)

## P1 — Launch gate

**Problem:** When the user picks N accounts, all N browsers launch on first batch (lazy launch from 11.2 only delays first-batch launch, not subsequent batches). With N > MAX_CONCURRENT_PROFILES, the system is overloaded. There is no mechanism to limit simultaneous browsers.

**Change:**

In `src/campaign.js`, near the existing top-of-file constants (line ~57 area where `LEAD_TIMEOUT_MS` lives after the 2.8.24 hotfix), add:

```javascript
const MAX_CONCURRENT_PROFILES = Number(process.env.MAX_CONCURRENT_PROFILES) || 3;
```

In the round-robin loop (verify exact location during implementation — the launch site is where `launchProfile` is called inside the per-profile iteration), wrap the launch with a slot check:

```javascript
// Concurrency cap (2.8.25): if we're already at MAX_CONCURRENT_PROFILES open
// browsers, this profile waits. The round-robin moves to the next eligible
// profile; this one gets its turn when a slot opens (via P2 forced close).
if (!sessions.has(profileId) && sessions.size >= MAX_CONCURRENT_PROFILES) {
  log(`  ⏸ ${pName}: waiting for a slot (${sessions.size}/${MAX_CONCURRENT_PROFILES} open)`);
  continue; // skip this profile this iteration; round-robin will retry next loop
}
```

The exact insertion point depends on the loop's structure. The principle: place the check immediately before the call that would open a new browser (when `sessions.has(profileId)` is false), and skip the iteration if the cap is hit.

**Acceptance:**
- New env var `MAX_CONCURRENT_PROFILES` recognized; defaults to 3
- When N profiles selected and N > cap, only `cap` browsers open simultaneously
- Profiles waiting for a slot log `"⏸ <name>: waiting for a slot"` once per round
- Existing 120 tests still pass (no behavior change for cap >= profileIds.length)
- No change to per-profile lead processing, retry logic, or any off-limits paths

**Risk:** Low. Pure additive `if/continue` check. If `MAX_CONCURRENT_PROFILES >= profileIds.length` (the common case for small campaigns), the check is never tripped and behavior is identical to today.

## P2 — Forced close at batch boundary when others are waiting

**Problem:** Without P2, the gate from P1 starves waiting profiles. The first 3 profiles to launch keep their browsers open through every batch (the existing `shouldCloseBetweenBatches` returns false when batch gap is short), and profiles 4 and 5 wait forever.

**Change:**

The existing close-vs-park decision lives at `src/campaign.js:1411` (`shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })`). Currently:

```javascript
if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })) {
  log(`  ⊗ ${pName}: gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min — closing browser.`);
  await closeSession(profileId);
} else {
  // ...park on about:blank
}
```

Extend the condition to ALSO close if any profile in the rotation is waiting for a slot:

```javascript
const othersWaiting = profileIds.some(id =>
  id !== profileId && !sessions.has(id) && !weeklyLimited.has(id)
);
const closeForRotation = sessions.size >= MAX_CONCURRENT_PROFILES && othersWaiting;

if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs }) || closeForRotation) {
  const reason = closeForRotation
    ? `slot rotation (${sessions.size - 1}/${MAX_CONCURRENT_PROFILES} after close)`
    : `gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min`;
  log(`  ⊗ ${pName}: ${reason} — closing browser.`);
  await closeSession(profileId);
} else {
  // ...park on about:blank (unchanged)
}
```

The check `!weeklyLimited.has(id)` excludes profiles that have been parked via the weekly-limit path — they're not actually waiting, they're done.

**Acceptance:**
- When `sessions.size === cap` and another non-weekly-limited profile in `profileIds` doesn't have a session, the current profile closes at batch end regardless of the time-based heuristic
- When no other profile is waiting (e.g. cap=5 and only 3 profiles selected), the existing time-based heuristic is unchanged
- Log line clearly indicates which condition triggered the close (rotation vs. gap)

**Risk:** Low-to-medium. The forced close changes timing — profiles will reopen faster than they would today (re-launch on next round instead of staying parked). This adds re-launch overhead per batch (each profile launch is ~10-30s). Trade-off: more launch overhead in exchange for fitting within RAM budget. Acceptable because without the cap, the campaign would have failed anyway on weak hosts.

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| P1 | Low | Cap defaults too low and a 16 GB machine runs at 3 instead of 5 — leaves capacity unused | Operator can override via env var; default of 3 fits the most common (8 GB) machine |
| P2 | Low-to-medium | Re-launch overhead adds 10-30s per profile per batch when rotation is active | Only fires when N > cap; campaigns with N <= cap are identical to today |

## Branch & version shape

- Branch: `concurrency-cap-2.8.25` cut from `main` (currently at `478951d` after the 2.8.24 merge)
- Patches commit in order P1 → P2 → FINAL
- FINAL bumps `package.json` 2.8.24 → 2.8.25 AND updates `.env.example` to document `MAX_CONCURRENT_PROFILES`
- Verification: `npm test` (existing 120 tests must still pass) + manual smoke with `MAX_CONCURRENT_PROFILES=2` and 4-account campaign
- Merge to main as fast-forward

## Files touched (summary)

| File | P1 | P2 | FINAL |
|---|---|---|---|
| `src/campaign.js` | new constant + launch gate | extend close-at-batch-boundary | |
| `.env.example` | | | document MAX_CONCURRENT_PROFILES |
| `package.json` | | | bump version to 2.8.25 |

## Notes for the implementer

- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`, ALL of `public/`, `tests/`, `server.js`, `electron/`. This lens touches ONLY `src/campaign.js`, `.env.example`, and `package.json`.
- **No new tests** in this lens. Manual smoke is the verification (deferred for a future polish patch if desired).
- **The launch gate's `continue` MUST go to the round-robin's next iteration**, not the per-batch loop's. Verify the loop structure before placing the check.
- **`sessions` is the existing Map** (verify name during implementation; could be `activeProfiles` or similar — match whatever the current launch/close logic uses).
- **The forced-close log line** must distinguish rotation vs. time-based reason so operators can see which mechanism fired.
