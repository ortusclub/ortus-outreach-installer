# Sales Nav Scrape — UX polish + dual input — Design

**Date:** 2026-06-10
**Branch:** `integrate/steven-scraper`
**Status:** Approved (operator chose: restyle now; dual input both; tab dropdown deferred)

## Context

Steven's Sales Nav Scrape feature works (engine live — a job completed with 75 leads).
Operator feedback on the section 2b UI: (a) it looks flat / "old", not the clear-contrast
command-deck look of the rest of the app; (b) typing the destination tab feels clunky;
(c) wants to optionally feed input search URLs from a Google Sheet instead of pasting them.

**Hard constraint (operator):** "if we do this, it has to work — I don't know how the VM
is set up." → Every change here is **app-side only**. The engine's contract is unchanged:
the app still sends `/api/scrape/start` `{ searchUrls, sheetUrl, tabName, profileId,
slowMode }`. The engine never learns where the URLs came from.

## Approved scope

1. **Restyle section 2b** to the command-deck system (monochrome, hairlines, display-font
   block headers, clear bordered panels separating Input / Destination / Options). Tokens:
   `--ink --gray --hairline --hairline-soft --display`; gold stays only on the Start CTA.
2. **Dual input mode** — a segmented toggle:
   - **Type URLs** (today's textarea, one per line), or
   - **From a Sheet** — paste a Google Sheet URL whose cells hold Sales Nav search URLs;
     the app reads it (`fetchSheet`), extracts the search URLs, shows a live count, and
     dispatches them as the same `searchUrls`. No engine change.
3. **Destination tab** — keep "name the tab" (engine creates it by name), but reframe as a
   clear *create-a-new-tab* action with a sensible pre-filled default + helper copy, styled
   on-brand. **True dropdown of existing tabs is deferred** (needs Steven to expose a
   list-tabs endpoint on the engine — the only reliable reader of a service-account sheet).

## Non-goals

- No engine / VM / GKE changes. No new auth or Google API key.
- No change to the dispatch contract, pause/resume/stop, jobs/logs, or the Launch card.
- Off-limits files (`outreach.js`, `actions.js`) untouched (scrape never uses them).
- Tab dropdown not built this round (tracked as a Steven follow-up).

## Design

### Backend (testable)

- `extractSalesNavUrls(rows)` — pure helper (in `src/scraper-client.js`): scan every cell of
  the parsed sheet rows, collect values matching a Sales Nav **search** URL
  (`/linkedin\.com\/sales\/search\//i`), trim, dedupe, preserve order. Returns `string[]`.
- `GET /api/scrape/extract-urls?sheetUrl=…` (server.js): `fetchSheet(sheetUrl)` →
  `extractSalesNavUrls(rows)` → `{ urls, count }`, or `{ error }` (never throws; mirrors the
  scraper-client never-throw style).

### Frontend

- `index.html` #nav-scrape: restructured into 3 bordered panels — **Input** (segment +
  textarea OR sheet-url+preview), **Destination** (sheet URL + tab name w/ default), and an
  **Options** row (slow mode). Display-font mini-headers; hairline borders for contrast.
- `app.js`:
  - `scrapeInputMode` state (`'type'` | `'sheet'`); segment toggle swaps the two inputs.
  - `getScrapeInputUrls()` → from textarea (type mode) or from the cached extracted list
    (sheet mode, populated by a "Load URLs" action hitting `/api/scrape/extract-urls`).
  - Sheet mode shows `✓ Found N search URLs` (or an error) and feeds `startScrapeJob()`'s
    `urls` array — the dispatch loop is otherwise unchanged.
  - Pre-fill the tab-name default; helper copy clarifies "we'll create this tab".

## Test strategy

- Unit (`node --test`): `extractSalesNavUrls` — extracts search URLs, ignores non-sales-nav
  cells (profile URLs, names), dedupes, empty→[].
- Endpoint: covered by the helper + a thin route; manual smoke via curl.
- UI: manual verification (no UI harness) — operator confirms the restyle + both input modes.

## Files

- `src/scraper-client.js` — add `extractSalesNavUrls` (pure).
- `server.js` — add `/api/scrape/extract-urls`.
- `public/index.html` — restyle #nav-scrape + input segment + preview.
- `public/js/app.js` — input-mode state, extract+preview, dispatch wiring, tab default.
- `tests/scraper-extract-urls.test.js` — new.
