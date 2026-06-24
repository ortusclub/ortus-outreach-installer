# Multi-Tab Lead-Source Guard — Design

**Date:** 2026-06-19
**Status:** Draft for review
**Branch:** eod-2102-integration

## Problem (evidence-backed)

On 2026-06-18 a CC+IC campaign (`HTECHxDELLxINT_LON1`, owner adri@ortusclub.com,
app **v2.111.1**) sent connection requests to the **wrong people** — including two
Ortus employees (Anjhelo Naguit, James Benedict Armiro) and unrelated contacts
(Tim Hitchin, Shirley Bailey) — all carrying the *correct* HTECH note.

Root cause is **not** the connect-identity gate (it passed every send because each
loaded profile matched the wrong-source row). The configured workbook
(`1GHILxhw7rK1dnke7c3SC2nDcn7_x9jQbdz_lsT36Png`) is **multi-tab**, and its first
tabs are system tabs, not leads:

```
Tab 1: SavedSearch/Batches
Tab 2: Recent Messages
Tab 3: Recent Connections   (Account, First/Last, Public ID, URN, Member ID…)
…
gid=1249624821: the actual HTECH lead list
```

`src/sheets.js:138` already documents the trap: *"Google's CSV export defaults to
the first sheet when no gid is given, which silently pulls the wrong data for any
spreadsheet with multiple tabs."* When the campaign's `sheetUrl` lost its
`gid=1249624821` (the run was a `(rerun)` — the gid was dropped from a stored
snapshot, not the fresh paste), the read silently pulled a **system tab** instead
of the leads. `Recent Connections` is a log of each account's existing network —
i.e. colleagues + a grab-bag — which is exactly who got invited.

## Goal

Make it **impossible** for a campaign to connect to a tab other than the one the
operator explicitly chose — at paste time, across reruns/restores, and as a final
runtime backstop.

## Non-goals

- No change to the connect-identity gate (`profile-identity.js`) — it is innocent here.
- No change to `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits).
- Not solving auto-update (#15) — separate; the fix still requires a manual reinstall.

## Design — three layers

### Layer 1 — Tab picker at paste (front door)

When the operator enters/pastes a sheet URL in the Data step:

1. Resolve the spreadsheet id and call a new endpoint `GET /api/sheet/tabs?sheetUrl=…`.
2. Backend asks the Apps Script for the tab list (see Apps Script change below).
3. **If >1 tab:** show a required chooser (dropdown) listing each tab as
   `name · NN rows`. No tab selected → the launch is blocked (same hard-lock
   pattern as the mandatory primary-URL gate).
4. **If 1 tab:** auto-select it, no UI.
5. On selection, show a **3-row preview + detected columns** so the operator
   confirms it's the lead list, and **write the chosen gid into the stored
   `sheetUrl`** (and a parallel explicit `sheetGid` field — see Layer 2).
6. **Rerun tab-change confirmation:** on a rerun/restore, if the operator picks a
   tab whose gid differs from the saved one, require an explicit confirm —
   *"You changed the tab from `<old name>` to `<new name>` — are you sure?"* — so a
   tab switch is never silent.

### Layer 2 — Lock the gid everywhere (correctness)

The gid must survive every replay path so a rerun/restore can never drop it.

- Persist an explicit **`sheetGid`** field on the campaign config alongside
  `sheetUrl` (don't rely on the URL string surviving intact).
- Thread `sheetGid` through: `startCampaign` → `_lastRunSettings` →
  `history.json` snapshot → `restoreCampaign` → monitoring snapshot
  (`monitoring-campaign.json`) → the rerun/queue-only paths in `server.js`.
- A single normalizer `withGid(sheetUrl, sheetGid)` (in `src/utils.js`) returns a
  URL guaranteed to carry the gid; every fetch/write call routes through it.

### Layer 3 — Hard-stop guard before sending (safety net)

Independent of the UI and snapshots, refuse to run on an ambiguous/wrong source.
In the lead-load path (`fetchSheet` / campaign start), abort with a clear,
surfaced error when **any** of these hold:

- The workbook has >1 tab **and** no gid is resolvable for this campaign.
- The resolved tab's name matches the **system-tab blocklist**
  (case-insensitive: `recent connections`, `recent messages`,
  `savedsearch/batches`, `savedsearch`, `batches`, `soo`, `linkedin accounts`,
  `ops log`, `events`, `config`).
- The fetched rows **don't look like leads**: a positive check requiring both a
  recognizable **First Name** header (`First Name`/`firstName`/`first_name`) and a
  column that yields a LinkedIn URL via the existing `extractLinkedInUrl`.

`fetchSheetCsv`'s current behavior (silently read tab #1 when gid missing) is
**removed** — missing gid on a multi-tab workbook becomes a hard error, never a
silent default.

## Apps Script change

Add a `listTabs` action to `google-apps-script.js` (the shared script all
operators deploy): given `sheetId`, return
`[{ name, gid, rowCount, header: [first row cells] }]` via `getSheets()`.
The existing gid-aware router already resolves a tab by gid; this only adds
enumeration. **Operator action:** re-paste the updated script + redeploy (standard
for any Apps Script change here).

## Files

- `google-apps-script.js` — new `listTabs` action.
- `src/sheets.js` — `listSheetTabs(sheetUrl)`; harden `fetchSheetCsv` (fail on
  multi-tab + no gid); `looksLikeLeadRows(rows)` validator + system-tab check used
  by the run guard.
- `src/utils.js` — `withGid(url, gid)`, `spreadsheetIdFromUrl(url)`
  (`extractSheetGid` already exists).
- `server.js` — `GET /api/sheet/tabs`; thread `sheetGid` through start / rerun /
  restore / monitoring; apply the run guard in the start path.
- `public/index.html` + `public/js/app.js` — tab chooser + preview in the Data
  step; launch hard-lock when a multi-tab workbook has no tab chosen; carry the
  chosen gid into the start payload.
- Tests (`node --test`): `withGid`/`spreadsheetIdFromUrl`, `looksLikeLeadRows`
  (accept a real lead header, reject `Recent Connections`/`Recent Messages`
  headers), tab-list parse, and the guard's abort decisions.

## Error handling / UX

- Tab list fetch fails (script not redeployed, no access) → the chooser shows a
  clear "couldn't read tabs — paste a link that already includes `#gid=`, or
  redeploy the Apps Script" message; launch stays blocked for multi-tab.
- Run-guard abort → campaign does **not** start; the dashboard shows the specific
  reason (no gid / system tab / not a lead list) instead of a silent wrong run.

## Back-compat

- Existing single-tab campaigns: unaffected (auto-select).
- Existing stored campaigns with a gid in the URL: keep working; `sheetGid` is
  backfilled from the URL on next start.
- Existing stored campaigns **without** a gid on a multi-tab workbook: will now
  hard-stop on rerun (correct — that's the dangerous case) and prompt a re-pick.

## Open questions for review

1. **Blocklist vs positive-only:** keep both the system-tab name blocklist *and*
   the lead-column check, or rely on the lead-column check alone? (Recommend both —
   defense in depth.)
2. **Where the picker lives:** inline dropdown under the URL field (matches the
   existing sheet-preview area) vs a modal. (Recommend inline, consistent with the
   current Data step.)
3. **Fresh vs rerun for this incident:** still unconfirmed; the design covers both,
   so it doesn't block — but confirming will tell us which path lost the gid first.
