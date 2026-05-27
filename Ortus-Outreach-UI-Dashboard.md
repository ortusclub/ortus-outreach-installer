# Ortus Outreach — UI Overhaul Spec

Self-contained brief for the redesign. The navigable prototype lives at:

```
~/ortus-gologin-clone/.superpowers/brainstorm/9051-1778233574/content/cockpit.html
```

Local server (auto-stops after 30 min idle):

```
http://localhost:53103
```

Restart command:

```
~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/scripts/start-server.sh \
  --project-dir ~/ortus-gologin-clone
```

---

## Context

The current app (`public/index.html`, 1008 lines, v2.13.0) is a 5-section vertical-scroll wizard:

1. Campaign Type
2. Data (Google Sheet)
3. Select GoLogin Accounts
4. Throughput
5. Launch

Plus a Dashboard with Active/Past campaign cards and a buried Live Status section.

**Pain (from operator, 2026-05-08):** "Scrolling past 5 sections every time to launch — even when nothing changed since yesterday."

---

## Goal

Collapse the wizard into a single **Cockpit** screen that fits above the fold on a typical laptop, without changing the existing aesthetic.

---

## Aesthetic — "Bugatti Command Deck" (NON-NEGOTIABLE)

Pulled verbatim from the comment block at the top of `public/css/style.css`:

- Canvas: `#0a0a0a` ink on `#fafafa` (or inverted in light theme), `#999` for secondary
- State colors only: `--green: #3fb950` · `--red: #f85149`
- Gold `#F7BE68` lives **exclusively** on the primary Launch CTA
- **No cards, no shadows, no gradients**
- Display type: `Bebas Neue` weight 400, uppercase, letter-spacing 0.01–0.02em
- UI labels: `Hanken Grotesk` mono, uppercase, letter-spacing 0.14–0.22em
- Body type: `Hanken Grotesk`
- Buttons are transparent pills with hairline borders
- Radii **0 or 9999px only** — no 4/6/8px rounding anywhere
- Hover = opacity shift only (no color changes, no transforms)
- Hairlines: `rgba(255,255,255,0.15)` / `rgba(255,255,255,0.06)` (dark theme)

Any deviation from these rules breaks the brand. The prior three redesign attempts were rejected for violating them (rounded cards, gold backgrounds on chips, drop shadows, colored state pills).

---

## What Stays From Today's App

