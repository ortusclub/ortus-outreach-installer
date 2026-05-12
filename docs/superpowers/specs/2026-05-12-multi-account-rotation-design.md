# Multi-Account Rotation + Connect+Introduce Back UX — Design

**Date:** 2026-05-12
**Author:** Antonio + Claude
**Status:** Spec — pending implementation plan
**Driver:** Connect + Introduce Back mode currently writes to the pre-v2 sheet schema, hides its Throughput knob, and only checks acceptance every 6 hours — meaning intros never fire for leads accepted mid-run. Plus operator request: idle accounts should use their dead air to bulk-check.

## Problem

Three coupled issues in `connect_and_introduce` mode, plus one cross-mode sheet-cleanup ask:

1. **Slow acceptance detection.** In-campaign bulk-check is gated by a 6-hour cooldown (`BULK_CHECK_INTERVAL_MS` in `src/campaign.js`). A 1–2 hour campaign fires the check once, then never again — late-campaign acceptances are invisible until the post-campaign scheduler picks them up hours or days later, by which time the intro is stale.
2. **Idle accounts sit unused.** Under the rotating-batch worker pool, accounts not currently sending have closed browsers and do nothing until their next turn. That idle time could be used to fetch each account's recent connections and fire intros.
3. **Sheet schema mismatch.** `connect_and_introduce` renders the legacy v1 schema (URL / Connection Request Status / Connected Status / OP / Message / InMail / Reply…) instead of the v2 schema all other current-version modes use (First Name / Last Name / LinkedIn URL / Stage / Sender / Date / Time / mode columns; URN + Membership ID + Last Action hidden). Mode columns are also not strictly scoped to the active mode — legacy columns from prior runs leak through.
4. **Throughput UI knob hidden.** "Connections per account per day" appears only for `connect_only`, not for `connect_and_introduce`, even though the mode sends connection requests and is subject to the same LinkedIn weekly cap.

## Decisions (locked from brainstorm)

| # | Decision | Rationale |
|---|---|---|
| 1 | **In-campaign bulk-check cooldown for `connect_and_introduce` → 5 minutes** per (sheet, profile) | Catches acceptances within ~5 min of happening so intros fire while the campaign is still active. Voyager's `/mynetwork/invite-connect/connections/` endpoint is one of LinkedIn's most forgiving — same call LinkedIn's own UI makes constantly. |
| 2 | **Idle accounts reopen their browser briefly to bulk-check** during their wait between batches (Approach B from brainstorm) | Matches user intent that idle time gets used productively. RAM impact bounded — browser only open during sending OR during a 10–15s check, never resident throughout. Reopen overhead (~10–20s) is small vs. the 75–225s typical idle stretch. |
| 3 | **Idle bulk-check gated by:** mode = `connect_and_introduce` + campaign uptime > 30 min + 5-min cooldown elapsed + `browserSemaphore` slot available + profile is parked (browser closed) | Stacked guards prevent runaway checks on short campaigns or under semaphore pressure. |
| 4 | **Each account checks its own leads only** | Voyager constraint — `getRecentConnections` only returns the logged-in account's connections. No cross-account scan is possible. |
| 5 | **Post-sending phase: 6h × 7-day schedule, all participating accounts** | Existing `src/post-campaign-bulk-check.js` already does this — verification only, no expected code change. Triggered at campaign-end (`registerSchedule` in the finally block). |
| 6 | **Dual-stamp avoidance:** for rows where an auto-intro will fire, skip the `Connection Accepted Status` / `Connected` writes — `Introduction Status` becomes the single source of truth for that row | User's "bypass Connection Check update" rule. Prevents `Connection Accepted Status = "Connected"` + `Introduction Status = "Introduction Made"` dual-stamp on the same row. |
| 7 | **Column headers renamed:** `Connection Status` → `Connection Request Status`, `Check Status` → `Connection Accepted Status` (everywhere — every mode that uses these columns) | Existing names are ambiguous — `Connection Status` could mean either the request or the acceptance. Renaming via the existing `COLUMN_RENAMES` migration mechanism preserves historical data automatically. |
| 8 | **`Connected` boolean column → always-hidden metadata** | Redundant with `Connection Accepted Status` (which carries the same info as text). Bot keeps writing it for downstream tooling, but operators don't see it by default. |
| 9 | **Strict per-mode column visibility:** every column not in the active mode's set gets hidden — never deleted | User's "(c) mixed workflows + (ii) hide don't delete" choice. Preserves historical data across mode switches on the same sheet; operator can manually unhide if they want to see past runs. |
| 10 | **Legacy v1 columns** (`OP`, `Message`, `InMail`, `Account Used`, `Reply`, `Reply At`, `Reply Preview`) **get hidden** by every `prepareSheet` call | Same rule applied to columns inherited from pre-v2 schemas. Hidden, not deleted — data preserved. |
| 11 | **Never-touched columns:** `Last Action`, `LinkedIn URN`, `LinkedIn Membership ID` stay provisioned + hidden on every run, regardless of mode | User's non-negotiable rule. These are for bot internals. |
| 12 | **Connect + Introduce Back's Throughput section** gets the same "Connections per account per day" knob as Connect Only, with Advanced disclosure collapsed by default | Mode sends connection requests → subject to same LinkedIn invite cap → same operator controls. |
| 13 | **All bulk-check telemetry stays in `log()`** → console + `data/campaign.log`. No UI surface for bulk-check internals | User's "logging stays in log" rule — UI stays clean, debugging happens in console. |
| 14 | **Auto-send defaults OFF preserved** — intro DM fires only when mode is explicitly selected AND a primary person + intro body are configured | Already gated in `src/linkedin/auto-intro.js:59-63`. No new always-on toggles introduced. |

