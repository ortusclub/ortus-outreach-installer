# Multi-Status Sheet Schema — Design

**Date:** 2026-05-11
**Author:** Antonio + Claude
**Status:** Spec — pending implementation plan
**Driver:** Sam's proposal to split the single `Status` column into per-campaign-mode status columns + hide non-relevant columns per campaign run.

## Problem

Today every campaign mode (`connect_only`, `check_status`, `message_only`, `introduce_back`, `open_profile_only`, `inmail_only`) writes to one shared `Status` column. As a lead progresses CC → Check → DM, the cell overwrites itself and prior history is lost.

Sam wants:
1. Each campaign type writes to its **own** Status column so the full per-lead journey is visible in one row.
2. **Columns not relevant to the active campaign get hidden** — when running a CC campaign, the operator shouldn't see OP/DM/InM noise.
3. Sam's bulk Connection Status checker needs additional columns (`LinkedIn URN`, `Membership ID`, etc.) which his Apps Script already provisions.

## Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Keep `Stage`** as the single source of truth for pre-filter logic | Stage already drives every filter at `src/campaign.js:893–914` and `:1547–1561`. Touching it = risk of leads being re-processed or silently skipped. Stage stays, status columns are layered on top. |
| 2 | **Keep `Status`** as a "Latest Action" mirror column | One at-a-glance column when scrolling without unhiding all per-mode columns. |
| 3 | **One global `Sender` column**, NOT a per-campaign Account Used pair | Saves 6 columns; per-campaign attribution is captured implicitly by which Status column is populated. |
| 4 | **Schema is additive per-sheet** | Columns get provisioned the first time their mode runs against a sheet. Run only CC + DM → only those columns ever exist. |
| 5 | **Visibility is dynamic per-run** | When app launches a campaign, Apps Script hides all non-relevant mode columns and shows that mode's. |
| 6 | **No migration script** | User starts a fresh sheet. Existing sheets keep working unchanged via the bridge's dual-schema support. |

## Final column inventory

### Always visible

