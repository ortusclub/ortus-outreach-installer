# Operator Quick-Wins — Batch 1 (Design)

**Date:** 2026-06-18
**Status:** Approved scope, pending user review of this spec
**Branch (proposed):** `operator-quickwins-1`

## Goal

Three small, low-risk operator improvements that ship together as one feature branch:

1. **#4 — Connection-note nudge:** a soft, conditional hint that discourages leaving an unnecessary connection note.
2. **#1 — Disable automatic checks:** a toggle that suppresses the *periodic* monitoring auto-checks so the operator runs them manually (the manual button already exists).
3. **#15 — Auto-update failure is legible:** surface the *actual* download/install error instead of a generic "Failed — retry", and persist/expose the install-helper log — so the next real failure can be root-caused.

Out of scope (deferred to the reliability batch): **#3 pause/resume live re-read** (overlaps #2 bench-accounts; touches the campaign loop + browser lifecycle near off-limits `outreach.js`).

## Architecture / approach

- Frontend is vanilla HTML/CSS/JS (`public/index.html`, `public/js/app.js`); no bundler. Backend is Express (`server.js`) + `src/campaign.js`. Tests are `node --test tests/*.test.js`.
- Per repo convention (CLAUDE.md: "Pure-helper unit tests preferred"), each item gets a **small pure helper** that is TDD-tested, plus **manual UI verification** for the DOM/wiring (there is no UI test harness).
- No changes to off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`). `bulkCheckConnections` is imported from `src/linkedin/bulk-check-connections.js` and is **only gated**, never edited.
- Bugatti design system for any new UI: monochrome, hairlines, muted helper text — **no new accent colors**, gold stays reserved for the Start CTA.

---

## Feature #4 — Connection-note nudge

### Current behavior
- `public/index.html` ~1269–1271: a "Connection Note (optional, max 300 chars)" section with `<textarea id="tpl-note" maxlength="300" oninput="updateTplNoteCount()">` and a counter `<div id="tpl-note-count">0 / 300</div>`.
- `public/js/app.js` `updateTplNoteCount()` (~1375) reads `#tpl-note` and updates the counter on every input.
- Config reads `connectionNote: document.getElementById('tpl-note').value` (app.js ~171).
- There is **no** guidance that a note is usually better left blank.

### Change
- Add a hint element under the textarea: `<div id="tpl-note-hint" class="note-hint hidden">…</div>`.
- Show it **only when the note box contains non-whitespace text**; hide it when empty.
- Copy (final wording in plan): *"Tip — a blank note usually lifts acceptance and keeps intro threads clean. Add one only if it clearly helps this audience."*
- Drive visibility from a **pure predicate** so it is unit-testable:
  - `shouldShowNoteHint(noteText) => boolean` (true when `noteText.trim().length > 0`).
  - `updateTplNoteCount()` calls it and toggles the `hidden` class on `#tpl-note-hint`.

### Files
- Modify: `public/index.html` (~1269–1271, add hint element).
- Modify: `public/js/app.js` (`updateTplNoteCount` ~1375; add `shouldShowNoteHint`).
- Test: `tests/note-hint.test.js` (pure `shouldShowNoteHint`).
- CSS: reuse a muted helper-text style; if none fits, add a `.note-hint` token-based rule (monochrome, small, `--ink-muted`).

### Testing
- Unit: `shouldShowNoteHint('')`/`'   '` → false; `'hi'` → true.
- Manual: type in the note box → hint appears; clear it → hint disappears; counter unaffected.

---

## Feature #1 — Disable automatic checks (run manually)

### Current behavior
- **Periodic monitoring auto-check:** `startMonitoringWatcher()` (campaign.js ~5049) sets a 60s `setInterval` → `tickMonitoringNow()` (~4972) → when `nextCheckAt` is overdue, `runMonitoringCheckAll()` (~5246) → `runMonitoringCheck()` (~5136) → `bulkCheckConnections()`.
- **Important:** in `connect_and_introduce` mode `runMonitoringCheck` also fires `runAutoIntros()`, and in `connect_and_message` it fires `runAutoDms()`. So the periodic check is **not read-only — it also sends** intro DMs / follow-ups. The toggle therefore doubles as a "pause automatic sends on the timer" control.
- **Manual check already exists:** UI button `#mon-check-now-btn` "⚡ Check now" (app.js ~9577) → `monitoringCheckNow()` (~9608) → `POST /api/monitoring/check-now` (server.js ~1274). This path is independent of the timer.
- **Preflight check** (campaign.js ~2442, once at start) is **unaffected** by this feature (user chose "periodic only").

