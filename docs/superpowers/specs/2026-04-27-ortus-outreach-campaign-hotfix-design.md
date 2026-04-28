# Ortus Outreach — Campaign Correctness Hotfix

**Date:** 2026-04-27
**Lens:** F (hotfix from code review) — three surgical bug fixes in `src/campaign.js`
**Approach:** Single-sweep, three patches in one branch, one ship
**Target version:** 2.8.24
**Memory anchors:** never modify `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits — user has been burned); be careful with working code (additive only, no control-flow changes); verify-before-asserting (no guessing).

## Background

Code review on 2026-04-27 (post 2.8.23 ship) surfaced two CRITICAL bugs around silent lead loss and two HIGH bugs around reliability. The user picked the safest possible fix shape: a **boot scrubber** that wipes stale `_in_progress` markers at campaign start covers BOTH critical bugs in one place; a watchdog timeout bump fixes false-positive timeouts on slow hosts; a single abort check makes the local-browser path responsive to Stop.

All other findings from the review (consecutive-skips conflation, `processedToday` tautology, parked-profile RAM at high BPH, etc.) are **explicitly deferred** — they require control-flow changes and need their own brainstorming pass.

## Scope

Three patches in one branch (`hotfix-2.8.24`), shipped as a single version bump.

| Patch | Theme | Risk |
|---|---|---|
| **P1** | Boot scrubber for stale `_in_progress` markers (covers both CRITICAL bugs) | Zero — additive code at startCampaign entry, runs once per campaign start |
| **P2** | Watchdog timeout 90s → 180s (constant change) | Zero — single-line constant edit |
| **P3** | Local-browser login wait honors abort | Zero — additive `if (campaign._abort) break;` inside existing wait loop |

**Verification cadence:** Single end-of-branch verification — `npm test` + manual smoke (start a campaign and confirm log shows the scrubber line if any stale entries existed; OR confirm no log if none).

**Out of scope (explicit):**
- All MEDIUM/LOW findings from the code review (`consecutiveSkips` conflation, `processedToday` tautology, parked-profile RAM at high BPH, login-wait checkpoint URL, GoLogin login wait stop responsiveness, etc.)
- Any change to `src/linkedin/*` (off-limits)
- Any change to control flow in the catch block at `campaign.js:1396` (boot scrubber covers the gap)
- Any change to the WEEKLY_LIMIT / INMAIL_NO_CREDITS branches (boot scrubber covers them)
- Sheet write changes
- New tests (not strictly needed — fixes are additive and easy to verify by inspection; pure-helper extraction would invite scope creep)

## P1 — Boot scrubber for stale `_in_progress` markers

**Problem:** `src/campaign.js:990` writes `state.processed[url] = { ..., action: '_in_progress' }` before each lead is processed. Several code paths leave that marker in place permanently:
1. **Catch block at line 1396** does not clear the marker after exceptions
2. **WEEKLY_LIMIT branch at line 1229** does not clear it
3. **INMAIL_NO_CREDITS branch at line 1244** does not clear it
4. **Hard Node crash mid-lead** leaves the marker on disk (because `saveState` fired at line 991)

The pre-filter at lines 712, 725, 731, 736 treats any truthy `state.processed[url]` as "already processed" → the lead is invisible to all future runs until the 60-day `STATE_RETENTION_DAYS` prune evicts it.

**Verified:** Both CRITICAL findings reproduced via Read of the actual code. Pre-filter behavior verified — sheet `Status=Skipped` does NOT exclude leads (only the per-mode columns CC/MSG/InMail do, and the WEEKLY_LIMIT branch doesn't write those), so a scrubber-cleared lead correctly returns to the rotation on next run.

**Change:**

In `src/campaign.js`, inside `startCampaign`, BEFORE the existing `fetchSheet` call (currently around line 622, but verify location during implementation — the anchor is "right after `state = await loadState()` resolves and before `fetchSheet` runs"). Insert this block:

```javascript
// Hotfix 2.8.24-P1: clear stale _in_progress markers from previous runs.
// These accumulate from (a) exceptions in the per-lead catch at the bottom
// of the inner loop, (b) WEEKLY_LIMIT / INMAIL_NO_CREDITS branches that
// don't clean up, and (c) hard crashes mid-lead. Without this, leads stuck
// _in_progress are invisible to the pre-filter for STATE_RETENTION_DAYS.
const stalePending = Object.entries(state.processed).filter(
  ([, v]) => v?.action === '_in_progress'
);
if (stalePending.length > 0) {
  log(`Clearing ${stalePending.length} stale _in_progress marker(s) from previous run`);
  for (const [url] of stalePending) delete state.processed[url];
  await saveState(state);
}
```

**Why this is safe:**
- Runs ONCE at the top of `startCampaign`, before any rotation logic touches `state.processed`
- `delete` on object keys is pure mutation — cannot throw
- `await saveState(state)` matches the existing pattern at line 991 (already trusted; if it fails the campaign would already crash there)
- The `if (stalePending.length > 0)` guard avoids unnecessary disk writes on the common case (no stale markers)
- The log line provides visibility — operator can see "0 cleared" doesn't appear; non-zero counts surface in the log

**What this does NOT change:**
- The WEEKLY_LIMIT, INMAIL_NO_CREDITS, and catch-block code paths are unchanged. They still leave `_in_progress` markers; the boot scrubber catches them on next start.
- Mid-run cleanup is NOT added. The fix is "next run after a stuck marker, the scrubber clears it." Acceptable because the campaign loop will only see the stuck lead again on the NEXT run anyway.

**Acceptance:**
- After implementation, a fresh `npm test` passes (no test changes; existing tests don't touch this path)
- Manual smoke: start a campaign with no stale markers — log shows no scrubber line. Manually inject a `_in_progress` marker into `data/state.json` and start a campaign — log shows "Clearing 1 stale _in_progress marker(s)…"
- The pre-existing `STATE_RETENTION_DAYS` prune at `loadState` is unchanged (60-day safety net still in place)

---

## P2 — Watchdog timeout 90s → 180s

**Problem:** `src/campaign.js:57` defines `LEAD_TIMEOUT_MS = 90 * 1000` (90 seconds). Worst-case legitimate Connect-with-verify path on slow hosts (deep-read 20-30s + nav 15s + post-Send verify 60-70s ≈ 100-115s) exceeds the watchdog. The watchdog kills the in-flight action returning `lead_timeout_watchdog`, which is in `TRANSIENT_SIGNALS` (line 1105) → 3 retries (15s + 30s = 45s of wait), all guaranteed to time out the same way. Net effect: ~6 minutes wasted per slow lead, plus the connection MAY have actually been sent (we hung at the verify step).

CLAUDE.md notes "colleagues run on slow, overloaded machines; assume CPU/RAM starvation when tuning timeouts" — this bug is exactly the kind of thing colleagues hit.

**Change:**

In `src/campaign.js`, around line 57, change the constant:

Find:
```javascript
const LEAD_TIMEOUT_MS = parseInt(process.env.LEAD_TIMEOUT_MS, 10) || 90 * 1000;
```

Replace with:
```javascript
const LEAD_TIMEOUT_MS = parseInt(process.env.LEAD_TIMEOUT_MS, 10) || 180 * 1000;
```

(Verify the exact line number / shape during implementation; the env var pattern may differ slightly.)

**Why this is safe:**
- It's a constant. Cannot crash anything.
- Env-var override (`LEAD_TIMEOUT_MS`) preserved — operators who already set a custom value are unaffected
- Trade-off: a genuinely hung lead now blocks for 3 min instead of 90s. With BATCH_SIZE=5, worst-case stuck-batch wait = 15 min. Acceptable given the alternative is wasting 6 min on every false-positive.

**Acceptance:**
- The `90` is replaced with `180`
- `npm test` passes (no test changes)

---

## P3 — Local-browser login wait honors abort

**Problem:** `src/campaign.js:549-559` waits up to 120s for the user to log in to LinkedIn in the local-browser path. The wait loop does NOT check `campaign._abort`, so when the operator clicks Stop during this wait, the loop runs the full 120s before honoring the stop. (The GoLogin branch at 581-591 already has the abort check; this is a missed parallel.)

**Change:**

In `src/campaign.js`, inside the local-browser login wait loop (around lines 549-559 — verify exact location during implementation), add an abort check at the top of the loop body, mirroring line 582:

The current loop body (around line 550) starts with the URL check + sleep. Insert this line at the very top of the loop body:

```javascript
if (campaign._abort) { log('  ■ Abort detected — stopping login wait.'); break; }
```

**Why this is safe:**
- Pure additive `if` check inside an existing loop
- Mirrors the proven pattern in the GoLogin branch
- If `_abort` is never set during the wait (the common case), behavior is unchanged
- Cannot crash — the body is just `log` + `break`

**Acceptance:**
- The `if (campaign._abort) break;` line is present at the top of the local-browser login wait loop body
- `npm test` passes
- Manual verification (controller can do this): start a local-browser campaign without a logged-in LinkedIn session, click Stop while the wait dialog is showing → confirm Stop is honored within ~5s instead of waiting the full 120s

---

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| P1 | Zero | `saveState` fails on disk-full → campaign throws at startup | Same risk as line 991 today; no new attack surface. Disk-check from 2.8.20 already preflights free space. |
| P2 | Zero | Hung lead blocks for 3 min instead of 90s | Acceptable; current 90s causes 6 min of wasted retries on slow hosts. Net win. |
| P3 | Zero | Operator clicks Stop, log shows "Abort detected" | Desired behavior. |

## Branch & version shape

- Branch: `hotfix-2.8.24` cut from `main` (currently at `58cca82` after the 2.8.23 merge)
- Patches commit in order P1 → P2 → P3
- FINAL commit bumps `package.json` version 2.8.23 → 2.8.24
- Verification: `npm test` (existing 120 tests must still pass — no new tests in this hotfix)
- Merge to main as fast-forward

## Files touched (summary)

| File | P1 | P2 | P3 | FINAL |
|---|---|---|---|---|
| `src/campaign.js` | ~6 lines added in `startCampaign` | 1 line edit (constant) | 1 line added in local-browser loop | |
| `package.json` | | | | bump to 2.8.24 |

## Notes for the implementer

- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`, ALL of `public/`, ALL of `tests/`, `server.js`, `electron/`. This hotfix touches ONLY `src/campaign.js` + `package.json`. If you find yourself wanting to touch anything else, STOP and report.
- **No new tests in this hotfix.** The fixes are additive and verifiable by inspection. Adding tests here would invite scope creep (need to extract pure helpers, mock state.processed, etc.). Defer to a separate pass.
- **Verify line numbers before editing**. The spec quotes line numbers from the 2.8.23 codebase; the implementer should grep for the actual anchor lines (`async function loadState`, `LEAD_TIMEOUT_MS`, the local-browser login wait loop) before making changes.
- **DO NOT refactor while you're in there.** Pure additive deletion is the only allowed change for the catch block / WEEKLY_LIMIT / INMAIL_NO_CREDITS branches — and we explicitly chose to leave those alone, covering them via the boot scrubber instead.
