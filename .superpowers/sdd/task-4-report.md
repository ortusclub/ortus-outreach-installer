# Task 4 Report: Failed is retryable — alreadyInvited counts only Invited

## Status: COMPLETE

**Commit:** `d36b1c8` — `feat(fg): Failed invites are retryable — alreadyInvited counts Invited only`
Branch: `preflight-linter-2135`

## What was built

- `src/connections/fg-sync.js` — added `invitedKeysFromState(invites)`, transcribed verbatim from the brief: filters to `Status === 'Invited'` rows, maps to Member ID (else LinkedIn URL), drops falsy keys.
- `services/fg-roster/autopilot.js` — imported `invitedKeysFromState` as a **static top-of-file import** (not the brief's `await import()`) since the file already uses static ESM imports for its siblings (`fg-autopilot.js`, `fg-cloud-launch.js`) — matches existing style per the brief's watch-out. Replaced the inline `snap.invites.map(...)` with `invitedKeysFromState(snap.invites)`.
- `server.js` — added `invitedKeysFromState` to the existing `fg-sync.js` import (line 94).

## Deviation from brief: fixed BOTH branches in server.js, not just one

The brief named a single location (`server.js:2447-2449`, "the manual team-launch alreadyInvited build"). The real file has **two** identical inline-map call sites inside `/api/fg/team-launch/start`, one per dispatch branch:
- line ~2450 — the `cloud` target branch (`if ((b.target || 'local') === 'cloud')`)
- line ~2498 — the `local` browser-launch branch (the async IIFE below it)

Both build `alreadyInvited` from the same `snap.invites` shape for the same route. Fixing only the cloud branch would leave the local-browser Team Launch path still treating `Failed` rows as permanently skipped — the exact bug this task exists to close, just reachable via a different dispatch target. I replaced both with `invitedKeysFromState(snap.invites)`. This is the same root-cause fix applied to both siblings of the same caller, not scope creep into unrelated endpoints.

Left untouched (out of scope — not dispatch paths): `/api/fg/colleagues` (line ~2244, roster-count preview) and `/api/fg/build` (line ~2268, single-account preview-build, non-team-launch). Neither dispatches invites; the brief scoped this task to "BOTH dispatch paths" specifically.

## Pre-existing uncommitted state folded in

`services/fg-roster/autopilot.js` and `tests/fg-roster-autopilot.test.js` already carried substantial **uncommitted** work in the working tree before this task started (the `getFgState`/`alreadyInvited`/`monthlyBudget` mechanism itself, plus its two tests — confirmed via `git show HEAD:services/fg-roster/autopilot.js`, which has none of it). That's evidently an earlier, not-yet-committed task in this same SDD chain. Per the brief's own `git add` list (which names the whole file, not a hunk) and the fact that this task's job is explicitly to refine that exact mechanism, I committed the whole file including that antecedent work, matching the pattern from the prior task-4-report.md entries in this file's history.

One knock-on fix was needed in that pre-existing test: `mirrors manual FG: caps at monthly budget + skips already-invited + writes Queued` (tests/fg-roster-autopilot.test.js) built its `getFgState` fixture rows without a `Status` field, so under the new Status-aware filter they were correctly no longer counted as already-invited (test failed: expected `['999','https://x/y']`, got `[]`). Added `Status: 'Invited'` to both fixture rows — this is exactly the new intended behavior, not a workaround.

## server.js git hygiene

`server.js` had a real pre-existing, unrelated uncommitted hunk (the `/api/fg/autopilot/run` timeout-handling change, `AbortSignal.timeout(20000→120000)` + a `202 pending` branch on timeout). Used `git add -p` to stage only my 3 hunks (import line, cloud-branch replacement, local-branch replacement) and left that hunk unstaged. Verified via `git diff --cached server.js` before commit that only my 3 hunks were included.

## TDD evidence

RED:
```
$ node --test tests/fg-already-invited-status.test.js
✖ tests/fg-already-invited-status.test.js
  SyntaxError: The requested module '../src/connections/fg-sync.js' does not provide an export named 'invitedKeysFromState'
ℹ pass 0 / fail 1
```

GREEN (after implementation):
```
$ node --test tests/fg-already-invited-status.test.js
✔ only Invited rows count as already-invited (Failed is retryable)
ℹ pass 1 / fail 0
```

Full targeted set:
```
$ node --test tests/fg-already-invited-status.test.js tests/fg-roster-autopilot.test.js tests/fg-*.test.js
ℹ tests 73 / pass 73 / fail 0
```

Full repo suite (regression check):
```
$ node --test tests/*.test.js
ℹ tests 1375 / pass 1373 / fail 0 / skipped 2
```

## Self-review

- `invitedKeysFromState` is byte-identical to the brief's code block.
- Autopilot import style matches the file's existing static-import convention (deviated from the brief's `await import()` per its own watch-out instruction).
- Confirmed via `git diff --cached` before commit that: (a) `server.js` staged only the 3 intended hunks, leaving the unrelated timeout-handling hunk untouched in the working tree; (b) no `data/*.json`, sketches, `.agents/`, or worktree files were staged; (c) `git status --short` after commit shows those files still dirty/untracked exactly as before.
- `node --check` clean on all three touched runtime files (`server.js`, `services/fg-roster/autopilot.js`, `src/connections/fg-sync.js`).

## Concerns

- The two out-of-scope `alreadyInvited` builds (`/api/fg/colleagues`, `/api/fg/build`) still count `Failed` rows as already-invited. If those endpoints are meant to reflect the same "Failed is retryable" rule, that's a follow-up task — flagging, not fixing, since the brief scoped this task to dispatch paths only.
- This task's commit also carries an earlier, not-yet-committed task's work (the `alreadyInvited`/`monthlyBudget` mechanism + its 2 tests in `autopilot.js`/`fg-roster-autopilot.test.js`) — confirmed pre-existing via `git show HEAD`, not authored by this task, but folded in per the brief's explicit whole-file `git add` list. Worth confirming with the pipeline owner that this was intentional sequencing and not a missed intermediate commit.
