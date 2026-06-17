# CC+IC follow-up: visible countdown + batched send

**Date:** 2026-06-17
**Status:** approved design, pending spec review
**Version target:** v2.111.0 (genuine new feature → minor bump)

## Problem

The CC+IC automated first follow-up DM fires silently. Two operator-reported issues:

1. **No visibility.** After an intro, the follow-up is queued (e.g. "due 11:33:56") but there's no on-screen indication on the live-campaign card of when it will fire. The operator waits blind.
2. **Open/close flapping.** Each follow-up's due-time is `its own intro time + delay` (`buildFollowUpTask`: `dueAt = created + delayMinutes*60_000`). With staggered intros, the follow-ups ripen one at a time across the 60s runner ticks, so the browser opens → sends one → closes → reopens a minute later, repeatedly. This is RAM-heavy, confusing, and a needless footprint to LinkedIn.

The one-browser-session drain **already exists**: `runDueTasks` (primary-task-runner.js) selects all due tasks, partitions by sender, opens each browser **once**, loops every due task, then closes. The churn is purely a scheduling artifact.

## Goals

- A live countdown to the follow-up send, on the live-campaign card ("Twin hero" placement).
- Follow-ups for a run fire **together in one browser session**, `delay` minutes after the **last** intro.
- Reuse the existing follow-up-delay wizard field; change its meaning + label, don't add a new control.

## Non-goals (YAGNI)

- No countdown on the dashboard home mini-card (live-campaign card only; can add later).
- No change to the runner's idle-gating, semaphore, retry, or dedupe logic.
- No change to `accept` tasks — only `follow-up` tasks are rescheduled.
- No per-lead countdown — one shared batch countdown (matches the batched send).

## Part 1 — Twin-hero countdown

### Data source

The follow-up summary rides the existing `GET /api/campaign/status` payload (`getCampaignStatus()` in `src/campaign.js`), which `renderActiveCard` already polls (~2s).

`campaign.js:610` warns the status path must stay off synchronous disk. So:

- New **pure** helper `summarizeFollowUps(tasks, campaignProfileIds, now)` in `primary-tasks.js` → `{ count, dueAt, sender }` for the soonest pending follow-up batch belonging to the current campaign's profile ids (or `null` when none). `sender` is `'local-browser'` or a profileId, mapped to a label client-side.
- The `/api/campaign/status` route becomes async and reads the queue through a **~5s memoized read** (`loadTasks` result cached behind a timestamp), then calls `summarizeFollowUps`. At a 2s poll this is at most one small-file read per 5s — off the synchronous hot path, no new in-memory mutable cross-module state.
- The route merges `followUp: { count, dueAt, sender } | null` into the payload.

### UI

- `renderActiveCard(status)` renders a `.fu-hero` block immediately after the `.vj-monitor` hero **only when** `status.followUp && status.followUp.count > 0`; otherwise the block is absent/hidden.
- Markup (new classes, added to `dashboard-v0.3.css`, scoped under `body[data-dashboard='v3']`, matching the validated sketch `public/sketches/followup-countdown.html`):
  ```html
  <div class="fu-hero">
    <div class="fu-hero-row"><span class="fu-count" id="fuCount">08:42</span><span class="fu-cap">until follow-ups send</span></div>
    <div class="fu-line">⏳ <b id="fuQueued">3</b> queued · sent together in one batch · from <b id="fuSender">you</b></div>
  </div>
  ```
