# v2.140 fixes + warm-up rework — design

**Date:** 2026-07-09
**Version target:** patch bump from 2.141.0 (proposed 2.142.0)
**Source:** operator (Antonio) testing feedback on v2.140, two screenshots (launch section BLOCKED + empty Live Status; overlapping pre-flight buttons).

This spec bundles three defects surfaced in one testing pass plus a warm-up entry-point
rework, because the warm-up redesign and one of the bugs share a root cause.

---

## Scope

| # | Item | Type | Root cause (code trace) |
|---|------|------|--------------------------|
| ① | Warm-up can't be turned back off | bug + redesign | "Stop warm-up" link only renders in the `_state.state === 'free' && !_locked` tile branch (`app.js:1760`); once the account is selected/In-Use/Assigned the tile leaves `free` and the Stop affordance disappears. Server disable works. |
| ② | Live Status card empty on a local/native run | bug | Route-check mismatch: `syncLiveStatusVisibility()` gates on `location.hash === '#/new'` (`app.js:8678`) while `placeLiveCard()` relocates `#active-card` into `#wiz-live-slot` only when `document.body.classList.contains('route-wizard')` (`app.js:8717`). When they disagree the header shows but the card is never moved in. |
| ③ | Pre-flight action buttons overlap | bug (CSS) | `.pf-actions` (`style.css:7822`) is `flex-wrap` with a `flex:1` spacer + a long "Keep flagged, launch anyway (blocklisted still excluded)" label + a primary button; under the 760px panel the wrap/spacer math collapses buttons onto each other. Labels are already correct. |
| ④ | Warm-up entry point unclear + not SoO-linked | redesign | Warm-up lives only in a local per-machine file and its affordance is a low-contrast in-tile text link. |

Out of scope (noted, not built here): the **"BLOCKED" chip by "6. LAUNCH"** (`app.js:11003`)
is a *separate* mechanism — it fires whenever a prior wizard step isn't marked done, unrelated
to blocklisted leads. Flagged for a later look only.

---

## ① + ④ Warm-up rework (merged)

The revert bug and the redesign are one change: the fix is to move warm-up onto an
**in-tile on/off toggle that renders in every tile state**, so the Stop control can never
be stranded.

### Behaviour

- **Control:** each account tile carries a warm-up toggle in its sub-line, rendered
  regardless of `free / assigned / in-use` state (currently gated to `free` only). A
  restricted/`blocked` tile — which is never selectable — does not show it.
- **States shown on the toggle:**
  - not warming → `Warm up?` affordance (or, when SoO-suggested, a highlighted `Warm up?` prompt — see below)
  - warming → `◉ Warm-up ON · wk N · cap/day` with the WARM-UP stat badge (unchanged badge)
  - complete → `✓ warm-up complete` (badge stays green), toggle still present to clear it
- **Reversibility:** clicking the toggle while ON calls `setProfileWarmup(id, false)` (already
  correct server-side) and the tile immediately returns to the `Warm up?` state — from ANY
  tile state. This is the whole bug fix.
- **Explainer:** a `?` next to the toggle reveals the inline ramp explainer
  (`wk1 5/day · wk2 10/day · wk3 20/day · then normal`, cap only ever *lowers* the campaign
  limit, this account only). Copy already exists in `renderWarmupSched()` — reuse verbatim.

### SoO suggestion (operator-confirmed, tolerant of a not-yet-existing column)

- A **future** SoO column (working name **"Immature"** — final name TBD by operator) will mark
  new/immature accounts. The app reads it the same absence-tolerant way it reads every other
  SoO column (`soo['Immature']`, undefined when the column doesn't exist).
- When the column is present AND flags an account AND warm-up is not already armed for it, the
  tile's toggle renders as a **highlighted suggestion** (`Warm up? — flagged new in SoO`).
- **Operator confirms** — the suggestion never auto-arms. Accepting = the normal toggle-on.
- When the column is absent (today), behaviour is exactly as it is now: manual `Warm up?` only.
- The flag→app read is one-way for now (suggest only). SoO write-back of warm-up state is
  explicitly deferred until the column exists and a name is fixed.

### Visual direction

Variant **B** from `public/sketches/warmup-entry-variants.html` (in-tile toggle). The pill
(A) and drawer (C) are not built. Toggle styling reuses the sketch's `.wu-toggle` on the real
`--gold` warm-up accent; no new palette.

### Unchanged

`src/warmup.js` (schedule math), `src/warmup-store.js` (persistence), the `/api/warmup`
routes, and `wuStatus()` all stay as-is — they are already correct. Only the tile render
branch in `renderProfiles()` and its listener wiring change.

---

## ② Live Status empty on local run

Single source of truth for "are we on the wizard route". Make `placeLiveCard()` and
`syncLiveStatusVisibility()` agree.

- Introduce/one helper `onWizardRoute()` returning a single boolean, used by BOTH functions,
  so the section-visible test and the card-relocation test can never diverge.
- Chosen definition must be the one that is true during a live local run on the New Campaign
  view. Confirm during build which of `location.hash === '#/new'` vs `body.route-wizard` is
  actually set for a native run (screenshot shows the section header visible → `show` was
  true → the `hash` test passed → it's `body.route-wizard` that was missing/lagging). The fix
  is to relocate the card whenever the section is visible, i.e. gate `placeLiveCard()`'s
  `wantWizard` on the section's own visibility rather than a second route signal.
- Acceptance: launch a local (cloud unticked) campaign → the Live Status section on the wizard
  shows the populated `#active-card` (same card as the dashboard), not an empty box.

## ③ Pre-flight buttons overlap

Rework `.pf-actions` into a layout that cannot overlap at the panel's width:

- Drop the `flex:1` spacer trick. Use a two-row structure: primary actions row
  (`Exclude all flagged & launch` primary + `Launch anyway`/`Keep flagged…`) and a secondary
  row (`Fix on sheet`, `Cancel`), OR a single wrapping row where each button has
  `flex: 0 0 auto` and `white-space: nowrap` with the long "Keep flagged…" button allowed to
  take a full row. No button may overlap another at any width ≥ 360px.
- The `.pf-count-note` explainer keeps `width:100%` on its own line (already correct).
- Labels unchanged (they already match the operator's desired set).
- Acceptance: with blockers present (long "Keep flagged, launch anyway (blocklisted still
  excluded)" label active), all four buttons are fully readable and non-overlapping.

---

## Testing

- `src/warmup.js` math is already unit-tested; no logic change there. Add no new backend tests
  unless the tolerant SoO read moves into a helper worth covering.
- UI changes verified manually via `npm run dev:app` (repo convention — no UI test suite):
  1. Warm-up: arm on a FREE tile, select it so it goes In-Use, confirm the toggle is still
     present and turning it off reverts — from the In-Use state.
  2. Live Status: local launch shows the populated card.
  3. Pre-flight: trigger blockers, confirm button row.

## Risks / notes

- `renderProfiles()` is large and hot; the warm-up branch change must not alter the
  selection-checkbox wiring (the warm-up link already `stopPropagation`s — preserve that).
- The SoO "Immature" column name is not final; do not hard-code a single literal — read a small
  candidate set (`Immature`, `Maturity`, `New Account`) or a single agreed name, decided at
  plan time with the operator. Default: no suggestion when unmatched (safe).
