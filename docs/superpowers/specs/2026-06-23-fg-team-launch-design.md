# Follower Growth — Team Launch (replaces the queue)

**Date:** 2026-06-23
**Status:** Design — approved for planning
**Sketch:** `public/sketches/fg-launch-B-board.html` (Match board, chosen direction)
**Supersedes the queue flow in:** the current `#nav-follower-growth` build → queue → send screen

## Problem

Today Follower Growth is a per-operator, two-stage queue: pick one operator → Build list → Queue
(writes "Queued" rows to the FG sheet) → Send (launches that one profile, sends, marks Invited).
Running the whole team means repeating this N times, and the intermediate Queued stage is confusing.

The team wants: pick several Ortus employees at once → each is paired to their GoLogin profile
(auto-matched by email, manual when it can't) → set the role keywords once → launch the whole set in
**one sequential batch** (one browser at a time — the documented multi-browser crash constraint),
watching a live campaign card. No Queued stage.

## What we're building

Replace the `#nav-follower-growth` screen with the **Team Launch** UI from sketch B:

1. **Step 1 — role filter:** the existing function/title keywords as pill-chips (type-to-add +
   quick-add presets). Applies to every selected employee. Defaults to the current marketer set.
2. **Match board:** left = searchable, multi-select list of employees (colleagues) whose networks
   are in the Connections DB; right = GoLogin profiles panel with credit bands. Each ticked employee
   auto-pairs to a profile by **email** (profile name === operator email convention); unmatched rows
   expose a manual profile dropdown. Search matches name / email / paired account. Select-all
   respects the current search.
3. **Launch:** one "Launch all" action runs the selected employees **sequentially**.
4. **Live status card:** reuses the real `vj-card` chrome — eyebrow status, progress hero, and a
   `vj-log-line` live log streaming per-account events, plus a batch summary.

## Run model (the engine)

New server route, sequential loop, no Queued stage:

```
POST /api/fg/team-launch/start   body: { keywords:[...], pairs:[{ operator, operatorName, account(email), profileId }, ...], month }
GET  /api/fg/team-launch/status  → _fgTeam (poll target, mirrors _fgSend shape)
POST /api/fg/team-launch/stop    → sets abort flag
```

Engine (`src/connections/fg-team-launch.js`, orchestrated from server.js), for each pair **in order**:

1. `buildFgTargets(criteria, { operator, account, month, alreadyInvited, budget })` — build this
   employee's targets fresh (DNC-safe, keyword-filtered, deduped vs already-invited, budget-capped).
   Reuses existing `search-service.js` — **no DNC change**.
2. If 0 targets or 0 remaining budget → log `skipped` with reason, continue.
3. `launchProfile(profileId, token)` (GoLogin) → puppeteer `page`. One profile open at a time.
4. `runFollowerInvites({ page, inviteUrl, queued: targets, log, shouldAbort })` — existing sender.
5. `markFgInvited({ memberIds: invited, account, operator, month })` — **keep write-back**: stamps
   Invited / Invited At in FG Invites and bumps FG Budgets. Skips the Queued stage entirely.
6. Close the browser; move to the next pair. Respect the abort flag between/within accounts.

`_fgTeam` status object (polled every 2s):

```js
{
  running, phase,                 // 'launching' | 'inviting' | 'marking' | 'done'
  totalAccounts, doneAccounts,    // progress
  currentAccount,                 // email currently running
  sent, skipped, invitesTotal,    // rolling counts
  perAccount: [{ account, status:'waiting|running|done|skipped', invited, reason }],
  logs: [ "[ISO] message", ... ], // NDJSON-ish lines, last ~200, rendered by v3RenderLogLine
  error,
}
```

## UI integration

- Rebuild `#nav-follower-growth` in `public/index.html` to the Team Launch layout (filter card +
  match board + the existing `vj-card` markup, parameterised). Remove the old build/queue/send DOM
  from the panel.
- `initFollowerGrowth()` (`app.js`) repointed: load employees (colleagues with DB coverage) + GoLogin
  profiles + FG Budgets (for credit bands), render chips/board, auto-pair by email.
- Reuse `renderActiveCard`'s log line renderer (`v3RenderLogLine`) and the `vj-log-line` styling for
  the live log (already proven in the sketch).
- Launch button → `POST /api/fg/team-launch/start` with the paired set → poll status → drive the card
  (eyebrow, progress, log, summary) exactly like the sketch.
- **Kept in code but removed from the happy path:** `fgQueue()` / `/api/fg/queue` (no longer called).
  Old single-operator `fgBuild/fgSendStart` helpers may be deleted once the new screen is verified.

## Data sources (all existing)

- **Employees / colleagues:** the warm-via owners from the Connections DB annotation
  (`search-service.js` `getAnnotated` → `warmVia` emails). Need a small helper to list the distinct
  colleagues + a per-colleague connection count for the board.
- **GoLogin profiles + credits:** `getProfiles(token)` + FG Budgets (`fgRemaining` / `fgAccountCredit`).
- **Targets:** `buildFgTargets()` (unchanged).
- **Write-back:** `markFgInvited()` (unchanged).

## Out of scope (Phase 1)

- True parallel sends (explicitly excluded — sequential only).
- Persisting team-launch state across app restart (in-memory `_fgTeam` like `_fgSend` today).
- Changing DNC / budget / Apps Script schemas.
- Per-person live rows in the log (account-level granularity for now; finer detail is a follow-up).

## Success criteria

- Selecting ≥2 employees, setting keywords, and clicking Launch runs each paired account one after
  another; the live card shows progress + a streaming log; finishes with a correct sent/skipped summary.
- Accounts with no remaining budget or no targets are skipped (logged with reason), not errored.
- Sent invites appear in the FG Invites sheet (Invited / Invited At) and FG Budgets is bumped.
- No "Queued" rows are written. Only one GoLogin browser is open at any moment.
- Stop aborts cleanly between accounts.

## Risks

- **Crash constraint:** must guarantee one browser at a time — the loop awaits close before the next
  launch; add a guard so a second team-launch can't start while one runs.
- **Budget race:** build each account's targets immediately before its send (not all up front) so the
  budget/already-invited set is fresh.
- **Off-limits files:** `src/linkedin/outreach.js` and `actions.js` are not touched;
  `follower-invite.js` is the FG sender and is in scope.
