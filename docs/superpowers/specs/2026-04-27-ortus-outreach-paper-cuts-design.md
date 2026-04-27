# Ortus Outreach — Operator UX Paper-Cuts Patch

**Date:** 2026-04-27
**Approach:** 1 — surgical patches (no architectural change)
**Design contract:** existing "Bugatti command deck" — monochrome, hairlines, gold only on Start CTA, radii 0 or 9999
**Companion sketches:** `public/sketches/papercuts-{index,A,B,C}.html`

## Scope

Three clusters of small fixes to `public/index.html`, `public/js/app.js`, and `public/css/style.css`. One read-only backend endpoint (C4 only — see C4 detail and Files-touched table). No new dependencies. No design-token additions. No new server-side persistence.

Each cluster is independently shippable. Each patch within a cluster is independently revertible.

**Out of scope** (explicitly):

- C1 — campaign mode picker stays as-is (prev/next + chips + hidden `<select>`)
- Any rework of `src/` (core campaign logic untouched)
- Any change to existing `/api/*` endpoints (only one new read-only endpoint added in C4)
- Any redesign moves: no new accent colors, fonts, shadows, gradients, or radii

---

## Cluster A — Setup flow nudge

**Cuts addressed:** #1 (mismatched section numbers), #2 (everything collapsed on first run), #3 (no "next step" affordance)

### A1 — Renumber sections to match visual order

Current top-to-bottom order in `public/index.html`:
1. Settings (numbered "1.")
2. Throughput (numbered "4.")
3. Sheet URL (numbered "2.")
4. Accounts (numbered "3.")
5. Templates (numbered "5.")
6. Launch (numbered "6.")

Renumber so labels match position:
1. Settings → "1."
2. Sheet URL → "2."
3. Accounts → "3."
4. Templates → "4."
5. Throughput → "5."
6. Launch → "6."

Also update sidebar nav numerals (`I.` / `II.` / `III.` / `IV.` / `V.`) to match new order. Sidebar Live Status / History / Schedules buttons unchanged.

This is a copy/markup change in `public/index.html` only. Zero JS impact.

### A2 — Smart default expand + done summaries

**Initial-load behavior (one-shot):**

- After profiles/templates/sheet state has hydrated, walk the six numbered sections in order.
- For each, compute a `readiness` value: `done | empty | locked`.
  - `done` — has valid input or non-default value
  - `empty` — required for Start, no input yet
  - `locked` — depends on a prior `empty` section
- First `empty` section: expand (override the persisted `section-collapsed:` value for this load only — do not write back to localStorage).
- All `done` sections: collapse and show their one-line summary in the section header (right-aligned, `--gray` color, existing 0.6rem tracked-out label style).

**Live-update behavior:**

- Section summary strings recompute on every input change that affects readiness (same triggers as `updateCampaignSummary()`).
- Sidebar glyphs (A3) recompute on the same triggers.
- Collapsed/expanded state does NOT change after the initial load — operator-driven `toggleSection()` calls remain the only way to flip a section open/closed once the page is past hydration.

Summary line content per section:

| Section | Summary string (when done) |
|---|---|
| Settings | mode name · "with note" / "no note" if connect mode |
| Sheet URL | `<N> leads · <human> ago` (uses preview cache if available; "—" if no cache) |
| Accounts | `<N> selected` |
| Templates | template name + first 40 chars of body |
| Throughput | `<rate>/hr · <daily-limit> max/account` |
| Launch | "ready" if all prior done, else "blocked" |

State persists in memory only (no new localStorage keys). The user's manual collapse/expand choices still write to existing `section-collapsed:<id>` keys via `toggleSection()`. Only the *initial* expand-the-first-empty action overrides the persisted value.

### A3 — Sidebar state glyphs

Each `.nav-item` for a numbered section gets a trailing glyph reflecting its readiness state:

- `✓` (color `--green`) for `done`
- `▸` (color `--gold`) for the currently expanded section
- `◯` (color `--gray` at 0.6 opacity) for `empty` / `locked`

Glyph element is added to existing nav buttons in `public/index.html`. CSS classes added to `style.css`. Update function lives in `app.js` and runs on the same triggers that recompute the section summaries (A2).