## Architecture — two-phase model

```
Phase 1: Sending phase (campaign loop running, accounts have leads left)
├── Active accounts: send batch (5 leads) → in-batch bulk-check (5-min cooldown)
│                    → fire intros for newly-Connected rows → close browser
└── Idle accounts:   wait for next slot → if 5-min cooldown elapsed AND
                     semaphore slot free AND uptime >30 min:
                       → briefly reopen → bulk-check → intros → close
                       → return to idle wait

Transition: last connect sent → register all participating profiles with
            post-campaign scheduler (existing mechanism) → exit campaign loop

Phase 2: Post-sending phase (post-campaign-bulk-check.js scheduler)
└── 30-min tick → per (sheet, profile) entry: 6h cooldown × 7-day window
    → bulk-check + runAutoIntros per entry → operator desktop popup + email
       reminder per sweep (per existing notification-prefs opt-in)
    → skips while a foreground campaign is running
```

## File-by-file changes

### `ortus-outreach-sheets-bridge.gs` — Google Apps Script (single file, contained)

**`COLUMN_RENAMES`** — add two entries:
```js
{ from: 'Connection Status', to: 'Connection Request Status' },
{ from: 'Check Status',      to: 'Connection Accepted Status' },
```

Existing migration mechanism copies values from old column → new column, then deletes the old column. Idempotent — re-running is safe.

**`MODE_COLUMNS_V2`** — updated:
```js
var MODE_COLUMNS_V2 = {
  connect_only:          ['Connection Request Status'],
  check_status:          ['Connection Accepted Status'],
  message_only:          ['DM Status', 'Connection Accepted Status'],
  introduce_back:        ['Intro Status', 'Connection Accepted Status'],
  open_profile_only:     ['OP Status', 'Open Profile'],
  inmail_only:           ['InM Status'],
  connect_and_introduce: ['Connection Request Status',
                          'Connection Accepted Status',
                          'Introduction Status']
};
```

`Connected` boolean dropped from every visible mode set.

**`ALWAYS_HIDDEN_BY_DEFAULT_V2`** — add `Connected`:
```js
var ALWAYS_HIDDEN_BY_DEFAULT_V2 = [
  'Last Action',
  'LinkedIn URN',
  'LinkedIn Membership ID',
  'Connected'
];
```

**`LEGACY_COLUMNS_TO_HIDE_V2`** — new constant:
```js
var LEGACY_COLUMNS_TO_HIDE_V2 = [
  'OP', 'Message', 'InMail', 'Account Used',
  'Reply', 'Reply At', 'Reply Preview'
];
```

**`handlePrepareSheet`** — append step 4b after the existing always-hidden step:
```js
LEGACY_COLUMNS_TO_HIDE_V2.forEach(function(col) {
  var idx = headers.indexOf(col);
  if (idx === -1) return;
  sheet.hideColumns(idx + 1);
  if (hidden.indexOf(col) === -1) hidden.push(col);
});
```

**`FIELD_MAP`** — update column-header targets:
```js
status:             'Connection Request Status',  // was 'Connection Request Status' (same target)
connectionStatus:   'Connection Request Status',  // was 'Connection Status'
checkStatus:        'Connection Accepted Status', // was 'Check Status'
connectedAlready:   'Connected',                  // unchanged (now hidden)
introductionStatus: 'Introduction Status',         // unchanged
```

