# Floating Live Console — Design

**Date:** 2026-05-27
**Status:** Draft for review
**Branch target:** new feature branch off current working branch

---

## Background

When a campaign is running, operators frequently leave the dashboard to do other things — edit templates in Campaign Settings, check Accounts, browse Logs, tweak Connect cadence in Throughput. While they're away from the dashboard, there is **no live signal** that the campaign is still running. The only live-status surface (`#cockpit-panel`) lives inside `#nav-status` on the dashboard view; from any other section, the operator has no glanceable confirmation that anything is happening.

This causes two failure modes:
1. **"Did I forget to start it?"** — operator has to scroll back up to Live Status to verify.
2. **Missed warnings** — throttle activations, parked profiles, and errors are invisible until the operator returns to the dashboard.

The fix is a small, persistent floating console anchored to the bottom-left of the viewport that surfaces campaign liveness on every screen and expands into a HUD card with the most critical fields on click.

## Decisions Locked in Brainstorming

| Question | Decision |
|---|---|
| Visual treatment | **Variant A** — single-line pill at bottom-left, fixed-position |
| Click behavior | **Variant 3** — expand in place into a HUD card; card footer has "Go to dashboard ›" link |
| Where shown | All routes **except** `#/` (the dashboard). On the dashboard the real cockpit is already visible. |
| Default state | **Collapsed pill**. Expand state persisted in `localStorage` after first click. |
| Status colors | green pulse (running, healthy), amber dot (throttle or parked > 0), gray dot (paused), red segment (errors > 0) |

## Architecture

### Where it lives
- **DOM:** New top-level element appended after both `.route-view` containers in `public/index.html`, so it's not inside either view and not affected by view switching.
- **CSS:** New section in `public/css/style.css` under a `.live-console` namespace. Pill + card share the same root element; expanded/collapsed state is a class on the root.
- **JS:** New block in `public/js/app.js` (the codebase uses one big `app.js` rather than split modules — match existing convention). Hooks into the existing `pollStatus()` flow — does **not** introduce a new polling loop.

### Data source
- Reads from the existing `__cockpit` global already populated by `pollStatus()` (which polls `/api/campaign/status`).
- No new endpoints. No new state on the server.

### View routing
- Reuses the existing hash-based routing (`#/` = dashboard, `#/new` = wizard).
- "Go to dashboard ›" link calls the existing `goDashboard()` helper (`public/js/app.js:6992`).
- Visibility is gated by `location.hash` — re-evaluated on `hashchange`.

## Components

### 1. Root element `.live-console`
Single fixed-position div anchored bottom-left (`position: fixed; bottom: 18px; left: 18px; z-index: 60`). Two states via root class:
- `.live-console.is-collapsed` — renders as pill
- `.live-console.is-expanded` — renders as HUD card

Hidden entirely (`display: none`) when:
- `!__cockpit.running` (no campaign), **OR**
- `location.hash === '#/'` or `location.hash === ''` (on dashboard)

### 2. Pill layout (collapsed state)
```
●  Sam · CC+IC  |  47 / 280  ›
```
Single line:
- Status dot (green pulse / amber / gray, per state matrix below)
- Campaign name + mode tag (`name · mode`)
- Counter (`processedToday / totalTargets`)
- Optional error segment (`· 2 err`) when `errors.length > 0`
- Optional parked segment (`· 1 parked`) when `parked.length > 0`
- Chevron `›` indicating expandability

### 3. Card layout (expanded state)
360px wide, anchored same corner, header + body + footer:

**Header (clickable to collapse):**
```
● SAM · CC+IC                                –
```
- Pulse dot, campaign name, mode tag (gold)
- Minimize button `–` collapses back to pill

**Body (meta rows + log tail):**
```
ACCOUNT     Marlon
LEAD        Priya Sharma
ACTION      Sending intro DM
SENT        47 / 280 · 0 err
─────────────────────────────
[14:02:11] Marlon · opened conversation
[14:02:14] Marlon · sent intro DM       ← latest in ink
[14:02:14] cooldown 90s · next: Anika V.
```
- 4 meta rows: Account, Lead, Action, Sent
- Last 3 lines from `__cockpit.logs.slice(-3)` in mono, latest line in `--ink`

