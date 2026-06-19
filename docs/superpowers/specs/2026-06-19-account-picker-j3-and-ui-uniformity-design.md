# Account Picker (J3) + Dropdown Uniformity + URL-Column Picker — Design

**Date:** 2026-06-19
**Status:** Approved (sketch-driven). Sketches:
`public/sketches/2026-06-19-account-picker-j3-states-v2.html` (J3 states),
`public/sketches/2026-06-19-account-picker-grid-variants.html` (C + D).

## Goal

Three changes, one release:
1. **J3 account picker** — replace the cluttered 6-element card + misfiring orange `is-flagged` ribbon with a clean two-zone tile (tinted status panel + detail), driven by a correct, campaign-aware state model.
2. **C — uniform dropdowns** — the four `.intro-config-select` controls adopt the boxed `.intro-config-select-wide` look so every dropdown matches.
3. **D — LinkedIn URL column picker** — restyle to the tab-picker (`.tabpick`) look, surface the existing auto-detect with a ✓, and warn (red `leadblock`) when a non-URL column is chosen.

Off-limits: `src/linkedin/outreach.js`, `src/linkedin/actions.js` (untouched). This is frontend-only (`public/*`) — no server or Apps Script change required. The `Assignee` column already exists (column I) and the Apps Script already returns every column by header name, so `soo.Assignee` is populated; no redeploy needed.

## J3 state model (the load-bearing part)

A tile is always exactly one state. Computed by a **pure** helper in
`public/js/account-guardrails.mjs` so it is unit-tested with `node --test`.

```
classifyAccountState(soo, me, mode, passover) -> { state, who, frees }
  state ∈ 'free' | 'assigned' | 'in-use' | 'blocked'
```

**Inputs (all real, verified):**
- `soo` — one account from `/api/soo-status` (keyed by exact header name).
- `me` — `getMyIdentifier()` (lowercased).
- `mode` — `#campaign-mode` value.
- `passover` — `getPassoverStatus()` → `{ monthly:{active,label}, cc:{active,label} }`.

**Priority order (first match wins):**
1. **blocked** — `isRestrictedStatus(soo.Status || soo.status)` (existing helper: matches `/restricted/` or `inaccessible`). Checkbox disabled. Colour red.
2. **in-use** — any credit field === `'in use'` AND the reserver ≠ me. Reserver = the per-credit `*User` field (`linkedinUser`/`inmailUser`/`salesNavUser`); **CC has no `ccUser` → fall back to `linkedinUser`** (operator confirmed: "same person as LinkedIn OP User"). `who` = reserver. In use by *me* → NOT in-use (it's fine) → falls through to free. Colour amber/gold. Names who.
3. **assigned** — `assignee = soo.Assignee || soo.assignee`, `isPool = section includes 'pool'|'unassigned'`. Fires when `!isPool && assignee && assignee !== '-' && assignee ≠ me`, **gated by passover**:
   - `channel = mapModeToChannel(mode)` (`cc` for connect_* modes, `monthly` for open_profile_only/inmail_only, else `null`).
   - If `channel` and `passover[channel].active === false` (credit resting = *before* the reset) → **assigned** (blue), `who = assignee`, `frees = passover[channel].label` (e.g. "in 4d").
   - If `passover[channel].active === true` (credits active = *after* passover reset) → assignment is treated as cleared → **free**. (This is the operator's "blue until passover, green after" rule — the live date wins over the static sheet value.)
   - If `channel === null` (message_only / check_status / introduce_back — no credit, no schedule) → assigned-to-other still shows **assigned** (blue) with no `frees` date (owner is owner).
4. **free** — everything else (unassigned, pool, assigned-to-me, in-use-by-me, or assignment cleared by passover). Colour green. Selectable.

`me` empty or `soo` missing → **free** (don't block selection on missing data).

**Reuse:** `classifyAccountFlag`, `mapModeToChannel`, `passoverWarning` already exist in
`account-guardrails.mjs` and encode most of this. `classifyAccountState` composes them +
the passover gate + the CC→linkedinUser reserver fallback. `isRestrictedStatus` stays in
`app.js`; pass its boolean into the helper (or import) — keep the helper free of DOM.

## J3 tile (visual)

Two zones (from the v2 sketch, real tokens):
- **Left status panel** (fixed ~138px, tinted by state): coloured dot + display-font word
  (`FREE` green / `ASSIGNED` blue / `IN USE` gold / `BLOCKED` red) + a mono "when/who" line
  (`Anyone can use` / `Cathy · frees in 4d` / `Mae · right now` / `Restricted`).
- **Right detail:** checkbox + email + a plain verdict sentence.

Colours map to existing tokens: green `--green`, blue `--blue`, gold `--gold`, red `--red`.
Tints: `rgba(...,0.10–0.13)`. **No YOURS state** (assigned-to-me = FREE, per operator).
Restricted card dims (`opacity:0.6`) and its checkbox is `disabled` (existing behavior).

**Replaces** in `renderProfiles` (app.js ~1024–1047): the `is-flagged` ribbon + `data-warn`,
the `renderSoOBadges` assignee line + 4-seg status bar + legend, and the `pick-primary` pill.
Per-credit detail (OP/InMail/SN/CC) is **not shown on the card** (it can return later as a hover
tooltip — out of scope now). Dup flag (`⚠ dup`) and restricted flag stay.

## C — uniform dropdowns

Four selects currently use `.intro-config-select` (borderless underline / inline "Every"):
`#primary-timing-select` (586), `#follow-up-delay` (610), `#check-cadence-select` (666),
`#pe-cadence` (1614). Give all four the boxed `.intro-config-select-wide` look (bordered,
radius 8px, chevron right). The two inline cadence selects ("Every [select]") keep the
`Every` prefix beside a boxed select via a flex row (prefix + `flex:1` select), per the
"After" column of the grid-variants sketch. No behavior change — purely visual class swap +
minor wrapper adjustment.

## D — LinkedIn URL column picker (tab-picker style)

Rendered by `previewSheet()` (app.js ~3430–3443) as `#linkedin-col-select` (`.ic-select`,
`.ic-row`/`.ic-label-block`). Change to the `.tabpick` block style:
- `.tabpick` container + `.tabpick-head` ("Which column holds the LinkedIn profile URL?").
- A boxed `<select>` (tabpick select style) listing columns; the auto-detected column
  (existing scan for `linkedin.com` in sample rows) preselected and labelled
  **"✓ auto-detected"** (green line under the select).
- **Guard:** on change, if the chosen column's sample values don't look like URLs
  (no `linkedin.com` / not URL-ish), show a red `.leadblock`-style warning
  ("That doesn't look like a URL column …"). Non-blocking warning (operator can still
  proceed), consistent with the sheet tab picker's leadblock.

The auto-detect logic already exists; this surfaces it and adds the on-change check.

## Testing

- `classifyAccountState` — `node --test` unit tests covering every state + the passover
  gate (assigned→free flip when channel active), CC→linkedinUser reserver fallback,
  in-use-by-me → free, blocked priority, missing-data → free, each campaign mode's channel.
- J3 render, C, D — manual in-app verification (no UI test harness). Version bump + relaunch.

## Out of scope

Per-credit hover tooltip on the J3 card; any Apps Script / server change; touching the
off-limits LinkedIn files; the earlier "RESTING/skip" model (discarded — passover governs
assignment, not skipping).
