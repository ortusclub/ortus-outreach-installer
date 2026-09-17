# OP Magellan — HubSpot Check/Import at scale (30k-safe)

Status: spec / agreed scope 2026-09-17
Branch: `feat/magellan-company-title-dedup` (PR #56)

## Problem

Magellan's Check → Import works for small/medium accounts but falls over on large
ones. A colleague ran `camillec@ortus.solutions` (2,528 connections / 2,293 checked
/ 435 duplicates) and got **"The app did not answer. It may have restarted"** — the
Import step never rendered.

Root cause (measured): the Check step (`buildPreview`) is a **blocking** route that
does *all* the HubSpot lookups + plan-building before responding. The client's
`mgFetch` aborts at **30s** (`MG_FETCH_TIMEOUT_MS`). A big account's Check takes
minutes (the code itself calls it "three minutes of HubSpot calls"), so the client
gives up. The finished preview **is** stored server-side in `_state.preview`, but the
client only renders step 3 from the blocking response — so the timeout loses the
render even though the data exists. Reloading (Cmd+R) re-runs the whole Check and
times out again → large accounts are stuck.

## Goals

Make the HubSpot side of the pipeline never be the bottleneck up to LinkedIn's ~30k
connection cap. Specifically:

1. **No client timeout** — Check completes and renders regardless of how long it takes.
2. **Bounded polled state** — `getState()` stays a few KB no matter the account size.
3. **Write resilience** — one bad contact can't fail a whole batch of 100.

## Non-goals (agreed 2026-09-17)

- **No streaming refactor.** Keep today's build-whole-plan-then-write shape;
  `buildPreview`/`_plans` may still hold the full plan in memory (30k objects is fine
  in RAM). Memory stays O(connections), not O(chunk).
- **No parallelism.** Lookups/writes stay sequential batches of 100 with 429 retry.
  A 30k account taking ~5–15 min in the background is acceptable.
- **No LinkedIn Collect changes.** Reading 30k connections out of the browser
  (throttling/detection) is a separate follow-up, not in this scope.
- **No resumability/checkpoints.** An interrupted run re-runs from scratch; writes
  are idempotent so nothing already written is lost.

## Design

### 1. Non-blocking Check + polled result

- **Route `POST /api/magellan/preview`** (server.js:3510): stop `await`-ing the whole
  `buildPreview`. Start it (fire-and-forget, same pattern as `startCollect` /
  `startImport`) and return immediately: `{ started: true }` (or
  `{ started: false, reason }` when a run is already live). `buildPreview` already
  drives `_state` (phase `checking` → `done`/`error`) and stores `_state.preview`.
- **Client** (`app.js` ~33248 `previewMagellan` + `startMagellanPolling`): don't read
  the result from the `mgFetch` response. Instead, the poller renders step 3 from
  **polled `_state.preview`** the moment `phase === 'done'` and `preview` is present;
  on `phase === 'error'`, show `_state.error`. The `mgFetch` call becomes a fast
  "start" request (well under 30s), so the timeout never trips for the Check.
- **Reload path**: `refreshMagellanState()` on load already fetches `getState()`; when
  it sees a completed `_state.preview`, it renders step 3. This makes Cmd+R actually
  recover a finished-but-unrendered preview (today it doesn't).
- Keep `buildPreview`'s existing `_state.running` guard so a Check can't stomp a
  live collect/import.

### 2. Bounded polled state

- `getState()` returns `{ ..._state }`, and `_state.preview` currently carries the full
  `duplicates` and `blocked` arrays → grows with account size and is serialized on
  every ~2s poll.
- Move the **full** duplicate/blocked detail to a module-level holder (like `_plans`)
  used by the import/sheet write; keep only **counts + a capped sample** (e.g. first
  25 + a `total`) in `_state.preview`. The UI only shows the count ("435 people in
  HubSpot more than once") plus a short example list, so a cap is invisible to the
  operator.
- Result: `getState()` payload is bounded (KB) whether the account has 200 or 30k
  connections. Full detail still reaches the sheet.

### 3. Batch-write item retry

- `batchCreate` / `batchUpdate` (hubspot-client.js) currently POST a batch of 100; a
  single validation error (400) fails the whole batch (HubSpot batch/update is atomic).
  `postWithRetry` only retries 429/5xx, not 400.
- On a **400 / partial validation failure** of a batch, **bisect/retry item-by-item**:
  re-send the batch split down until the offending row(s) are isolated; the good rows
  still write, the bad one(s) are collected into `errors` with their reason. Bound the
  extra calls (bisection is O(log n) per bad item, not O(n)).
- This makes the write phase robust to any single poisoned row (the mergeConnections
  casing cause is already fixed + unit-tested; this is defense-in-depth for unknown
  future bad values).

## Files

- `src/connections/magellan-run.js` — `buildPreview` (fire-and-forget start,
  bounded `_state.preview`), `getState`, the full-detail holder.
- `src/connections/hubspot-client.js` — `batchCreate`/`batchUpdate` bisect-on-400.
- `server.js` — `POST /api/magellan/preview` returns on start, not on finish.
- `public/js/app.js` — `previewMagellan` + `startMagellanPolling` render step 3 from
  polled state; `refreshMagellanState` recovers a finished preview on reload.

## Testing (`node --test`)

- **Non-blocking route**: the preview route resolves quickly while `buildPreview` is
  still running (assert `started:true`, state `phase:'checking'`); a later poll shows
  `phase:'done'` with `preview`.
- **Bounded state**: after a Check with many duplicates, `getState().preview.duplicates`
  is capped (length ≤ cap) and carries the true total; the full list is available to
  the import/sheet path.
- **Batch item retry**: a batch containing one invalid row writes the good rows and
  reports the bad one (drive via the `fetchImpl` seam returning a 400 for the poisoned
  batch, 200 for the split).
- **Reload recovery**: with `_state.preview` set and `running:false`, the client render
  path produces step-3 counts without a fresh preview call.

## Risks / open questions

- HubSpot **daily API budget**: one 30k account ≈ 60k+ calls (lookups + writes).
  Fine for a single big account; several in a day could approach tier limits. Out of
  scope to solve now, but worth a note/warning for very large accounts (future).
- The **LinkedIn Collect** side is the real 30k ceiling (throttling/detection) and is
  explicitly deferred — a scalable HubSpot side doesn't help if Collect can't pull 30k.
- Bisection adds calls on a poisoned batch; bounded and rare, but log it so a portal
  with many genuinely-bad rows is visible rather than silently slow.
