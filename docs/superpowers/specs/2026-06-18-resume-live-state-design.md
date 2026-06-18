# Sub-project A — "Resume picks up live state" — Design

> Reliability batch, item A. Unifies backlog #3 (pause/resume re-reads live state),
> #2b (add/swap a fresh account mid-campaign), #2c (benched state survives restart),
> and a systematic-debugging track for #2a (benching is unreliable).
> Backlog: `docs/superpowers/backlog/2026-06-18-suggestions.md`.

**Date:** 2026-06-18
**Status:** Approved for planning
**Off-limits (do NOT touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`.

---

## Problem

**What already works today (v2.86.15 "edit-while-paused"):** when paused, the operator can
already edit campaign **settings** in place — message/intro templates (`setLiveTemplates`,
`campaign.js:1597`), daily send limit (`setLiveDailyLimit`, `1618`), and check cadence
(`setLiveCadence`, `1631`) — via the `#pause-edit-panel` UI (`index.html:1562`,
`app.js:4662–4695`). All three require `campaign._paused`, mutate the live config in place,
and take effect on Resume. Benching an account mid-run also exists (`setProfileSkip`, `4511`).

**What does NOT work — the gaps this sub-project closes.** A running campaign still freezes
the lead list (`targets`, filtered once at `campaign.js:2031`) and the account set
(`profileQueue = [...profileIds]`, `campaign.js:2708`). So an operator who, mid-campaign:

- adds new leads to the sheet, or edits a pending lead's column values → **not picked up** (#3);
- wants to add a fresh GoLogin account (e.g. to replace a parked one) → **can't, without stop→restart** (#2b);
- benches an account → it keeps sending for up to `BATCH_SIZE` (8) more leads, and the
  benched/added state is **lost on an app restart** (#2a + #2c);
- makes several paused edits at once → there is **no single "here's everything that will
  change" review before Resume** — edits apply piecemeal with separate Save buttons.

## Goal

When paused, let the operator explicitly reload the sheet and edit the account set, then
**review a summary of exactly what will change before resuming**. Every value in that
summary is computed from real re-read state, and Confirm applies that same computed change
to the running campaign. Plus: benched/added accounts survive a restart, and benching takes
effect within one lead.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Re-read model | **C — explicit edits while paused + a "review before resume" summary**, applied on Confirm. No pending changes → Resume resumes directly, no summary. |
| Sheet scope (v1) | **Reload the SAME sheet.** Pick up newly-added lead rows + edits to still-pending rows' column values (the per-lead personalization variables, e.g. first-name / title / custom columns). Lead identity = the LinkedIn-URL column. Already-sent leads are never re-contacted. |
| Settings scope (v1) | **Settings group IS in v1.** It reflects the changes the *existing* paused live-editors already make: message/intro templates (`setLiveTemplates`), daily limit (`setLiveDailyLimit`), and cadence (`setLiveCadence`). These are real, paused-only, take-effect-on-Resume values — so the review summary diffs them honestly (snapshot at pause vs current at confirm). We are NOT building new settings editors; we surface what those existing editors changed. (Sheet variables = per-lead column values from the reloaded rows, separate from these settings.) |
| Repointing URL/column | **OUT of v1** (deferred — different sheet = different lead universe, unsafe to merge progress). |
| Review summary surface | **Inline expanding panel on the live campaign card** — NOT a modal/dialog (respects the command-deck design system; avoids browser-dialog pitfalls). |
| Build order | (1) sheet-reload + review panel → (2) #2c persistence → (3) #2a bench fix → (4) add/swap fresh account. Riskiest last; each phase is a stopping point. |

## Hard requirements (non-negotiable — the operator flagged this explicitly)

1. **Real style.** All new paused controls and the review panel use the actual
   command-deck CSS in `public/css/style.css` (existing tokens + component classes). They
   render inside the real live campaign card in `public/js/app.js`. No bespoke/inline
   mockup styling that diverges from the app.
2. **Wired to real state — zero invented data.** Every number and line in the review
   summary is *computed* from the actual re-read: new-lead count from diffing the
   re-fetched sheet against in-memory progress; cadence/template/primary changes from the
   real config; added/swapped accounts are the real GoLogin profiles selected. A value that
   cannot be computed is not shown. (Matches the standing "no invented data in mockups" rule.)
3. **Actions do real work.** `⟳ Reload` actually re-fetches the sheet; `＋ Add account`
   actually launches that GoLogin browser and puts it in rotation; `Confirm & Resume`
   actually applies the diff to the running campaign. The preview and the apply step share
   the same diff computation, so the preview cannot drift from what is applied.

### Don't do

- No hardcoded counts or graphic-only buttons.
- No modal/alert/confirm dialogs (inline panel only).
- No repointing the sheet URL/column in v1.
- No changes to `outreach.js` / `actions.js`.
- No editing leads from a different sheet.
- No auto-bench-on-passover/limit (that is a separate backlog item, not this sub-project).

---

## Architecture

### Safe-boundary principle
Paused edits never mutate the loop mid-turn. The loop parks in `awaitUnpause()`
(`campaign.js:4684`) at the top of each profile turn. Staged edits are **applied at that
boundary** — when `Confirm & Resume` fires, the staging is applied and then the pause flags
clear, so the next loop iteration sees the new `targets`/`profileQueue`. This mirrors the
existing `campaign._unparkProfile` side-channel pattern (`campaign.js:2662`).

### Components

**1. Pure diff helpers (new, unit-tested) — single source of truth.**

`src/resume-diff.js`:
- `computeSheetDiff(prevTargets, newTargets, { linkedinColumn })` → `{ added: [rows],
  updatedPending: [rows], addedCount, updatedCount, newTotal }`. Identity = normalized
  LinkedIn URL (reuse `extractLinkedInUrl`-equivalent logic, kept pure). `added` = URLs in
  `newTargets` not in `prevTargets`. `updatedPending` = same URL, changed cell values.
  Already-sent leads are excluded upstream by the existing filter, so they never appear.
- `computeAccountDiff(prevAccountSet, nextAccountSet)` → `{ added, removed, benched,
  reEnabled }` (arrays of `{ id, name }`).
- `computeSettingsDiff(pauseSnapshot, current)` → ordered list of changed settings, sourced
  from the values the existing paused editors already mutate: `dailyLimit`
  (`{ from, to }`), `checkIntervalMinutes` (`{ from, to }`), and a boolean "templates/intro
  text changed" (deep-equal compare of the templates object). No new editors — this only
  *reads* `campaign.dailyLimit` / `campaign.checkIntervalMinutes` / `campaign.templates`
  versus a snapshot taken at pause time.
- `summarizeResumeChanges({ sheetDiff, accountDiff, settingsDiff })` → the `resumeChanges`
  object the API returns and the UI renders. `isEmpty` flag is true when nothing changed.

These functions take plain data and return plain data — no I/O, no DOM. The server computes
`resumeChanges` and returns it; the client renders it; Confirm applies from the same staged
data. Frontend never recomputes counts.

**2. Backend mechanism — `src/campaign.js` (loop side-channels + staging).**

A staging object lives on the campaign while paused:
```
campaign._pendingResume = {
  reloadSheet: false,          // operator pressed ⟳ Reload
  newRows: null,               // the re-fetched + re-filtered rows (set by reload)
  addProfiles: [],             // [{ id, name }] fresh accounts to launch
  benchToggles: {},            // { profileId: true|false } staged bench/un-bench
  // (swap = benchToggles[old]=true + addProfiles.push(new))
}
```
Side-channel closures exposed from inside `startCampaign` (alongside `_unparkProfile`):
- `campaign._addProfile(id, name)` → push to `profileIds`, `profileNames`, and
  `profileQueue` (`campaign.js:2708`); the worker opens its browser on its next turn.
- `campaign._reloadTargets(newRows)` → re-run the SAME `rows.filter(...)` predicate used at
  `campaign.js:2031`, then merge: append still-pending rows whose URL is not already in
  `targets`; update in place the row object for still-pending URLs already present (so
  variable edits are honored); never remove or re-add sent leads. Recompute
  `campaign.totalTargets`. **`targets` must become a stable mutable array** the loop reads
  by reference (it already reads `targets.length` / `targets[leadIndex]`); mutate in place,
  do not reassign.
- `campaign._applyPendingResume()` → at the pause boundary: if `reloadSheet`, call
  `_reloadTargets(newRows)`; for each `addProfiles`, call `_addProfile`; for each
  `benchToggles`, call `setProfileSkip(id, skip)`. Then clear `_pendingResume`.

`resumeCampaign()` gains an internal path: when called via Confirm, run
`_applyPendingResume()` BEFORE clearing the pause flags.

**Pause-time snapshot (for the Settings diff).** `pauseCampaign()` records
`campaign._pauseSnapshot = { dailyLimit, checkIntervalMinutes, templates: <deep copy> }` at
the moment of pause. The existing paused editors (`setLiveTemplates` / `setLiveDailyLimit` /
`setLiveCadence`) already mutate the live values; `computeSettingsDiff(_pauseSnapshot,
campaign)` reports what changed. Cleared on resume. This is read-only over existing state —
no change to those editors' behavior.

**3. Server endpoints — `server.js` (all require `campaign.running` && paused → 409 otherwise).**

- `POST /api/campaign/resume/reload-sheet` → re-fetch via `fetchSheetRows(campaign.sheetUrl)`,
  re-filter, stage `newRows`, compute + return `resumeChanges`. Fetch failure → `{ ok:false,
  error }`, leave staging untouched.
- `POST /api/campaign/resume/accounts` `{ add?: [{id}], bench?: {id:bool} }` → validate every
  `id` against the live GoLogin profile list (reuse the `/api/gologin/profiles` source);
  reject unknown/duplicate IDs (400). Stage and return updated `resumeChanges`.
- `GET /api/campaign/resume/preview` → return current `resumeChanges` (recomputed from
  staging + a fresh diff so it reflects the latest sheet).
- `POST /api/campaign/resume/confirm` → call `resumeCampaign({ applyPending: true })`,
  return the applied summary. If nothing staged, behaves like a plain resume.
- Existing `POST /api/campaign/pause` unchanged.

**4. Frontend — `public/js/app.js` + `public/index.html` + `public/css/style.css`.**

- When the live card is paused, render explicit controls (real CSS): `⟳ Reload from sheet`,
  and an account editor row per account (Active/Benched toggle reusing the existing
  `bench-btn`, a `Swap…` action, and `＋ Add account` populated from the available-now
  profile list). These call the staging endpoints.
- The existing `#pause-edit-panel` (daily limit / cadence / templates) stays as-is — its
  edits feed the Settings diff automatically via the pause-time snapshot.
- `Resume…` → `GET preview`; if `resumeChanges.isEmpty`, resume immediately
  (`POST confirm`). Otherwise expand an **inline review panel** on the card rendering the
  three groups (Sheet / Accounts / Settings) from `resumeChanges`, with `Keep editing` and
  `Confirm & Resume`. Confirm → `POST confirm`, collapse panel, card returns to running.
- No invented values: the panel iterates the server object; if a group is empty it is hidden.

**5. #2c — benched/added state survives restart.**

- Add `benchedProfileIds` to the `_lastRunSettings` snapshot (`campaign.js:1653`).
- Whenever bench state or the account set changes (via `setProfileSkip`, `_addProfile`, or
  `_applyPendingResume`), refresh the snapshot's `profileIds`/`profileNames`/
  `benchedProfileIds` and `writeLastRun(LAST_RUN_FILE, _lastRunSettings)` (best-effort, the
  existing atomic write at `campaign.js:1664`).
- `restoreCampaign()` (`campaign.js:4614`) already re-launches from `_lastRunSettings`;
  `startCampaign` already seeds `_skippedProfiles` from `benchedProfileIds`
  (`campaign.js:1681`). So restore now brings back both the added accounts (in
  `profileIds`) and the benched set. No change to monitoring-persistence (`MONITORING_FIELDS`)
  — this rides the existing last-run snapshot path.

**6. #2a — "benching is unreliable" (systematic-debugging track).**

Observed symptoms (operator): "benched, kept sending", "re-enabled, didn't return",
"intermittent/not sure". Leading hypotheses from reading the code (to **confirm with a
reproduction before any fix**):

- **H1 (benched, kept sending):** the inner per-turn loop (`while (leadIndex <
  targets.length)`, `campaign.js:2893`, up to `BATCH_SIZE`=8 leads) re-checks `_abort`,
  `_pauseRequested`, `weeklyLimited` (e.g. `campaign.js:3819`) but **not**
  `campaign._skippedProfiles`. So a mid-turn bench keeps sending until the turn ends and the
  next `pickNextProfile()` (`campaign.js:2732`) finally excludes it.
- **H2 (re-enabled, didn't return):** benching the last active account can make
  `noProfilesLeftEver()` true → workers `break` (`campaign.js:3966`) → the loop ends, so
  un-benching has no live loop to rejoin. Or the profile drained from `profileQueue` while
  benched and is not re-enqueued.

Approach (TDD + systematic-debugging):
1. Extract the per-turn "should this profile keep going" gate into a pure helper so H1 is
   unit-testable; write a failing test for "bench mid-turn stops within one lead".
2. Add a `_skippedProfiles` re-check at the top of the inner loop → benching takes effect
   within one lead (next iteration), not 8.
3. For H2: confirm whether un-bench re-enters rotation; if not, ensure the loop stays alive
   while any benched (re-enableable) account exists and that un-bench re-enqueues. Write a
   test reproducing the drained-queue case.
4. Add targeted logging at bench/un-bench/pick decisions so the intermittent case is
   captured next time (the evidence path, mirroring how #15 was instrumented).
5. **No fix lands without a confirmed reproduction.** If a symptom can't be reproduced, ship
   the logging and stop there for that symptom.

---

## Preserves existing behavior (no silent removals — verified against code)

This sub-project is **additive**. Implementers MUST NOT remove or repurpose any of the
following; they are kept intact:

- **Plain resume path.** `resumeCampaign()` keeps working with no args (callers:
  `server.js:1479`, `2183`, `2344`). The new param is `resumeCampaign({ applyPending=false })`
  — default false = today's exact behavior. The existing `POST /api/campaign/resume`
  endpoint stays; the review flow is a NEW `/api/campaign/resume/confirm` endpoint.
- **Edit-while-paused panel.** `#pause-edit-panel` and its three live editors
  (`setLiveTemplates`/`setLiveDailyLimit`/`setLiveCadence`, `app.js:4676–4695`) stay exactly
  as-is. They additionally feed the Settings diff via the pause-time snapshot — no change to
  how they apply.
- **Wizard bench UI** (`bench-btn` / `toggleBenchProfile`, `app.js:1072/1088`) and the
  **monitoring card** (`renderMonitoringCard`, incl. the `mon-auto-checks` toggle from the
  prior batch, `app.js:9576/9633`) — untouched.
- **Existing mid-run bench** (`setProfileSkip`, `campaign.js:4511`) is extended (staging +
  persistence), never replaced.
- **Restore / monitoring-persistence** paths are ridden as-is; `MONITORING_FIELDS` unchanged.
- **Off-limits** `src/linkedin/outreach.js` / `actions.js` — not modified.

Deliberate changes to existing behavior, each tied to a stated ask (and nothing beyond them):
the Resume button routes through preview→confirm (no staged changes → immediate resume, as
today); the inner loop gains a `_skippedProfiles` re-check (#2a); `targets` becomes
mutable-in-place (no behavior change; enables #3 reload); `_lastRunSettings` gains
`benchedProfileIds` (#2c).

## Error handling

| Case | Behavior |
|---|---|
| Sheet re-fetch fails on Reload | Error shown in the panel/control; current `targets` kept; resume not blocked. |
| Added account's browser fails to launch on its turn | Auto-bench that account + log the reason; the rest of the campaign resumes normally (one bad account never blocks the run). |
| Confirm after the sheet changed again | `preview`/`confirm` recompute the diff against a fresh fetch; the latest state is applied. |
| Resume pressed with nothing staged | Plain resume (no panel). |
| Unknown/duplicate profile id in accounts staging | 400, surfaced inline; nothing staged. |

## Testing

- **Pure helpers** (`tests/resume-diff.test.js`, `node:test`): sheet diff by URL identity
  (added / updated-pending / sent-excluded), account diff, settings diff (dailyLimit /
  cadence `{from,to}` + templates-changed bool), `isEmpty`.
- **#2a gate** (`tests/*-bench-gate.test.js`): the extracted per-turn gate stops a
  mid-turn benched profile within one lead; drained-queue un-bench path.
- **Manual browser verification** for the paused UI + review panel (no UI test suite, per
  CLAUDE.md). Reload with `npm run dev:app` (Cmd+R).
- Full suite (`npm test`) green before merge; off-limits files unchanged.

## Done looks like

Pause a running CC+IC campaign. Add a lead to the sheet, edit a pending lead's title column,
bench one account, add a fresh account, and bump the cadence in the existing pause-edit
panel. Press Resume → the inline panel shows the **real** changes (e.g. "+1 new lead, 1 lead
updated · 1 benched, +1 added · cadence 60→45m"). Confirm → the new lead gets processed, the
edited lead uses its new variable values, the benched account stops within one lead, the
fresh account launches and joins rotation, and the new cadence is live. Restart the app
mid-run → the benched + added accounts are restored. No invented numbers anywhere; all
styling is the real command deck.