Bot keeps writing through the same field names — only destination headers change.

### `src/campaign.js`

**New constants:**
```js
const IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_CAMPAIGN_MIN_DURATION_MS = 30 * 60 * 1000;
```

Existing `BULK_CHECK_INTERVAL_MS = 6h` stays as the legacy default for other modes.

**In-batch bulk-check trigger (existing, at `src/campaign.js:2050`):** switches to the per-mode interval. For `connect_and_introduce`, the gate becomes 5 minutes instead of 6 hours.

**Idle bulk-check trigger (new):** inserted into the worker-pool loop (`src/campaign.js:1540` region). Iterates parked profiles each pool tick:
- Skip if mode ≠ `connect_and_introduce`
- Skip if campaign uptime ≤ 30 min
- Skip if profile's browser is currently open (the active in-batch trigger handles it)
- Skip if profile is parked permanently (`weeklyLimited`)
- Skip if no semaphore slot available (try next iteration)
- Skip if 5-min cooldown not elapsed for this (sheet, profile)
- Otherwise: call `runIdleBulkCheck(profileId)`

**`runIdleBulkCheck(profileId)` helper (new):** acquires a semaphore slot, calls `launchProfile`, calls `bulkCheckConnections` with `{ suppressAcceptedStamp: willAutoIntro }` (see Dual-stamp avoidance below), invokes `runAutoIntros` for returned `connectedUrls` when `willAutoIntro` is true, writes cooldown timestamp, closes the profile, releases the slot. Failures logged but non-fatal.

**Dual-stamp avoidance:** the existing in-batch bulk-check call at `src/campaign.js:2052` and the new `runIdleBulkCheck` both compute `const willAutoIntro = !!(primaryName && primaryIntroBody)` and pass it as `suppressAcceptedStamp` to `bulkCheckConnections`. When true, the bulk-check returns `connectedUrls` as usual but omits the `cc` / `connectedAlready` writes from its batch update. The caller is responsible for the follow-up `runAutoIntros` call, which writes `Introduction Status` directly to those rows.

End-state semantics:
- `willAutoIntro === true` (primary configured): bulk-check finds Connected → suppresses Accepted stamp → caller fires intros → `Introduction Status` is the only stamp on those rows.
- `willAutoIntro === false` (primary missing): bulk-check finds Connected → writes Accepted stamp normally → no intro fires → `Connection Accepted Status = Connected`.

**Column-name references:** any string match against `'Connection Status'` or `'Check Status'` updated to the new headers. Specifically the row-skip logic and result-action stamping at `:862–916` / `:1074–1156` / `:2020–2080`.

### `src/linkedin/bulk-check-connections.js`

Function signature gets one new optional arg:
```js
export async function bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, opts = {}) {
  const { suppressAcceptedStamp = false } = opts;
  // ...
}
```

When `suppressAcceptedStamp === true`: every newly-matched URL **omits** the `cc` / `connectedAlready` writes from the batch update array (those rows are skipped from `updates.push`), but the URL is **still** included in the returned `connectedUrls` so the caller's `runAutoIntros` call still fires for it. Still-pending rows continue to get their `Still Pending (timestamp)` stamp regardless of this flag.

When `suppressAcceptedStamp === false` (default — back-compat): existing behavior unchanged, every match gets `cc: 'Connected'` + `connectedAlready: 'Yes'` written.

Column-name references (currently reads `Connection Request Status` / `Connection Status` / `Status` headers when scanning rows for the `Connection Request Sent` filter) are already tolerant of the new `Connection Request Status` name — that header was the intended target all along.

### `src/linkedin/auto-intro.js`

No structural change. Verify the `updateSheetRow` call writes `introductionStatus` (already the case at `:97-103` and `:113-119`). Field name maps to the unchanged `Introduction Status` header.

### `src/post-campaign-bulk-check.js`

**Verification only — no expected code change.** Read the `registerSchedule` call site in `src/campaign.js`'s finally block to confirm:
- One `registerSchedule` call per participating profile (not just the first one)
- For `connect_and_introduce`, `primaryName` / `primaryIntroBody` / `primaryUrl` / `introTitle` are passed through

If either is wrong, fix at the call site in `src/campaign.js`. The scheduler module itself stays untouched.

### `public/js/app.js`

Single line at `:1474`:
```js
// Before:
const isConnectMode = (mode === 'connect_only');

// After:
const isConnectMode = (mode === 'connect_only' || mode === 'connect_and_introduce');
```