- **Countdown tick:** reuse the existing client tick that already animates `until next check` (the `__cockpit`/renderCockpit smooth-countdown infra). Compute `dueAt − now`; format `MM:SS`, or `H:MM` when over an hour. When `dueAt` is in the past (batch is firing / runner not yet idle) show `Sending…`.
- `sender` label: `'local-browser'` → "you", a profileId → "the primary".
- Design system: monochrome — `--ink` count, `--gray` caption, ⏳ glyph (matches the log's "Follow-up queued" lines). No gold (reserved for the Start CTA).

## Part 2 — Batched send

### Scheduling change

The send machinery is untouched. Only the due-times change so the batch ripens together:

- New **pure** transform `slideFollowUpDueDates(tasks, campaignProfileId, dueAt)` in `primary-tasks.js`: returns a new tasks array where every **pending follow-up** with that `campaignProfileId` has `dueAt` set to the given value. Leaves `accept` tasks, other campaigns, and non-pending tasks unchanged.
- New IO wrapper `enqueueFollowUpBatched(task, delayMinutes, now, file)`: load → compute `batchDue = now + delayMinutes*60_000` → `slideFollowUpDueDates(tasks, task.campaignProfileId, batchDue)` → set the incoming task's `dueAt = batchDue` → dedupe (existing `dedupeKey`) → save. Returns the stored task or `null` on dup.
- `auto-intro.js` calls `enqueueFollowUpBatched(...)` instead of `enqueuePrimaryTask(...)` for the follow-up it builds (the `maybeBuildFollowUp` → enqueue site).

Effect: each new intro pushes the whole campaign's follow-up batch to "now + delay". Once intros stop for `delay` minutes (and the app is idle — the runner's existing `guardIdle`), every queued follow-up is due in the same tick and `runDueTasks` sends them in one session.

### Wizard field

The delay field already exists (`#follow-up-delay`, "Send after ⟨10⟩ min", wired via `followUpDelayMinutes` → `buildFollowUpTask`). Change only the **copy** so its meaning is honest:

- Label/row: e.g. "Send all follow-ups together, ⟨10⟩ min after the **last** intro".
- Update the adjacent hint and the `First Follow-up Message` `<small>` ("~10 min after the intro" → "after the last intro, all together").
- Default stays 10. No JS rewiring — `followUpDelayMinutes` already flows through.

## Edge cases

- **Multiple accounts:** follow-ups route by `sender`; `runDueTasks` already opens one browser per sender. Sliding is per `campaignProfileId`, so each account's follow-ups batch independently. The countdown shows the soonest pending batch across the campaign.
- **Follow-up enqueued after a batch already fired:** it's a fresh pending task with `dueAt = now + delay`; no earlier siblings remain pending, so it simply starts a new (single-item) batch. Correct.
- **App restart with pending follow-ups on disk:** the memoized status read picks them up on the next poll, so the countdown reappears within ~5s — no special boot path needed.
- **Dup follow-up for the same lead:** still blocked by `dedupeKey` (`follow-up:<profileId>:<leadUrl>`); sliding runs before the dedupe check and is harmless on dups.
- **Sending still in progress:** the runner's `guardIdle` already defers follow-ups until no campaign is running and the browser count is 0, so the batch naturally waits until sending finishes, then fires `delay` after the last intro.

## Testing (TDD)

Pure functions get `node --test` unit tests; DOM + the async route are verified manually (existing convention).

- `summarizeFollowUps`: none pending → null; one pending → its dueAt/sender/count; multiple → soonest dueAt + total count; ignores `accept` tasks, other campaigns, non-pending; multi-account count.
- `slideFollowUpDueDates`: bumps all pending follow-ups of the target campaign to the new dueAt; leaves accepts / other campaigns / non-pending untouched; empty/!match → unchanged copy.
- `enqueueFollowUpBatched`: aligns the new task + existing siblings to `now+delay`; returns null on dup; persists atomically (temp+rename, as `saveTasks`).

## Files touched

- `src/primary-tasks.js` — `summarizeFollowUps`, `slideFollowUpDueDates`, `enqueueFollowUpBatched` (pure + thin IO).
- `src/linkedin/auto-intro.js` — call `enqueueFollowUpBatched` at the follow-up enqueue site.
- `server.js` — `/api/campaign/status` async + memoized queue read → merge `followUp`.
- `public/js/app.js` — `renderActiveCard` draws `.fu-hero`; wire the countdown tick + sender label.
- `public/css/dashboard-v0.3.css` — `.fu-hero` / `.fu-hero-row` / `.fu-count` / `.fu-cap` / `.fu-line` (from the sketch).
- `public/index.html` — relabel the follow-up-delay row + hint + the `First Follow-up` `<small>`.
- `package.json` — bump to v2.111.0.
- Tests: `tests/follow-up-batch.test.js` (or extend an existing primary-tasks test).

## Out of scope / future

- Dashboard mini-card countdown.
- A "send now" button to fire the batch early.
- Surfacing per-lead follow-up status in the sheet beyond what's stamped today.
