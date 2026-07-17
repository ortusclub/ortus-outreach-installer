# Op-funnel sheet — run-health redesign

**Date:** 2026-07-17
**Status:** design — awaiting user review
**Sheet:** `OP FUNNEL NEW - ORTUS APP` (`1NeFwHclpB1bkGXKu4f4LjOG0KVIbivQgrnVCjj2tL8U`)

## Problem

The `FG Invites` tab is a flat append-log of every target row. It answers no question well. Operators cannot tell **"did the last run work?"** because:

1. **Unreadable time** — `Invited At` is a raw UTC ISO string (`2026-06-23T13:37:19.712Z`). You cannot see *when* a run happened or sort by it meaningfully.
2. **Mystery "Queued"** — a row is written `Queued` before the send, then flipped to `Invited` on reconcile. If the send fails (logged out, empty invite URL), the row sits `Queued` **forever**. There are many such rows and nothing explains them. The recent empty-`inviteUrl` bug produced exactly these.
3. **No run concept** — thousands of target rows, no grouping by launch, no per-account roll-up, no success/failure signal.
4. **Account column mixes** real account emails with `Local Browser`.

## Goal

Chosen primary job: **"Did the last run work?"** at a glance — per account, per launch.

## Chosen approach (from brainstorm)

- **Run unit:** Variant A — one row per **account × launch**. Scan a `Result` column; all green = clean run, any red = that account failed, with the reason.
- **Summary source:** **auto-formula** — the Run Health tab recomputes itself from the detail tab via a `QUERY` array formula. Zero extra app writes, cannot drift.
- **Rollout:** **migrate in place** (safe now — no campaign running). Add columns to the live `FG Invites` tab; do not create parallel tabs.

## Design

### Two tabs

**① `FG Invites` (detail — machine-readable + audit).** Migrated in place. The app already reads this tab, so the existing 13 columns keep their **order** (writes are positional — see Constraints); three columns are **appended**:

Existing (unchanged order): `Target Name, LinkedIn URL, Member ID, Company, Job Title, Function Match, Geo, Invited By, Account, Status, Invited At, FG Note, Month`
Appended: `Run ID, Run At, Reason`

Changes to existing columns:
- **`Status` vocabulary:** `Queued` (transient, in-flight only) → resolves to **`Invited`** (confirmed sent) or **`Failed`** (with `Reason`). No row stays `Queued` after a run reconciles.
- **`Invited At`:** written as a real `Date` value (not an ISO string) and the column number-formatted `dd mmm yyyy, hh:mm` (Europe/London). Nothing reads it programmatically, so this is display-only-safe.
- **`Account`:** always the real LinkedIn account, never `Local Browser` (fall back to the operator's own account email, matching `fgtlPairs()`).

New columns:
- **`Run ID`:** the cloud campaign id (`cloudId`) for cloud runs; a synthesized `local-<ISO>` for local runs. Groups rows into a launch.
- **`Run At`:** dispatch timestamp as a real `Date`, London-formatted. This is the "when was it launched" field.
- **`Reason`:** free text on `Failed` rows — `logged out — needs re-login`, `page invite URL missing`, `too few targets matched`, etc. Blank on `Invited`.

**② `Run Health` (summary — human, Variant A).** New tab, driven by a **single array `QUERY`** over `FG Invites`. One row per `Run ID × Account`:

| Column | Source |
|---|---|
| Run At | min `Run At` for the group, London-formatted |
| Account | group key |
| Operator | `Invited By` |
| Targeted | count of rows in group |
| Sent | count `Status = Invited` |
| Stuck | count `Status = Failed` |
| Result | derived: `Sent = Targeted` → `✓ All sent`; `0 < Sent < Targeted` → `◑ Partial`; `Sent = 0` → `✗ <top Reason>` |
| Credits left | `30 − monthly Sent` for that account (join to `FG Budgets`, or `30 − Sent`) |
| Note | top `Reason` in the group when any `Failed` |

Rows sorted newest-first. Conditional formatting on `Result`: green `✓`, amber `◑`, red `✗`.

### Behaviour change: Failed is retryable

`getFgState().invites` currently maps **every** row to the already-invited skip-list regardless of `Status`. After this change, `alreadyInvited` must count **`Invited` only** — a `Failed` person is retried on the next run (they were never actually invited). In-flight `Queued` rows are also excluded from the skip-list (belt-and-braces; the engine's own anti-dupe still guards a genuine double-send).

## Code touchpoints

- **`fg-apps-script.js`**
  - `FG_HEADER` (and `src/connections/fg-export.js` `FG_HEADER`) — append `Run ID, Run At, Reason`. Keep existing order.
  - `fgQueue_` — rows now carry `Run ID`, `Run At`; write `Run At` as a `Date`.
  - `fgMarkInvited_` — write `Invited At` as a `Date`; set `Status = Invited`.
  - **new `fgMarkFailed_`** — flip in-flight rows for given Member IDs to `Status = Failed` + `Reason`, keyed by `Run ID`. Does **not** bump budget.
  - one-time migration helper (run once from the Apps Script editor): append the 3 columns, backfill `Run At` from `Invited At`, set legacy `Run ID = legacy`, relabel stuck `Queued` → `Failed` reason `legacy — never confirmed`, apply date number-format + `Result` conditional formatting, create the `Run Health` tab with the `QUERY`.
- **`src/connections/fg-export.js`** — `fgRow` emits `Run ID`, `Run At`, `Reason`; default `Status` stays `Queued` (transient).
- **`src/connections/fg-sync.js`** — `queueFgInvites` passes `runId`/`runAt`; new `markFgFailed({ memberIds, runId, account, reason })`.
- **`src/connections/fg-cloud-launch.js`** — `startTeamLaunchCloud` stamps `runId = cloudId` + `runAt` onto queued rows; `reconcileCloudRun` maps engine per-account results (`invited` → `markFgInvited`, `loggedOut`/released/error → `markFgFailed` with the account's reason).
- **`src/connections/search-service.js` / callers** — `alreadyInvited` derivation filters `Status = Invited`.

## Constraints (must not break)

- `FG Invites` **writes are positional** (`fgQueue_` `setValues` in `FG_HEADER` order; `keyOf_(r[2], r[1])` = Member ID/URL by index; `fgMarkInvited_` uses `FG_HEADER.indexOf(...)`). → new columns must be **appended**, and `fg-export.js` + `fg-apps-script.js` `FG_HEADER` must change together.
- `fgState_` **reads by header name** (`asObjects_`) → the summary/readers tolerate the new columns automatically.
- `FG Budgets` access is already header-name/self-healing (`budgetCol_`) → untouched.
- Migration runs with **no campaign active** (confirmed) — safe to rewrite headers/format in place.

## Out of scope (separate follow-ups)

- **Live status card "who's sending now"** — the card should name the account currently inviting (the sketch shows `anya@ortus.solutions live now`). Small, deterministic wire-up; tracked separately, not part of this sheet redesign.
- Team-launch rollup (Variant B) — not chosen.

## Success criteria

1. Opening `Run Health`, newest run on top, you can tell in one glance whether it was clean (all green) or which account failed and why (red + reason).
2. No row ever stays `Queued` after a run reconciles.
3. `Run At` / `Invited At` are human-readable London times.
4. A `Failed` person is re-attempted next run; an `Invited` person is skipped.
5. Live budgets (`fgRemaining`) and skip-list (`alreadyInvited`) still work — no regression to dispatch.
