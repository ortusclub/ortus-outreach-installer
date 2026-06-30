# Follower Growth — Reliability & Picker Batch

**Date:** 2026-06-30
**Area:** Follower Growth (Team Launch) — engine + picker UI
**Status:** Design approved, ready for planning

## Goal

Close five gaps in the Follower Growth (FG) Team Launch flow so the batch
reports logged-out accounts honestly, stops wasting invite slots on people who
already follow the page, shows a target count that actually decrements, and
lets the operator keep the account picker scoped to live Ortus accounts.

## Background (current behavior, from code)

- `src/linkedin/follower-invite.js` drives the LinkedIn page "Invite to follow"
  modal. `openInviteModal` navigates to the invite URL then waits up to 2 min
  for the modal selector. `scrapeResults` already reads a per-result
  `canInvite` flag. `runFollowerInvites` returns `{ invited, skipped, ... }`.
- `src/connections/fg-team-launch.js` (`runTeamLaunch`) runs each
  employee→profile pair sequentially, calls `deps.send` (the invite engine),
  then `deps.record({ rows, invitedIds, ... })` to persist invited IDs.
- `src/connections/search-service.js`:
  - `buildFgTargets` builds the per-operator queue: role-matched, non-DNC,
    minus `alreadyInvited` keys (via `inviteKey`), capped at budget. Returns
    `{ count, eligible, matched }`.
  - `listFgColleaguesMatched` returns `{ email, name, total, matched }` per
    colleague — `matched` is the RAW role-match count and does NOT subtract
    already-invited.
- The picker UI in `public/js/app.js` + `public/index.html` reads SoO data via
  `loadSoOStatus()` / `/api/soo-status` (fetched once) and shows accounts with
  an ortus / not-ortus indication; non-ortus accounts are shown-and-flagged,
  not hidden.

## Global Constraints

- Node ≥22, Express 4, vanilla JS frontend (no bundler).
- Test framework: `node --test`. Pure-helper unit tests preferred; UI changes
  are manual-verify.
- **Off-limits files:** `src/linkedin/outreach.js`, `src/linkedin/actions.js` —
  do not modify.
- Never `git add data/monitoring-campaign.json`.
- Bump `package.json` patch version before relaunching `dev:app`; auto-relaunch
  after commits touching runtime code.
- All engine paths stay **soft-skip** — a single account failing must never
  abort the rest of the batch. Write-backs stay best-effort.

## Requirements

### R1 — Logout detection & honest reporting

- In `openInviteModal`, after `page.goto(inviteUrl)` and **before** the 2-min
  modal wait, read `page.url()` and test it against a login/authwall pattern:
  matches any of `/login`, `/authwall`, `/checkpoint`, `/uas/login`.
- On match, throw a new error class
  `LoggedOutError extends Error { softSkip = true; loggedOut = true; }`
  (defined alongside `InviteModalUnavailableError`). This skips the 2-min wait.
- `runTeamLaunch`'s catch block detects `err.loggedOut` and stamps a distinct
  line: `🔒 [account] Logged out — needs re-login`, sets
  `slot.status = 'skipped'`, `slot.reason = 'logged out'`, and a
  `slot.loggedOut = true` flag for the UI to badge.
- Non-logout soft-skips keep their existing `⊘` labeling.

**Test:** pure matcher `isLoggedOutUrl(url)` — true for the four patterns,
false for a real invite URL and for `linkedin.com/company/.../admin`.

### R2 — Target/"matches" count reflects eligible, not raw matched

- The per-colleague number surfaced in the picker must reflect **eligible**
  (role-match minus already-invited and already-follows), so it decrements as
  invites land. The dedupe in `buildFgTargets` is already correct; this is a
  display/consumption change in how `listFgColleaguesMatched` (or its caller)
  reports the number.
- No change to send-time behavior.

**Test:** `listFgColleaguesMatched` (or the chosen reporting helper) subtracts a
provided already-invited/already-follows set from the per-colleague count.

### R3 — Already-follows-the-page: skip, drop from list, persist

- In `scrapeResults` / `selectPerson` path, when a result name-matches the
  queued person but has `canInvite = false`, classify it as
  `alreadyFollows` (distinct from a generic name-mismatch skip).
- `runFollowerInvites` collects these member IDs and returns them as a new
  `alreadyFollowing` array on its result object (alongside `invited` /
  `skipped`).
- `runTeamLaunch` passes `alreadyFollowing` IDs into the **same `record()`
  store** used for invited IDs (per decision), so `buildFgTargets`'
  `alreadyInvited` dedupe removes them permanently.
- Because they are persisted, on subsequent runs they no longer fill a slot in
  the target count nor appear in the queue/list.
- Log a clear line, e.g. `[account] already follows — N skipped & remembered`.

**Test:** given fake `scrapeResults` returning a name-matched
`canInvite:false` row, `runFollowerInvites` returns that ID in
`alreadyFollowing` and not in `invited`; `buildFgTargets` excludes IDs present
in the persisted store.

### R4 — SoO refresh button on the picker

- Add a small ↻ refresh control on the FG account picker that re-invokes
  `loadSoOStatus()` (re-fetch `/api/soo-status`), then re-renders the picker so
  the ortus indication and any SoO-derived state update without an app
  restart.
- Reuses the existing endpoint and load function; shows a brief loading state
  and the existing SoO-error pill on failure.

**Verify:** manual — toggle SoO, click refresh, list updates.

### R5 — Hide non-ortus accounts (SoO Company column)

- Filter the picker so accounts whose **SoO Company column ≠ Ortus** are
  removed from the list entirely (not shown-and-flagged).
- **Fail open:** when SoO is unreachable (error state), show ALL accounts
  unfiltered with the SoO-error pill visible, so a transient SoO outage does
  not block launching.

**Test:** pure predicate `isOrtusAccount(soo)` — true when SoO Company is
Ortus, false otherwise; filter returns all rows when SoO data is absent/empty
(fail-open).

## Out of scope

- Any change to `outreach.js` / `actions.js`.
- The standalone operation-funnel Apps Script / sheet (separate project).
- Reworking the monthly-vs-permanent semantics of the record store — R3 reuses
  the existing per-operator monthly `record()` store as-is.

## File map (anticipated)

- `src/linkedin/follower-invite.js` — `LoggedOutError`, logout URL check in
  `openInviteModal`; `alreadyFollows` classification + `alreadyFollowing`
  return; `isLoggedOutUrl` helper (exported, pure).
- `src/connections/fg-team-launch.js` — handle `loggedOut` in catch; route
  `alreadyFollowing` IDs into `record()`.
- `src/connections/search-service.js` — eligible-aware per-colleague count;
  `isOrtusAccount` predicate (or reuse existing SoO helper).
- `public/js/app.js` + `public/index.html` — refresh button, non-ortus filter,
  logged-out badge in per-account status.
- `tests/` — new pure-helper unit tests for R1, R2, R3, R5.