### Change
- Add a persisted boolean `autoChecksEnabled` to the monitoring state slice (default **true** — preserves today's behavior; operators rely on auto-intros firing, so opt-out, not opt-in).
- Gate the auto-fire with a **pure predicate** so it is unit-testable:
  - `shouldAutoFireCheck({ autoChecksEnabled, nextCheckAt, now }) => boolean` — false when `autoChecksEnabled === false`; otherwise true when `now >= nextCheckAt`.
  - `tickMonitoringNow()` uses it; when it returns false the heartbeat keeps running (state/UI stay live) but no check/sends fire.
- New endpoint `POST /api/monitoring/auto-checks { enabled }` → sets the flag, persists it (same persistence path as `checkIntervalMinutes`), returns the new state.
- Expose the flag in `GET /api/monitoring/state` so the UI can reflect it on load.
- UI: a hairline on/off toggle in the monitoring panel **next to `#mon-check-now-btn`**, labelled e.g. "Automatic checks". When OFF, show a one-line hint: *"Auto-checks paused — use ⚡ Check now to run them (and fire any due intros/follow-ups)."*

### Files
- Modify: `src/campaign.js` (`tickMonitoringNow` ~4972; state init/persistence for `autoChecksEnabled`; add pure `shouldAutoFireCheck` — exported for tests).
- Modify: `server.js` (new `POST /api/monitoring/auto-checks`; include flag in `GET /api/monitoring/state` ~1300).
- Modify: `public/js/app.js` (render toggle in the monitoring panel ~9577; `setMonitoringAutoChecks(enabled)`; reflect state from `/api/monitoring/state`).
- Modify: `public/index.html` only if the toggle markup is static (likely rendered in app.js).
- Test: `tests/monitoring-auto-checks.test.js` (pure `shouldAutoFireCheck`).

### Testing
- Unit: enabled+overdue → true; enabled+not-overdue → false; **disabled+overdue → false**.
- Manual: toggle OFF → timer no longer fires checks/intros; "⚡ Check now" still works; toggle ON → auto-fire resumes; state survives an app restart.

### Error handling
- Endpoint validates `enabled` is boolean; persistence uses the existing atomic-write pattern. If no campaign is monitoring, the endpoint is a no-op returning current state.

---

## Feature #15 — Make auto-update failures legible (instrumentation)

> **Framing:** the release infra is healthy (v2.111.1 is `latest`, both DMGs present, arm64 has 16 downloads). The failure is on a colleague's machine and **cannot be root-caused without the real error** (systematic-debugging Phase 1). Today the error is *swallowed*: `onUpdateClick`'s `catch{}` discards it and the UI shows a generic "Failed — retry"; install-helper failures only reach `/tmp/ortus-update.log`, which operators never see. This feature **surfaces and persists the error** so the next failure is diagnosable. It does **not** claim to fix an unknown root cause.

### Current behavior
- Client: `onUpdateClick()` (app.js ~7778) → `POST /api/update-download` → polls `/api/update-progress` (`_pollDownloadProgress` ~7761, which already resolves `{ error }` but the UI **discards the text**) → `POST /api/update-install` (~7802). Both the poll-error branch and the outer `catch{}` collapse to `"Failed — retry"`.
- Server: `/api/update-download` (server.js ~309) records `_downloadState.error` on failure. `/api/update-install` (~363) writes a detached bash helper to `/tmp/ortus-update.sh` that logs every step (mount/copy/swap/relaunch and each failure branch) to `/tmp/ortus-update.log`; falls back to opening the DMG on any failure.

### Change
1. **Surface the download error (in-process, app stays alive):** in `_pollDownloadProgress`'s `{ error }` branch and the install branch, show the actual message in `#update-status-text` (e.g. `Update failed: download failed: HTTP 404`) and keep a "retry" affordance. Stop discarding `res.error`/caught `err.message`.
2. **Pure helper for the user-facing string:** `summarizeUpdateError({ downloadError, installError, fallback }) => string` — composes a short, specific message (download vs install vs "opened DMG for manual drag"). Unit-tested.
3. **Expose the install-helper log:** add `GET /api/update-log` returning `{ exists, mtimeMs, text }` from `/tmp/ortus-update.log` (the detached helper runs *after* the app quits during a swap, so the log is read on the **next launch**). In the "Failed" UI state, add a small **"Details"** affordance that fetches and shows the log text (read-only; copyable).
4. **One-time post-failure banner:** on app load, if `/api/update-log` shows a recent failure marker (a line containing `failed`/`mount failed`/`copy failed`/`swap failed`), surface a dismissible note: *"The last update attempt didn't complete — open Details."* (No auto-retry.)

### Files
- Modify: `public/js/app.js` (`onUpdateClick` ~7778, `_pollDownloadProgress` ~7761; add `summarizeUpdateError`; add Details fetch + post-failure banner).
- Modify: `server.js` (add `GET /api/update-log`; ensure `_downloadState.error` is returned verbatim by `/api/update-progress`, which it already is).
- Modify: `public/index.html` if a static "Details" element is needed near `#update-status`.
- Test: `tests/update-error-summary.test.js` (pure `summarizeUpdateError`).

### Testing
- Unit: download-only error → mentions download + HTTP code; install-only → mentions install; fallback → "opened the installer to drag to Applications"; none → empty.
- Manual: simulate a download failure (point the check at a bad URL in a dev build, or temporarily break connectivity) → UI shows the specific message; `/api/update-log` returns the helper log when one exists.

### Explicitly NOT in scope
- Silent self-update (requires code-signing + notarization — a separate project).
- Changing the download/install mechanism itself. We only make its failures visible. The actual fix follows once a real failure log is captured.

---

## Cross-cutting

- **Versioning:** patch-bump `package.json` before the post-commit `dev:app` relaunch (operator rule). Final version set in the plan.
- **Relaunch:** after each commit touching runtime code, kill+restart `npm run dev:app` so the change is verifiable (operator rule #2).
- **Tests:** `npm test` must stay green; new pure helpers each get a `tests/*.test.js`.
- **Design system:** any new UI uses existing tokens — monochrome, hairlines, no new accent colors.

## File-change summary

| File | #4 | #1 | #15 |
|---|---|---|---|
| `public/index.html` | hint element | (maybe) | (maybe Details el) |
| `public/js/app.js` | `updateTplNoteCount` + `shouldShowNoteHint` | monitoring toggle + `setMonitoringAutoChecks` | `onUpdateClick`/`_pollDownloadProgress` + `summarizeUpdateError` + Details/banner |
| `server.js` | — | `POST /api/monitoring/auto-checks`, state field | `GET /api/update-log` |
| `src/campaign.js` | — | `tickMonitoringNow` gate + `shouldAutoFireCheck` + persist | — |
| `tests/*.test.js` | `note-hint` | `monitoring-auto-checks` | `update-error-summary` |
