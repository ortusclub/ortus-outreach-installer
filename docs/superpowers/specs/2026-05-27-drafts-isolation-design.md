# Drafts Isolation — Design

**Date:** 2026-05-27
**Author:** Antonio + Claude
**Status:** Draft — awaiting review
**Branch:** `drafts-isolation-v2.60.1`

## Goal (verifiable)

Stop the wizard from losing in-progress work or creating duplicate drafts when the operator jumps between contexts (running campaign monitoring, queue, past, drafts list). After this lands: the operator can leave a half-edited draft, attend to anything else, and come back to find it exactly as they left it — with explicit visual confirmation of what they're editing at every moment.

## Background

The Ortus operator works in "occasional jumper" mode (confirmed in brainstorm 2026-05-27): mostly focused on one campaign at a time (configuring a new one, or monitoring the running one), but **jumps** away every so often to peek at the queue, check a past result, or tweak a draft for tomorrow. The current app forces jumps to overwrite the wizard form, which loses context. Symptoms:

- Save creates a duplicate draft instead of overwriting the one you were editing.
- Jumping from Draft A → Active monitoring → back to Draft A finds the form empty or filled with stale data.
- It's never clear which draft you're "in" — there's no visible context indicator.
- `currentDraftIsNew=1` localStorage flag desyncs from the actual wizard state.

**Root cause (acknowledged but not fixed in this spec):** the data model is fragmented across 5 stores (drafts, queue, running singleton, monitoring, history) — each with its own shape and write path. Properly unifying them is a multi-week refactor that touches `src/campaign.js` (off-limits-adjacent). This spec takes the cheaper path: **tighten the existing drafts system** so the symptoms stop biting.

## Workflow context

| Signal | Value |
|---|---|
| Session switching pattern | Occasionally — mostly one focus but jumps |
| Dominant activity | Monitoring running + configuring new (both equally) |
| Hard constraint | ONE campaign runs at a time (parallel crashes the app) |
| Operator | Antonio (sole operator on local Electron app) |

## Scope (what's in)

10 verifiable behaviors (all approved by user in brainstorm):

| # | Guarantee |
|---|---|
| 1 | Drafts auto-save on every keystroke. PATCH `/api/drafts/:id` debounced ~400-800ms. A "Saved Xs ago" pip is always visible while editing. |
| 2 | One draft id per wizard session, never reassigned mid-flow. Set when the wizard opens; every save targets it. |
| 3 | The wizard always shows the editing context — "Editing: <draft name>" (or "Editing: Untitled draft N · autosaved") pinned at the top of the wizard view. |
| 4 | Jumping away preserves state. Click into Active monitoring → come back → wizard form is exactly as you left it (fields, scroll position, expanded sections). |
| 5 | "Resume Draft <name>" chip in the dashboard header when an unfinished draft exists. One click brings you back. |
| 6 | Launching a draft (Add to queue) deletes the draft row. No orphan drafts after launch. |
| 7 | Multiple drafts coexist. Switching A → B in the drafts list correctly retargets autosave to B's id. |
| 8 | HARD GUARD: save-when-id-is-set CANNOT create a new draft. The "create new" path is triggered ONLY by an explicit "+ Start new campaign" click. |
| 9 | Close and reopen the app → picks up the most-recently-edited draft (or shows the resume chip in the dashboard). |
| 10 | Switching between wizard sections (Settings → Templates → Throughput) does NOT reset field state. |

## Scope (what's out — explicit guard)

- Side-by-side / pinned running-campaign panel
- Per-campaign URL routing (`#/campaign/<id>`)
- Unifying the 5 data stores into one Campaign object
- Visual breadcrumbs / browser-back navigation between contexts
- Past entries getting their own workspace
- Changes to the queue/history/monitoring data stores
- Changes to `src/campaign.js` or `src/linkedin/*` (off-limits)
- Visual changes to the dashboard (v0.3 work just landed; leave it alone)

## Surfaced assumptions