| Column | Purpose |
|---|---|
| First Name | Lead identity |
| Last Name | Lead identity |
| LinkedIn URL | Lead identity |
| LinkedIn URN | Sam's bulk-check needs the `ACoAA…` URN |
| Membership ID | Sam's bulk-check needs the numeric member number |
| Open Profile | `Yes` / `No`, set when meta captured at connect time |
| Connected | `Yes` / `No`, current connection state |
| **Stage** | Internal workflow state — drives all pre-filters |
| **Status** | Latest Action mirror — mirrors whichever mode-specific Status was just written |
| **Sender** | GoLogin profile name of the most recent action |
| Date | Date of latest action — **separate column** (matches Sam's Apps Script) |
| Time | Time of latest action — **separate column** (matches Sam's Apps Script) |

### Added per mode (provisioned on first run of that mode)

| Mode | Columns added |
|---|---|
| `connect_only` (CC) | Connection Status |
| `check_status` (standalone) | Check Status |
| `message_only` | DM Status, Check Status |
| `introduce_back` | Intro Status, Check Status |
| `open_profile_only` | OP Status |
| `inmail_only` | InM Status |

Check Status column is **shared** between standalone Check Status and the pre-flight sweep inside Message Only / Introduce Back.

## Writeback routing

Each writeback in `src/campaign.js` (current lines 1776–1888) writes to: **Stage** + **Status (latest)** + **Sender** + **the one mode-specific column**.

| Action | Stage | Status (Latest) | Mode-specific column write |
|---|---|---|---|
| `connection_sent` | `Connect Pending` | `Connection Request Sent` | `Connection Status` = `Connection Request Sent` |
| `already_connected` | `Connected` | `Already Connected` | `Connection Status` = `Already Connected` |
| `already_processed` | (mode-dependent — stamped per mode at `:1824–1828`) | (unchanged) | None — the prior real writeback already populated the mode-specific column |
| `status_accepted` | `Connected · DM Now` | `Check Done.` | `Check Status` = `Connected` |
| `status_pending` | (unchanged) | (unchanged) | `Check Status` = `Still Pending` |
| `message_sent` (DM, no introMode) | `DM Sent` | `DM Sent` | `DM Status` = `DM Sent` |
| `message_sent` (Intro, introMode) | `IC Sent` | `IC Sent` | `Intro Status` = `IC Sent` |
| `op_message_sent` | `OP Sent` | `DM Sent` *(legacy text — preserved as-is from `src/campaign.js:1841`)* | `OP Status` = `OP Sent` |
| `inmail_sent` | `InM Sent` | `Done` | `InM Status` = `InM Sent` |
| Any skip | `Skipped: <reason>` | `Skipped: <reason>` | Active mode's column = `Skipped: <reason>` |

`Stage` never gets touched by this change. All existing pre-filter logic at `:893–914` / `:1547–1561` continues to work unchanged.

## Apps Script contract

The Apps Script bridge gains one new entrypoint:

```js
prepareSheet({ sheetId, mode })
```

Behavior:
1. Read current header row.
2. For each column required by `mode` (see Added-per-mode table), if it doesn't exist, append it to the right of the always-visible block.
3. Apply that column's conditional-format rules (success-green for `'Sent'` variants, skip-grey for `Skipped:`).
4. Read the "always-visible + this mode's columns" set; everything else (other modes' columns) → `hideColumns()`.
5. Return `{ ok: true, columnsProvisioned: [...], columnsHidden: [...] }`.

App calls `prepareSheet` immediately before campaign start, with the active `mode`. If the call fails (Apps Script down, sheet not bridged), log a warning and proceed — writes still work, just visibility/provisioning doesn't.

## App-side changes

### `src/campaign.js`

- `startCampaign` calls `prepareSheet(sheetId, mode)` before the launch loop (similar to where the existing `ensureTrackingColumns` call lives).
- Each `sheetData.status = …` writeback (lines 1776–1888) gets a sibling write to the mode-specific field. The bridge ignores unknown fields, so adding fields to `sheetData` is backward-compatible with old sheets — only new sheets with the new columns will see writes land.

New `sheetData` field names (handed to the bridge):
- `connectionStatus`
- `dmStatus`
- `opStatus`
- `inmStatus`
- `introStatus`
- `checkStatus`

### `src/sheets-writer.js`

Add a `prepareSheet` helper mirroring `ensureTrackingColumns`. Same auth flow.

### Apps Script (`google-apps-script.js`)

- Add `prepareSheet` handler in the dispatcher.
- Extend column-header map with the 6 new mode-specific columns.
- Extend conditional-format provisioning to cover the new columns.

## Migration

None — user creates a new sheet. Existing sheets stay on legacy schema. Bridge already supports both via the `'Stage' in row` check at `src/campaign.js:865`.

## Risk assessment

| Risk | Mitigation |
|---|---|
| Pre-filter logic accidentally changes when status writes are split | We're NOT touching the filter — Stage stays as the source of truth. The new status columns are pure output. |
| Apps Script `hideColumns` slows down sheet | `hideColumns` is O(columns); we have ≤ ~25 columns total. Negligible. |
| Operator runs CC campaign on a sheet that already has DM Status data → DM Status gets hidden, looks like data was lost | Pre-launch confirmation in the app: "This will hide 3 columns from previous campaigns. Continue?" — only first time per mode-switch per sheet. Skip if user opts out. |
| `prepareSheet` fails silently → operator runs campaign blind to wrong columns | App surfaces an alert if `prepareSheet` returns non-OK; campaign continues but a yellow banner shows in the dashboard. |

## Out of scope

- Migrating existing sheets (user opts to start fresh).
- Multiple sheet tabs per workbook (campaign-per-tab).
- Reverting visibility after a campaign ends (columns stay hidden until next campaign re-decides).

## Open dependencies

- **Sam:** sign-off on the `prepareSheet` Apps Script contract above (he wrote the original Apps Script; he'll be folding this into his next deploy).

## Acceptance criteria

1. Fresh sheet + CC campaign → only `Connection Status` column added; OP/DM/InM/Intro/Check columns never exist.
2. Same sheet + Message Only campaign → `DM Status` + `Check Status` added; `Connection Status` is hidden during the run.
3. Same sheet + CC campaign again → `Connection Status` re-shown; `DM Status` + `Check Status` re-hidden.
4. Pre-filter still gates correctly on `Stage` — no leads re-processed, no leads skipped that should be active.
5. Legacy sheets (no `Stage` column) continue to work unchanged.
6. Skip reasons land in the active mode's status column with `Skipped:` prefix.