- Dashboard with **Active** and **Past** campaign lists (operator's home base — hairline-divided rows, no cards)
- The **8-mode card grid** in the `.preset` language: Connect / Check Status / Message / Intro back / InMail / Open profile / Check DMs / Post amp
- Header stats row with big Bebas numbers and mono-uppercase keys

## What Changes — The Cockpit Screen

Replaces the 5 stacked sections. Layout, top to bottom:

1. **Page header** — H1 `New campaign` + header-stats row (Today / 7-day / Free senders)
2. **Step rail** — I. Type · II. Data · III. Accounts · IV. Pace · V. Launch — single horizontal hairline row instead of 5 scrolling sections
3. **Section I · Mode grid** — 8 `.preset` cards in a 4×2 grid (sharp corners, hairline-divided)
4. **Sections II–IV · Triple column** — Sheet URL | Accounts picker | Pace knobs (Pause / Cap / Parallel)
5. **Browse / search pane** — collapsed by default; full-width drawer when toggled (does NOT shrink the triple)
6. **Forecast row** — 4-cell hero: Actions (gold) / Duration / Finishes / Throughput
7. **Launch row** — gold `▶ Launch` pill + ghost `Save as preset` + keyboard hint `Esc clears · ⌘↩ launches`

### Accounts Column — the critical bit

Operators have **324 GoLogin profiles**. The mental model is "pick a preset, you're done"; individual selection is the override case.

Column structure (top to bottom):

- Header: `III. GoLogin accounts` + live count `<n> / 324` on the right
- **Three stacked preset cards** (matches the existing `.preset-row`):
  - `Assigned to me` — *Profiles where assignee matches my identifier* — count 1
  - `Unassigned pool` — *Shared* — count 92
  - `All` — *Show every profile* — count 324 (default active)
  - Click → fills the card with `--hairline-soft` background, shows `✓` mark on the title, count flips from gray to ink. Forecast recomputes live.
- **Match name** underline input (default: `Antonio`) + `Override` link
- **`▾ Browse / search profiles`** toggle pill at bottom, shows `X selected` summary

### Browse Pane — full-width drawer

Sits between the triple row and the Forecast. Pane appears when toggled; columns above stay the same size.

Structure:

- Header: `Browse profiles` title · `324 total · X selected` · bulk pills `Select all` / `Clear` / `Only available`
- Search input (filters by name/email/pool tag)
- **Fixed 3-column profile grid** (`grid-template-columns: repeat(3, 1fr)`)
- Each row:
  - 16px square checkbox top-left (filled `var(--ink)` with `✓` in `var(--bg)` when checked)
  - Email or raw profile name (1rem Hanken, weight 500)
  - Optional `POOL — FREE FOR ALL` line (mono, gray, 0.6rem, 0.16em letter-spacing)
  - Optional 4 fat pill bars: 6px tall, `border-radius: 9999px`, stretched to fill each 1/4 of the info column with 8px gaps
  - Mono labels `OP / INM / SN / CC` under each bar
  - Bar states: passover `#f5a39c`, CC active `var(--gold)`, none `var(--hairline)`
  - **Raw GoLogin profiles** (e.g. `zoominfo_ii`, `chatgpt/claude`) show truncated profile ID instead of bars
- Foot: `X selected / 324 total`
- Click any row → toggles its checkbox, updates count everywhere, removes the active state from the preset cards (overrides them)

---

## Live Status Route

New sidebar entry between Dashboard and Replies, with a pulsing green badge dot when a campaign is running.

### Hero block

- 28px padding, hairline border, two-row grid
- Top row:
  - Left: **160px circle**, 1.5px hairline border, big Bebas number inside (`—` when idle, the live sent count when running), mono uppercase label below (`Idle` / `Running`). Border turns green when running.
  - Right: status pill (`● IDLE` gray → `● Running` green pulsing), big Bebas title (`No campaign running` → `→ Connect · <sheet name>`), 3 KV rows for `LEAD / ACCOUNT / MODE`
- Bottom row: `SENT TODAY · n of cap` · `ERRORS · 0` (errors red unless zero) + hairline progress fill in gold

### Log toolbar + pane

- Toolbar: `☐ Show server lines` checkbox on the left; `Show browsers` / `Copy log` / `Clear log` mono pills on the right
- Pane: JetBrains Mono, 0.78rem, line-height 1.7, max-height 520px, scrollable
- Line format: `[ISO timestamp] [tag] message`
  - Timestamp: gray
  - Tag: gold
  - Message: ink (or red for errors, green for ok, gray for server lines)
- `Show server lines` toggles `.log-line.server` visibility
- `Copy log` uses `navigator.clipboard.writeText` over the visible (non-hidden) lines
- `Clear log` empties the pane

### Pop-out

`↗ Open in new window` button at the top of the section spawns a fresh browser window at `#live` (hash routing wired up). Operator can dock the live monitor on a second screen while running the cockpit on the main one.

---

## Interaction Flow

1. **Dashboard** — see Active / Past campaign rows (hairline-divided, no cards). Big Bebas numbers on the right per row (Sent / Replies / Errors / Remaining).
2. Click **+ Create campaign** (gold pill at bottom-left of dashboard).
3. **Cockpit** loads with last preset filled in. Step rail shows all 5 steps as done by default.
4. Adjust mode (click any `.preset` in the 4×2 grid) / sheet URL / accounts preset / pace knobs as needed. Forecast updates live with each change.
5. Click **▶ Launch** (or press **⌘↩**) → routes to **Live status**, marks circle green, log starts ticking every 600ms with realistic entries (`launching connect campaign…`, `gologin profile pool ready`, `sent invite to James Mitchell`, `dwelling 12s`, `rotated to kaizuko`).
6. Click **↗ Open in new window** to pop the live monitor out to a second window.

---

## Open Decisions

- Does the cockpit **replace** the wizard entirely (delete the 5 sections from `public/index.html`), or live alongside it as a "quick launch" mode that experienced operators can opt into via a settings flag?
- Should the Browse pane have a **"scope to current mode"** filter? E.g. for Check Status, only show profiles that have pending invites in the current sheet.
- Should ⌘↩ also auto-popout the Live Status to a new window, or stay inline?
- Where does the **Replies surface** fit? Currently a stub sidebar entry — could become Live Status's right rail, a Dashboard tab, or its own full route.
- The Step Rail (I-V) is currently decorative on the cockpit — should it be removable, or do operators want it as a visible reminder of what the cockpit replaced?

---

## Files Touched

- Prototype (this redesign): `~/ortus-gologin-clone/.superpowers/brainstorm/9051-1778233574/content/cockpit.html`
- Existing app reference: `~/ortus-gologin-clone/public/index.html`, `~/ortus-gologin-clone/public/css/style.css`
- Real accounts UI reference: `public/index.html` lines 469–870 (mode grid, preset row, profile grid, status bars)