| # | Assumption | Confirmed by |
|---|---|---|
| 1 | The existing `/api/drafts` CRUD endpoints are sufficient (no new backend routes needed). | Research output — drafts.js has full CRUD + atomic .tmp+rename writes |
| 2 | `localStorage.currentDraftIsNew` is the primary desync source today; replacing it with a deterministic `localStorage.activeDraftId` string fixes most failures. | brainstorm |
| 3 | The autosave debounce can ride on existing `initWizardDirtyTracking()` input listeners (app.js:9084). | research |
| 4 | The "Resume Draft" chip can live in the dashboard header area, not require a layout change. | brainstorm — small-fix path |
| 5 | Section state preservation (guarantee #10) works automatically if the wizard form is never DOM-reset between section switches — only field VALUES need to come from the active draft. | code reading needed during plan |
| 6 | "Most-recently-edited draft" requires a `lastEditedAt` ISO timestamp on each draft row. May or may not exist today. | code reading needed during plan |
| 7 | Operator only has ONE wizard session open at a time (no multi-window Electron support). Multi-window would surface concurrency bugs out of scope here. | hard constraint |
| 8 | The "draft id never reassigned mid-flow" rule means: opening Draft B while Draft A is being autosaved should FINISH A's pending save (or cancel it), then switch the autosave target to B. | brainstorm |

## Architecture

### File-level diff (estimated)

| File | Change | Lines |
|---|---|---|
| `public/js/app.js` | Replace `currentDraftIsNew` flag with `activeDraftId` string. Refactor `startNewCampaign`, `saveCampaignEdits`, the wizard input listeners. Add `autosaveDraft(patch)`, `loadDraftIntoWizard(id)`, `clearActiveDraft()`. Add Resume-Draft chip render + click handler. | ~250 added, ~80 deleted |
| `public/index.html` | Add `<div id="wiz-editing-header">` chip area in the wizard layout. Add `<div id="resume-draft-chip">` in the dashboard header area. | ~10 added |
| `public/css/style.css` | Style `.wiz-editing-header` (pill with draft name + save pip) and `.resume-draft-chip` (dashboard header pill). | ~40 added |
| `src/drafts.js` | Add `lastEditedAt` ISO field on every write. Add `getMostRecentDraft()` helper. | ~15 added |
| `tests/drafts-isolation.test.js` | New — exercises the autosave + id-pinning + resume logic at the helper level. | ~120 added |

**Untouched (explicit):** `src/campaign.js`, `src/campaign-queue.js`, `src/history-helpers.js`, `src/linkedin/*`, the dashboard v0.3 markup/CSS/renderers, all polling timers, the right-pane, modals.

### Behavioral diff (today → after)

| Action | Today | After |
|---|---|---|
| Click "+ Start new campaign" | Creates draft via POST `/api/drafts`. Sets `currentDraftIsNew=1` localStorage flag. | Same POST. Sets `activeDraftId=<id>`. NO `currentDraftIsNew` flag at all. |
| Type in a wizard field | `wizardDirty=true`. No autosave until you hit Save. | Debounced PATCH `/api/drafts/<id>` ~400ms after typing stops. "Saved Xs ago" pip updates. |
| Click Save | Reads `currentDraftIsNew`; if `1`, creates a new draft via POST. Else updates existing. → DESYNC RISK | Removed. Replaced by autosave. Manual "Save" button becomes "Save & close wizard" (returns to dashboard). |
| Jump to Active monitoring | Wizard form may be wiped or preserved depending on routing. Unclear. | Wizard form DOM is preserved. `activeDraftId` stays in localStorage. Dashboard header shows "Resume Draft: <name>" chip. |
| Click "Resume Draft" chip | Doesn't exist. | Navigates `#/new`, loads draft into wizard form (already loaded if the DOM was preserved). |
| Click a different draft in the drafts list | Replaces form fields with draft B's values. `currentDraftIsNew` stays at `0`. | Flushes any pending PATCH for draft A, then sets `activeDraftId=B`, loads B's fields. Header updates to "Editing: B". |
| Launch (Add to queue) | Calls `/api/campaign/queue-only` with form data. Draft row sometimes survives. | Calls queue-only. Then DELETE `/api/drafts/<activeDraftId>`. Clears `activeDraftId`. |
| Close + reopen app | Re-opens at last route. Wizard form is empty or hydrates randomly. | Re-opens at last route. If `activeDraftId` in localStorage points to an existing draft, dashboard shows Resume chip. Wizard route auto-loads it. |
| Switch wizard sections (Settings → Templates) | Sections persist (already works). | Same. (Guarantee #10 — keep this working, don't regress.) |

### Why this works

The single source of truth becomes `localStorage.activeDraftId`:
- If set → wizard is editing that draft. All saves target it.
- If unset → wizard is in "new campaign" intake (rare; first action is "+ Start new campaign" which sets it).
- The `currentDraftIsNew` flag (which conflates "is this a new draft" with "should save create a row") goes away. Save just patches whatever `activeDraftId` points to.

The chain `activeDraftId → /api/drafts/:id → wizard form` is unidirectional and deterministic. No more save-creates-duplicate.

## Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Debounced autosave races with a manual launch (Add to queue) — launch reads form values that haven't autosaved yet. | High | Launch handler MUST flush pending autosave first (await it) before reading form values for queue-only POST. |
| 2 | Two wizard sections (Templates, Throughput) auto-save independently — interleaved PATCH races. | Medium | Single shared autosave timer + serialized PATCH calls; later PATCH cancels earlier pending one. |
| 3 | Existing code paths that read `currentDraftIsNew` (5+ callsites per grep) break when the flag is removed. | High | Grep every callsite. Each one becomes "does `activeDraftId` exist?" or "is this the first interaction in this session?". Audit before deleting. |
| 4 | `saveCampaignEdits` is called from several places (auto-flush, manual Save button, section navigation). Each path must use the same code. | Medium | Consolidate into one `autosaveDraft(patch)` function. All callers route through it. |
| 5 | The resume-chip's "navigate to wizard" interaction conflicts with dashboard's Open-Active button (also navigates to wizard). | Low | The chip is its own affordance; clicking it specifically loads the draft. Open-Active loads the running campaign. They use different paths into the wizard. |
| 6 | `lastEditedAt` requires backfilling existing drafts on first read. | Low | On first GET, if a draft lacks `lastEditedAt`, use its `createdAt` (or `Date.now()`). Write-back at next PATCH. |
| 7 | The autosave debounce could mask "I wasn't sure if it saved" anxiety — user wants to know it saved. | Low | "Saved Xs ago" pip is always visible. Also: when the user clicks away or closes the wizard, FORCE-flush the debounce so they don't lose state. |
| 8 | If two operators open the same draft on different machines (cloud sync future), last-writer-wins silently overwrites. | N/A | Hard constraint: ONE operator on local Electron. Multi-user is out of scope. |

## Verification plan

Each guarantee gets a binary check:

| # | Check |
|---|---|
| 1 | Type in any field → wait 1s → pip shows "Saved 1s ago". Network tab shows PATCH `/api/drafts/<id>`. |
| 2 | Open wizard fresh → note draft id from header. Type in Name field, then in Sheet URL field, then in Daily Limit. → All 3 PATCHes target the SAME id. |
| 3 | Header shows "Editing: <name>" whenever wizard is open. Updates live when you edit the name field. |
| 4 | Type "ABC" in Name. Navigate to `#/`. Confirm dashboard renders. Navigate back to `#/new`. → Name field still shows "ABC". |
| 5 | After step 4, when on `#/`, the dashboard header shows "Resume Draft: ABC". Click it → navigates to `#/new` with the same form. |
| 6 | In wizard, click "Add to queue". → POST `/api/campaign/queue-only` + DELETE `/api/drafts/<id>`. `activeDraftId` localStorage key removed. Drafts list (if visible) no longer contains that entry. |
| 7 | Set up Draft A. Open drafts list (sidebar). Click Draft B. → Form switches to B's values. Header shows "Editing: B". Type in B's Name field. → PATCH targets B, not A. Switch back to A → A's values restored. |
| 8 | Set `activeDraftId=<existing-id>` in localStorage. Type in any field. → PATCH `/api/drafts/<id>` (NOT POST). Drafts list count stays the same. |
| 9 | Type "XYZ" in Name. Close app via Cmd+Q. Reopen app. → Dashboard shows "Resume Draft: XYZ" chip. Click it → form has "XYZ". |
| 10 | Open wizard. In Section IV (Throughput), set Daily Limit = 25. Scroll to Section V (Templates). Edit a template. Scroll back to Section IV. → Daily Limit still shows 25. |

### Regression checks

- All v0.3 dashboard functionality (every wired button in the dashboard) must still work.
- Existing wizard launch flow (Add to queue) must still launch campaigns correctly.
- Running campaign must continue to render in dashboard Active card.
- Polling cadences (2s, 5s) must be unchanged.

## Implementation phases (preview, full plan in separate doc)

| Phase | Scope | Files | Parallel-safe with |
|---|---|---|---|
| 1 | Backend nit: `lastEditedAt` on drafts | `src/drafts.js`, tests | All later phases |
| 2 | Wizard refactor: `activeDraftId` + debounced autosave | `public/js/app.js`, `public/index.html` for new header chip | None — biggest surgery |
| 3 | Dashboard header: Resume-Draft chip + click handler | `public/index.html`, `public/js/app.js` | After Phase 2 |
| 4 | Styles for header chip + resume chip | `public/css/style.css` | After Phase 3 markup lands |
| 5 | Manual verification | none | Final gate |

Phase 1 is small + isolated; can ship first. Phase 2 is the biggest — needs care because `currentDraftIsNew` is referenced in 5+ places.

## Out-of-band: future work

- Unifying the 5 data stores into one Campaign noun (the architectural fix)
- Side-by-side workspace (running campaign always visible)
- Per-campaign URL routing
- Multi-window support
- Cloud sync / multi-operator drafts

## Open questions

(None remaining — all resolved in brainstorm. Spec is ready for plan.)

---

**Status:** Spec drafted 2026-05-27. Awaiting Antonio's review. Once approved → write executable plan to `docs/superpowers/plans/2026-05-27-drafts-isolation-plan.md` → execute via `subagent-driven-development`.