`#daily-limit-knob` becomes visible for Connect + Introduce Back. Parallel Accounts row + Advanced disclosure already render for non-auto-routed modes — no further change.

### `public/index.html`

No change. Existing Throughput markup (`:268–374`) already has the knob, ticker, suffix label, explainer text, Parallel Accounts row, and `<details class="alpha-advanced">` (collapsed by default since it has no `open` attribute).

### `tests/`

**Extend `tests/build-sheet-data-for-action.test.js`:**
- New column names (`Connection Request Status`, `Connection Accepted Status`) in field-name → header assertions
- `connect_and_introduce` mode produces correct three-column write pattern per `result.action`
- `suppressAcceptedStamp` path: when the flag is true, newly-matched URLs are returned in `connectedUrls` but their `cc` / `connectedAlready` writes are omitted from the batch update array

**Add `tests/idle-bulk-check.test.js`:**
- Cooldown gate: 5-min minimum per (sheet, profile)
- Uptime gate: idle checks suppressed before 30-min threshold
- Semaphore-full state is a no-op (not a crash)
- Mode gate: non-`connect_and_introduce` modes never trigger idle check
- Parked-permanently profiles (`weeklyLimited`) skipped

Test runner: `node --test tests/*.test.js` (no Jest, no Vitest, per CLAUDE.md).

## End-state per-row examples (Connect + Introduce Back)

| Row state | Connection Request Status | Connection Accepted Status | Introduction Status |
|---|---|---|---|
| Just sent — still pending | `Connection Request Sent` | _(blank)_ | _(blank)_ |
| Pending → bulk-check pass found no acceptance | `Connection Request Sent` | `Still Pending (2026-05-12 11:19)` | _(blank)_ |
| Accepted → auto-intro fired | `Connection Request Sent` | _(blank — bypassed per rule 6)_ | `Introduction Made` |
| Accepted → auto-intro skipped (no primary configured) | `Connection Request Sent` | `Connected` | _(blank)_ |
| Auto-intro DM failed (e.g. messaging blocked) | `Connection Request Sent` | _(blank)_ | `Failed` |

## Rollout

1. **Commit Apps Script change first** (the `.gs` file).
2. **Notify operator** — Antonio coordinates redeploy with Sam + Katrina. Every operator pastes the new `.gs` content into their Apps Script editor and redeploys. Existing sheets get migrated automatically on first `prepareSheet` call after redeploy (via `COLUMN_RENAMES`).
3. **Commit `.js` / `.html` changes** after Apps Script is live.
4. **Auto-relaunch `dev:app`** after each runtime commit per CLAUDE.md operator rule #2: `pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; npm run dev:app > /tmp/dev-app.log 2>&1 &`
5. **Manual verification** in the Electron shell:
   - Select Connect + Introduce Back → confirm Throughput section shows the daily-limit knob with +/- ticker, Advanced collapsed
   - Run a small test campaign (5 leads, 2 profiles) on a fresh test sheet → DevTools console shows `📡 [name] Idle bulk-check…` log lines after ~5 min of uptime
   - Verify the sheet renders the three-column v2 layout, hidden columns are tucked away

## Out of scope

- **Cross-account Voyager scans.** Each account checks only its own leads (LinkedIn API constraint).
- **Renaming for other modes** — `message_only` / `introduce_back` / `inmail_only` / `open_profile_only` get the header rename (because they share `Check Status` → `Connection Accepted Status`) but **no other behavioral changes** in this branch. Their column visibility logic is unchanged.
- **Replacing the post-campaign scheduler.** Existing `src/post-campaign-bulk-check.js` stays; this design layers in front of it for the in-campaign phase and verifies the handoff at campaign-end.
- **Daily/weekly invite tracking.** Today's "campaign limit per account" is enforced per-run only (per the explainer text in `public/index.html:288`). Persistent daily/weekly tracking remains on the roadmap.
- **UI surfacing of bulk-check internals.** All bulk-check + idle-check telemetry stays in `log()`; the dashboard does not render any bulk-check status.

## Open items the implementation plan will resolve

- Exact placement of the idle bulk-check trigger inside the worker-pool loop (before slot selection? after? on a separate timer?)
- Exact wording of the new log lines (must be greppable, must distinguish in-batch trigger from idle trigger)
- Whether `runIdleBulkCheck` should refresh `state.processed` to avoid races with the in-batch trigger
- Specific test fixtures for the new tests (existing fixtures cover v1 schema only)
