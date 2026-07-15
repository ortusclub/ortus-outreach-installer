# FG Cloud — honest live status card + per-person selection ticks

**Date:** 2026-07-15
**Repos:** app `ortus-gologin-clone` (branch `preflight-linter-2135`) + engine `ortus-salesnav-scraper-cloud` (branch `main`)

## Problem

When a **cloud** Follower Growth run is launched, both status cards (the campaign-tab
card and the dashboard board card) sit at `0 invited · 120 pending · warming up the VM
(~2 min)` while the live view clearly shows the VM actively selecting people in the
"Invite to follow" modal. It looks frozen.

**It is not a data bug.** Verified against the live engine: the most-recent FG campaign
had 87 leads correctly marked `sent`/`Invited` with the right account + `sentAt` stamps,
and the app's own counting logic computes 87 from those leads. The `0` in the screenshots
was *true at that instant* — the first account was still selecting names; the batch
Invite click (and the `sentAt` stamps) landed ~6 minutes later.

Three real UX gaps cause the "frozen" perception:

1. **Phase keyed only on sent-count.** `_fgtlBuildCloudStatus` sets `phase='launching'`
   whenever `totalProcessed === 0`, so during an entire account's modal selection the
   card reads "warming up the VM · invites start shortly (~2 min)" — even though the VM
   is actively working.
2. **No per-person feedback.** FG is a batch mode: it selects a whole account's budget
   in one modal, clicks Invite **once**, then marks all those leads `sent` together. So
   the counter sits at 0 for minutes, then jumps (e.g. +87). CC/CC+IC mark per-lead and
   tick smoothly; FG doesn't.
3. **Two card render paths disagree** (campaign-tab card said "Launching", board card
   said "Sending") — `[[feedback_two_live_status_cards]]`.

## Constraints

- **LinkedIn modal sends on one click.** `runFollowerInvites` (follower-invite.js:236–246)
  loops `selectPerson` per person to *select* them, then clicks Invite **once** — credits
  deduct together. A truthful per-person *sent* moment does not exist inside one modal.
  → We deliver per-person **selection** ticks; the `sent` total finalizes when the batch
  click lands. (Chosen over chunked sends, which would change LinkedIn send cadence and is
  explicitly out of scope.)
- **Mirror rule** (`[[feedback_vm_must_mirror_local_exactly]]`): `follower-invite.js` is
  vendored byte-identical in the app (`src/linkedin/follower-invite.js`) and the engine
  (`campaign-lib/linkedin/follower-invite.js`). Any change to the primitive must be
  **additive** (default no-op) and applied **byte-identical to both copies**.
- Off-limits: `src/linkedin/outreach.js`, `src/linkedin/actions.js`.

## Design

Two independent parts. **Part A ships alone** (app-only, no engine redeploy) and already
removes the "frozen" perception; **Part B** adds the per-person ticks and needs a v61
engine redeploy.

### Part A — Honest status card (app-only)

- `_fgtlBuildCloudStatus(campaign, leads, extra)` gains an `extra` arg carrying
  `{ live, liveAccount, liveProgress, leadCounts }` (all optional).
- **Phase selection** becomes live-aware:
  - `error` / `done` unchanged.
  - `sending` when `totalProcessed > 0` **OR** `live === true` (VM browser actively
    driving — the first batch is mid-selection).
  - `launching` **only** when running, not live, nothing processed yet (genuine
    pre-browser warmup).
- **Headline counts** prefer the engine's authoritative `leadCounts` (`{sent,pending,
  skipped}`) when present; fall back to the recomputed-from-leads totals.
- **Log/label**: when `live` and nothing sent yet, show `● Inviting on the VM — <account>`
  instead of "warming up (~2 min)". When `liveProgress` is present, show the tick line
  (see Part B) `↗ selecting <name> · <done>/<total> on <account>`.
- **Board card** (`renderActiveCard` / `_refreshCloudActiveStatus` path) uses the same
  live-aware phase + label so both cards agree.

### Part B — Per-person selection ticks (engine, redeploy v61)

- **Primitive** `runFollowerInvites` gains an additive `onProgress` callback (default
  no-op), invoked **after each `selectPerson`** with
  `{ person, ok, index, total, selectedSoFar }`. No change to when/how the Invite click
  fires. **Mirrored byte-identical** into `src/linkedin/follower-invite.js` (hook present,
  unused on local runs, which already have their own live status).
- **Live registry** (`campaign-live-registry.js`) gains
  `progress(campaignId, account, patch)` that re-stamps `cmp:live:<id>`, **merging** a
  `progress: { selecting, done, total }` field into the existing
  `{podIP, podPort, account, startedAt}` payload (same key, same TTL/heartbeat).
- **Engine orchestration** `runFollowerGrowth` passes an `onProgress` that calls
  `registry.progress(campaign.id, account, { selecting: person.name, done: index+1,
  total })`. Registry is injected the same way the live-view browser registration is.
- **Detail endpoint** (`campaign-api.js` `liveOf`) returns `liveProgress` parsed from the
  `progress` field of the stamp, alongside `live`/`liveAccount`.
- **App poll** (`fgtlCloudPoll`) reads `detail.liveProgress` and passes it into
  `_fgtlBuildCloudStatus` (Part A) → rendered as the tick line.

## Testing

- **Primitive (both copies):** `onProgress` fires once per queued person, in order, with
  correct `index`/`total`/`ok`; default no-op is safe; existing invite/skip/sent
  behaviour and return shape unchanged (existing tests green).
- **Registry:** `progress()` merges the progress field without dropping `account`/pod
  info; a subsequent `register()`/heartbeat preserves or refreshes it; malformed reads
  degrade to `liveProgress: null`.
- **Engine orchestration:** `runFollowerGrowth` forwards a working `onProgress` (fake
  `sendInvites` invokes it) and reaches the registry with the right shape.
- **App:** `_fgtlBuildCloudStatus` phase/label matrix — warming (running, !live, 0) vs
  live (`live:true`, 0 sent) vs sending (processed>0) vs done; prefers `leadCounts`;
  renders the tick line when `liveProgress` present. Pure unit tests.

## Out of scope

- Chunked/sub-batch sends (true per-person `sent`).
- Engine per-account credit snapshot (existing deferred Task 9).
