# Expanded Dashboard Strip → Card #2 Visual Parity

**Date:** 2026-07-11
**Status:** Design — awaiting user review

## Goal

When a dashboard board strip (card #1, `renderUnifiedStrip` → `.sn-strip`) is
**expanded** via its arrow toggle, its body must look **exactly like card #2**
(the campaign-tab live-status card, `#active-card` / `.vj-card`): the
`● MONITORING` eyebrow, the live-activity box ("Waiting for next check…"), the
`LIVE LOG · LAST N EVENTS` with green **OK** / red **ERR** rows, the
**BULK CHECK CONNECTION** block with the big **RUN CHECK NOW** button, the big
countdown, and card #2's own control dock (Open / ⏸ / ⏹ / ↻ / ⧉).

The **collapsed** strip is unchanged — it must stay uniform with every other
strip on the board. The rich look applies to the **expanded** state only, to
**all** strips (running local + VM, monitoring, done, queued), local and cloud.

## Non-goals

- No change to the `#active-card` singleton or `renderActiveCard`. Zero
  regression risk to the campaign-tab card. (User decision: "safe template.")
- No new visual design — the look comes entirely from the existing `.vj-card`
  / `.vj-details` / `.vj-bulk` CSS. This feature adds no new colours or tokens.
- No engine changes. Cloud data already arrives on the board item (`it`).

## Architecture (safe template)

Three new pieces in `public/js/app.js`; `renderActiveCard` stays untouched.

1. **`vjCardSkeleton(cid)`** — returns an HTML string that is the SAME markup as
   the `#active-card` skeleton in `index.html`, with every `id="activeX"`
   replaced by `data-f="activeX"` (scoped, non-global) and wrapped in
   `<div class="vj-card sn-vjcard" data-cid="…">`. Reuses all existing
   `.vj-*` classes → pixel-identical by construction. One hand-copy of the
   skeleton; this is the accepted drift cost.

2. **`fillVjCard(root, status)`** — the scoped twin of `renderActiveCard`'s
   field-fill: queries `root.querySelector('[data-f="…"]')` instead of
   `document.getElementById`, toggles `is-monitor` / `is-detailed` /
   `is-preflight` on `root`, fills name/%/sent/accepted/log rows/countdown/
   bulk-status, and wires the control dock via `wireVjCardControls(root, status)`.
   Expanded strips are ALWAYS `.is-detailed` (expanding = show details).

3. **`statusFromItem(it)`** — maps a board item (`it` from `renderUnifiedStrip`)
   to the status shape `fillVjCard` consumes. Cloud reuses the existing
   `_buildCloudActiveStatus`-style mapping (already carries
   monitoring/nextCheckAt/monitoringUntil/logs/counts). Local reuses the live
   status where available; missing fields degrade gracefully (see below).

**Board integration:** in `renderUnifiedStrip`, when `!collapsed`, the body
becomes `vjCardSkeleton(it.id)` in place of the current `switchBlock` + `monBlock`,
and `.sn-foot` is omitted (card #2's own dock wins — user decision). After each
board render, a pass walks `#sn-board .sn-strip:not(.sn-collapsed) .sn-vjcard`
and calls `fillVjCard(el, statusFromItem(item))`. Collapsed strips render exactly
as today (unchanged code path).

**Live countdown:** one shared 1s ticker (`_vjCardTick`) updates every visible
`.sn-vjcard [data-f="monCount"]` (and the fu/batch counters) by `data-cid`,
started when ≥1 rich strip is open, stopped when none. The board's 5s poll keeps
data fresh; the 1s ticker only re-renders the MM:SS text (no full re-render).

**Graceful degradation** (done/queued strips — "all strips" scope):
- Done: `is-detailed` shows the final log tail; no `is-monitor`, countdown
  hidden; BULK CHECK block hidden (nothing pending); dock = Duplicate / Debrief
  / Dismiss / Open (mirror today's done footer, in card #2's dock style).
- Queued: minimal — name + flow + "Queued/Scheduled" state; no log/bulk/countdown;
  dock = Cancel / Open (Reschedule for scheduled). (Queued strips are collapsed
  by default today; expansion is rare but must not error.)

## Control-wiring matrix

Every dock/bulk button in an expanded strip targets THAT strip's campaign by
`id`, routed local vs cloud. Local "active-campaign" globals are valid because
Ortus runs ONE local campaign at a time (the running local campaign IS the
active one).

| State | Open | Pause | Stop | Run check now | Extra |
|---|---|---|---|---|---|
| Running **local** | `viewRunningCampaign()` | `dashPauseActive()` | `dashStopActive()` | `dashRunCheck()` | Restart/Copy per today's card #2 |
| Running **cloud** | `openCloudLive(id)` | hidden (no cloud resume) | `stopCloudCampaignUI(id)` | hidden (not monitoring) | 👁 Show → `openCloudCampaignView(id,label)` |
| Monitoring **local** | `viewRunningCampaign()` | per card #2 | `dashStopActive()` | `dashRunCheck()` | — |
| Monitoring **cloud** | `openCloudLive(id)` | hidden | `stopCloudCampaignUI(id)` | `cloudCheckNow(id,btn)` | Auto toggle → `setCloudAutoChecks(id,checked,el)` |
| Done (local/cloud) | `viewRunningCampaign()` / `openCloudLive(id)` | — | — | hidden | Duplicate `duplicateCampaign(id)` · Debrief (local hist) · Dismiss |
| Queued (local/cloud) | edit/`viewCloudCampaign(id)` | — | — | hidden | Cancel / Reschedule |

All of these functions already exist and are already called by today's
`renderUnifiedStrip` footer or by `_adaptActiveCardControls` — this feature only
relocates them into the rich card's dock, scoped by `id`.

## Testing

- **Pure unit (`node --test`):** `statusFromItem(it)` — assert local/cloud items
  map to the right `where`/`state`/counts/monitoring fields; `vjCardControlsFor
  (status)` (a pure helper returning the button set + onclick strings per the
  matrix) — assert each row of the matrix. Keeps the wiring correct without a
  browser.
- **Manual / CDP:** expand a running-cloud, a monitoring-cloud, a running-local,
  and a done strip; verify pixel parity with `#active-card`, working Run-check-now,
  live countdown ticking, and that collapsed strips are unchanged. Verify the
  `#active-card` singleton in the campaign tab is byte-identical to before
  (untouched).

## Risks

- **Drift:** two renderers (`fillVjCard` vs `renderActiveCard`) feed one CSS.
  Mitigated by sharing the CSS as the single visual source and keeping
  `fillVjCard` a direct scoped mirror. Accepted by user.
- **Perf:** N open rich strips = N filled cards + one shared ticker. Board
  already re-renders every 5s; the ticker only rewrites countdown text. Expected
  N is small (operators expand one or two).
- **Missing local fields:** the board item is a summary; some rich fields
  (batch ETA, per-account rows) may be absent for local. Degrade to "—" rather
  than erroring.