**Footer:**
```
state · sending                Go to dashboard ›
```
- Left: `state` field from payload (sending / monitoring / paused)
- Right: gold link, calls `goDashboard()` on click

## State Matrix

| Condition | Dot color | Pulse | Extra |
|---|---|---|---|
| `running && !throttle.active && errors.length === 0` | green | yes | — |
| `running && throttle.active` | amber | no | shows throttle reason in card |
| `running && errors.length > 0` | green | yes | `· N err` segment on pill |
| `running && parked.length > 0` | amber | no | `· N parked` segment on pill |
| `paused === true` | gray | no | label flips to "paused" |
| `state === 'monitoring'` | green | yes (slower) | label flips to "monitoring" |
| Multiple flags | precedence: paused > throttle > parked > errors > healthy | | |

## Data Flow

```
/api/campaign/status (existing endpoint, no change)
        ↓
pollStatus() (existing in app.js:~370)
        ↓
window.__cockpit (existing global)
        ↓
renderLiveConsole() (NEW — called from pollStatus' existing render tick)
        ↓
.live-console DOM updates (text content + class swaps; no innerHTML thrashing)
```

Render is **idempotent** — runs every poll tick (~2s) but only writes when values change. Use `data-*` attributes to track last-written values, skip the write if unchanged.

## Persistence

- `localStorage.setItem('liveConsole.expanded', '1' | '0')` on user interaction.
- On page load: read the flag, default to `'0'` (collapsed) if missing.
- Cleared **once** on the `running` → `idle` transition (detected by comparing previous tick's `running` flag with the current one). Always starts collapsed for the next campaign.

## Error Handling

- If `__cockpit` is undefined or missing required fields: render the pill in a degraded state (gray dot, "—") rather than crashing. The existing cockpit-panel has the same fallback pattern (`'—'` placeholders); mirror it.
- If `errors.length > 100` or `logs.length > 500` (shouldn't happen — server already caps): just take `.slice(-N)`.

## Testing

Per the repo's testing pattern (`node --test`, pure helpers preferred):

- **Pure unit test** for the state-to-pill-class mapping helper. Inputs: minimal `__cockpit` snapshots. Outputs: `{dot: 'green'|'amber'|'gray', pulse: bool, label: string, errSegment: string|null, parkedSegment: string|null}`. Covers all 6 rows of the state matrix.
- **Pure unit test** for the visibility predicate `shouldShowConsole({running, hash})`. Inputs: 4 combinations of (running, on-dashboard). Output: boolean.
- **Manual verification** in dev:app: start a real campaign, navigate to Settings/Accounts/Logs/Templates, confirm pill appears with live data. Click → expands. Click "Go to dashboard ›" → returns to dashboard. Pause campaign → dot turns gray. Throttle warning → dot turns amber. Stop campaign → console disappears.

## Out of Scope

- Drag-to-reposition the card (V3 sketch hinted at it; cutting from v1).
- Multiple campaign support (still one-at-a-time per project constraint).
- Push notifications / sound alerts on errors.
- Sticky pill on the dashboard itself (decided: hide on dashboard).
- Animation polish beyond simple `display: none` toggle (no slide-in transitions in v1).
- Mobile / small-screen layout (Electron desktop only).

## Files Touched

- `public/index.html` — add 1 root element (after `#wizard-view`)
- `public/css/style.css` — add `.live-console` block (~120 lines)
- `public/js/app.js` — add render function + hook into existing `pollStatus()` render tick + hashchange listener (~80 lines)
- `tests/live-console.test.js` (new) — pure helpers for state mapping + visibility predicate

## Risks

- **None to off-limits files.** Does not touch `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- **No backend changes.** Uses existing `/api/campaign/status` payload only.
- **No new dependencies.**
- **localStorage namespace collision:** Use `liveConsole.*` prefix to avoid colliding with anything else in the app.

---

**Next step after approval:** `writing-plans` skill to produce a task-by-task executable plan in `docs/superpowers/plans/2026-05-27-floating-live-console-plan.md`.