Live Status / History / Schedules nav items get no glyph (they don't represent setup steps).

---

## Cluster B — Cockpit unification

**Cuts addressed:** #5 (status duplicated 4 places), #6 (two log surfaces), #8 (no Stop in run bar)

### B1 — Run-bar Stop button

When campaign status is `running`, the run bar shows a Stop pill on the right (before "View Status"):

- Border: `1px solid var(--red)`, `border-radius: 9999px`
- Text: `var(--red)`, "Stop", uppercase tracked-out
- Click handler: calls existing `stopCampaign()` from `app.js` — same function the Launch section's Stop button calls
- Visibility: hidden when status ≠ `running`; the existing Start CTA hides when running and reappears when idle

The Launch section's Stop button stays (muscle memory + parity with Start being there).

### B2 — Right pane = single live-status authority

Today four surfaces show "what is happening now":

1. Header stats (Today / 7D / Errors 24h / Passover)
2. Live Cockpit panel (`#live-cockpit-panel` — added in 2.8.12)
3. Right pane Status row (`aside.right-pane`)
4. Run bar dot

Changes:

- **Live Cockpit panel deletes.** Its three rows (Action / Account / Next-in) move into the right pane as new rows under the existing Status row. The right pane gains a "Stuck?" row (yes/no), derived client-side from the existing `/api/campaign/status` response: stuck = no progress field has changed for ≥ 90 seconds. If the status response already exposes a `stuck` flag, use that instead.
- **Header stats stay** but get scope clarification in their hidden subtitle reveal:
  - Today → "Today (sent)"
  - 7D → "7-day total"
  - Errors 24h → "Errors in last 24h"
  - Passover → "Days to next reset"
  These labels become primary (visible by default), making clear that header stats are trailing-window numbers, not the live state.
- **Run bar dot** stays as it is (it's the persistent "what's the campaign doing right now" anchor).

### B3 — One log, two filters

Today there are two log surfaces:
- Inline Server Log panel (`#server-log-panel`, toggled from sidebar "Server Log" button) — reads `/api/server-log`
- Live Status log (`#log-panel`) — populated from `/api/campaign/status` polling

Changes:

- Inline `#server-log-panel` deletes from `index.html`.
- Sidebar "Server Log" nav item becomes "Open log" — scrolls to Live Status section and expands it if collapsed.
- Live Status log panel header gains a checkbox: `[ ] Show server lines`. When checked, polls `/api/server-log` in addition to campaign status and interleaves server log lines (prefixed with a tiny `srv` tag in `--gray`) into the same scrolling panel by timestamp.
- Existing Copy / Clear buttons keep their current behavior (Clear writes the existing `ortus-log-cleared-at` localStorage timestamp).

`toggleServerLog`, `fetchServerLog`, `clearServerLog`, `copyServerLog` functions in `app.js` are kept and repurposed for the unified panel.

---

## Cluster C — The small stuff

**Cuts addressed:** #13 (duplicate identity), #14 (hidden local-browser name), #16 (no notification state)

C1 (mode picker simplification) intentionally dropped — keep prev/next + chips + hidden select as-is.

### C2 — Operator identity auto-derives

Today: sidebar shows the logged-in email chip; the Accounts section has a free-text "My identifier" input (`#my-identifier`) used to match the "Assigned to me" preset. The two can drift; "Assigned to me" silently breaks when they do.

Changes:

- "My identifier" input becomes read-only by default, populated automatically from the local-part of the email returned by `/api/me` (e.g. `info@ortus.solutions` → `info`; `antonio@ortus.solutions` → `antonio`). The placeholder email shown before login is ignored — auto-derive runs only after `/api/me` resolves.
- A small "Override" link sits next to the read-only value. Clicking it makes the field editable and writes to the existing `ortus-my-identifier` localStorage key. Once overridden, an "Auto" link appears to revert to the auto-derived value.
- The sidebar email chip is the source of truth; the Accounts label changes from "My identifier" to "Match name" to make the relationship explicit.

No backend change — the existing `localStorage` key continues to be the only persistence.

### C3 — "Local browser name" becomes a real setting

Today: the local-browser identity (`localBrowserFirstName`, stored in `localStorage`) is set as a side effect of checking the "use local browser" checkbox on a profile card and typing into a transient input. There's no top-level place to see or change it.

Changes:

- Add a labeled input "Local browser name" inside the Settings section (just below the mode picker) labeled with the existing micro-label style.
- Reads/writes the same `localStorage.localBrowserFirstName` key. Two-way binding with the existing profile-card input — typing in either updates both.
- Profile-card checkbox + transient input stay (no behavior change there).

### C4 — Notifications panel shows state

Today: sidebar Notifications row is one "Enable" button. No indication of current permission state, no feedback after sending a test email.

Changes:

- Replace the single Enable button with three rows:
  - **Browser push** — state: `Granted` / `Denied` / `Default` (computed from `Notification.permission`); button label changes to "Enable" only when `Default`.
  - **Email · SMTP** — state: `Wired` / `Not configured` (read from a new lightweight GET /api/notify/status endpoint that returns `{ smtpConfigured: boolean }` based on env vars `SMTP_HOST` etc.). No new persistence.
  - **Last test** — shows time since last test + result (`delivered` / `failed`); persisted to `localStorage.ortus-last-notify-test` as `{ at, result }` when the existing `sendTestNotification()` returns.
- Test button stays nearby and updates the Last test row inline on completion.

This is the only patch that adds a backend endpoint (`GET /api/notify/status`). The endpoint is read-only and returns a single boolean — explicitly carved out as the minimum viable backend touch.

---

## Files touched

| File | Cluster | Change type |
|---|---|---|
| `public/index.html` | A1, A2, A3, B1, B2, B3, C2, C3, C4 | markup edits |
| `public/js/app.js` | A2, A3, B1, B2, B3, C2, C3, C4 | function additions + event wiring |
| `public/css/style.css` | A2, A3, B1, B2, C4 | new utility classes (state glyphs, run-bar Stop pill, notif state rows) |
| `server.js` | C4 only | one new GET endpoint `/api/notify/status` returning `{ smtpConfigured }` |

No new dependencies. No changes to `src/`, no changes to existing `/api/*` endpoints.

## Acceptance per cluster

**Cluster A passes when:**
- Section labels read 1 → 2 → 3 → 4 → 5 → 6 in document order, sidebar nav matches.
- On a fresh load with at least one empty required section, that section is expanded and all `done` sections are collapsed with a summary line.
- Sidebar nav shows `✓ / ▸ / ◯` glyphs that match the section state.

**Cluster B passes when:**
- Run bar shows a Stop pill while the campaign is running; clicking it stops the campaign with no console errors.
- Live Cockpit panel is removed from the DOM; right pane shows Action / Account / Next-in / Stuck rows during a run.
- Inline Server Log panel is removed; Live Status log panel has a "Show server lines" checkbox; with it checked, server log lines appear inline.

**Cluster C passes when:**
- Accounts "Match name" field is read-only by default, populated from the sidebar email; Override / Auto links toggle editability.
- Settings section has a "Local browser name" input; typing in it updates the same value the profile-card input uses.
- Notifications panel shows three labeled state rows; `Last test` updates after pressing the test button.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Renumbering breaks docs/screenshots in `docs/manual.md` | Spot-check `docs/manual.md` and update any references after A1 |
| A2's "expand first empty" interferes with returning users who expect their last collapse state | The override is per-load only; never writes back to `section-collapsed:<id>` |
| B3's interleaved log mixes timestamps from two different clocks (server vs client) | Server log already returns server timestamps; render with a tiny `srv` tag so the operator can tell sources apart |
| C2's auto-derive breaks for users whose match name doesn't equal their email local-part | Override link is one click away; Auto link reverts |
| C4's `/api/notify/status` is the only backend touch; needs to not break when `SMTP_HOST` env var is absent | Endpoint just returns `{ smtpConfigured: !!process.env.SMTP_HOST }` — pure read, no SMTP dial-out |

## Version

This patch ships as version 2.8.19 (single version, all three clusters bundled). If clusters need to ship separately, A → 2.8.19, B → 2.8.20, C → 2.8.21 in order of operator value.
