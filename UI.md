# Ortus Outreach — UI Reference

Self-contained reference for the web UI of the Ortus GoLogin Clone (LinkedIn outreach automation). Use this to make UI changes without reading the whole codebase.

> Scope: UI only. Core campaign/automation logic (`src/`, `server.js` background worker) is OUT of scope and must not be changed unless explicitly requested.

---

## 1. Project shape

```
ortus-gologin-clone/
├── server.js                 Express server (serves static + JSON APIs)
├── public/                   All UI lives here
│   ├── index.html            Main app (authenticated, single page)
│   ├── login.html            Sign-in page
│   ├── signup.html           Sign-up page
│   ├── sketches.html         Design sketch / exploration files (not shipped UI)
│   ├── preset-sketches*.html
│   ├── topbar-sketches.html
│   ├── css/
│   │   ├── style.css         Main app styles (~1660 lines)
│   │   └── auth.css          Login + signup styles (~410 lines)
│   └── js/
│       └── app.js            All client logic for index.html (~2400 lines)
└── src/                      Backend logic — DO NOT EDIT for UI work
```

The server serves `public/` statically and exposes JSON APIs under `/api/*`. All non-auth routes require a signed cookie set by `/api/auth/login` — the `/login.html` redirect happens server-side.

---

## 2. Design system

**Aesthetic:** "Bugatti-inspired command deck." Strict, monochrome, editorial, no cards/shadows/gradients. Inspired by Swiss print + luxury automotive dashboards.

### Tokens (`public/css/style.css` `:root`)

| Token | Dark (default) | Light (`body.theme-light`) | Use |
|---|---|---|---|
| `--bg` | `#0a0a0a` | `#fafafa` | Page background |
| `--ink` | `#fafafa` | `#0a0a0a` | Primary text |
| `--gray` | `#999999` | `#999999` | Secondary text, labels |
| `--hairline` | `rgba(255,255,255,0.15)` | `rgba(0,0,0,0.15)` | Borders between sections |
| `--hairline-soft` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.06)` | Subtle dividers |
| `--green` | `#3fb950` | same | Running / success (functional only) |
| `--red` | `#f85149` | same | Error (functional only) |
| `--gold` | `#F7BE68` | same | **Only** on the primary "Start Campaign" CTA |

### Type

- `--display` — `Bebas Neue` (wordmarks, big numbers, page titles)
- `--mono` / `--body` — `Hanken Grotesk` (UI text, labels)
- `JetBrains Mono` — imported for occasional code/number use

### Layout

- `.app` is a 3-column grid: `260px sidebar | fluid main | 360px right-pane`
- Sidebar is sticky `height:100vh`
- Right-pane is an always-visible command-center column (hidden on narrow screens)
- A sticky **run bar** floats at the bottom (60px tall) with live status + Start CTA + Presets popover

### Rules the styling enforces

- Radii are either `0` or `9999px` (no in-between).
- No box-shadows, no gradients, no filled buttons except the gold Start CTA.
- Hover = opacity shift only (no color changes).
- Buttons are transparent pills with hairline borders.
- Labels: uppercase, tracked-out (`letter-spacing: 0.2em+`), tiny (~0.62–0.75rem).
- Numbers and wordmarks: `Bebas Neue`, weight 400, tall and narrow.

---

## 3. Pages

### 3.1 `login.html` / `signup.html`

Shared two-pane auth layout (`public/css/auth.css`):

- **Left pane (`.auth-deck`)**: brand wordmark "Ortus Outreach," tagline "LinkedIn · Command Deck," a continuously-scrolling marquee listing the campaign modes (Connections, InMails, Direct Messages, Open Profiles, Status Check), and a footer with the app version fetched from `/api/health`.
- **Right pane (`.auth-form-pane`)**: form with Email + Password (+ Confirm on signup). Submits JSON to `/api/auth/login` or `/api/auth/signup`. Errors rendered in `.auth-feedback.error`. Success navigates to `/`.

Signup is gated by a **State of Operations** sheet — the submitted email must match a row there (server-side check).

### 3.2 `index.html` — the main app

One long scroll, split into numbered sections. Left sidebar navigates via `scrollToSection(id)` (smooth-scroll, no routing). All sections except Campaign Settings are **collapsible** (`.collapsible.collapsed` → click `.section-toggle` to expand).

---

## 4. `index.html` anatomy (top to bottom)

### 4.1 Sidebar (`aside.sidebar`)

1. **Brand** — "Ortus Outreach" wordmark + version (`#app-version-sidebar`).
2. **Nav — Campaign** (buttons scroll to section):
   - I. Settings → `#nav-settings`
   - II. Sheet → `#nav-sheet`
   - III. Accounts → `#nav-accounts`
   - IV. Templates → `#nav-templates`
   - V. Launch → `#nav-launch`
   - Live Status → `#nav-status`
3. **Nav — Review**:
   - History → `#history-section`
   - Schedules → `#schedules-section`
   - Server Log → toggles `#server-log-panel` (no section, inline panel near page top)
4. **Theme toggle** — Dark / Light (sets `body.theme-light`, persisted via `localStorage`).
5. **Edit labels toggle** — Enters label-edit mode (`body.edit-mode`); every element with `[data-edit]` becomes inline-editable. Save/Cancel/Reset actions persist overrides to `localStorage`.
6. **Notifications toggle** — browser push permission + test email (via `/api/notify/test`).
7. **Footer** — user chip (`info@ortus.solutions` placeholder → real email after login), today's date, Sign out button.

### 4.2 Page header

- Big "Welcome" wordmark (`#greeting-wordmark`) + subtitle + version.
- Four **header stats** (`.header-stats`): Today, 7D, Errors 24h, Passover. Each has a label + value + hidden subtitle.

### 4.3 Server log panel (inline, hidden by default)

`#server-log-panel` — auto-refreshing console tail, with Copy and Clear buttons. Reads `/api/server-log`.

### 4.4 Section 1 — Campaign Settings (`#nav-settings`)

Campaign mode picker. Unlike the other sections, **not collapsible**.

- **Mode selector** — a 3-column affair: prev button | center (counter `01/07`, title, description, progress bar) | next button.
- **Mode chips** (`#mode-chips`) — quick-pick chips populated from JS.
- Hidden `<select id="campaign-mode">` is the source of truth. Modes:
  - `connect_only`, `check_status`, `message_only`, `inmail_only`, `open_profile_only` (plus `connect_and_message` and `auto` referenced in templates).
- **Open Profile toggle** (`#open-profile-toggle`, hidden until relevant) — checkbox "Message Open Profiles directly."

### 4.5 Section 2 — Rate & Limits (`#nav-pace`, collapsible)

- **Stepper grid**: three `.stepper` inputs (number + `+`/`−` buttons):
  - `#rate-per-hour` (Connections/account/hr, 1–30, default 6)
  - `#message-gap` (seconds between messages, 10–600, default 60) — hidden unless mode uses messaging
  - `#daily-limit` (Max/account total, 1–100, default 40)
- **Campaign hero summary** (`#campaign-summary`) — big numbers for Actions / Duration / Finishes (computed client-side via `updateCampaignSummary()`).
- **Inline warnings** — "Keep laptop open" + "Do not close the browser windows."

### 4.6 Section 3 — Google Sheet URL (`#nav-sheet`, collapsible)

Single text input `#sheet-url` + "Preview Sheet" button → calls `/api/sheet/preview`, renders result in `#sheet-preview`.

### 4.7 Section 4 — GoLogin Accounts (`#nav-accounts`, collapsible)

- **Preset row** — three large buttons: **Assigned to me** / **Unassigned Pool** / **All**. Counts injected into `#preset-count-*`.
- **My identity row** — `#my-identifier` input (email/name used to match "Assigned" preset), autosaved.
- **Accounts browser** (`#accounts-browser`, itself collapsible):
  - Search `#profile-search`
  - Quick actions: Select All Visible / Deselect All / Refresh
  - **Filter chips** — All / Available / In use / Selected only (with live counts)
  - `#passover-banner` — shown when monthly or weekly passover (API credit reset) is near
  - `#profiles-grid` — grid of profile cards populated from `/api/profiles`
  - `#profiles-count` — "X of Y visible"
- **Selected panel** (`#selected-panel`, hidden until selection) — shows selected accounts in execution order.

### 4.8 Section 5 — Message Templates (`#nav-templates`, collapsible)

Wrapper for all template editors. Shows/hides subsections based on mode.

- **Templates header**:
  - `#templates-question` — the "Do you want to add a note while connecting?" Yes/No toggle (only shown when mode = connect).
- **Template bar** `#template-bar` — Select / Load / Delete / Save As. Dropdown populated from `/api/templates`.
- Four subsections (each a `.section.tpl-section`, shown per active mode):
  - `#tpl-connect-section` — Connection note (`#tpl-note`, 300-char max).
  - `#tpl-message-section` — Follow-up message (`#tpl-followup`).
  - `#tpl-inmail-section` — InMail subject + body.
  - `#tpl-op-section` — Open-profile subject + body (labeled "free — no credits used").
- Each textarea has a **placeholder tag row** (`.placeholder-tags[data-target="..."]`) — clickable chips that insert merge tokens like `{firstName}`.

### 4.9 Section 6 — Launch (`#nav-launch`, collapsible)

- **Launch hero** — `#launch-number` (big count) + caption "X connections · Y accounts · ETA Z."
- **Mode toggle** — Now / Schedule.
- **Now panel** — Start Campaign (`#btn-start`, gold CTA) + Stop Campaign (`#btn-stop`, disabled until running).
- **Schedule panel**:
  - Name (`#quick-sched-name`), Time (`#quick-sched-time`, default `09:00`)
  - Day-of-week checkboxes (Mon–Sun, Mon–Fri checked by default)
  - **Save Schedule** button — captures full current page state (mode, accounts, templates, sheet URL, limits) and POSTs to `/api/schedules`.

### 4.10 Live Status (`#nav-status`, collapsible)

- `#account-queue` — per-account progress strips (hidden until running).
- **Status grid** — 6 stat cards: Status / Mode / Account / Progress / Total / Errors.
- `#st-bar` — progress bar.
- Campaign warnings (shown when running): keep laptop open, don't close windows.
- **Copy Log / Clear Log** buttons.
- `#log-panel` — scrolling event log, entries use `.entry.info | .ok | .err`.

### 4.11 Campaign History (`#history-section`, collapsible)

Expanded by default. Header has Download CSV + Clear History. `#history-panel` lists previous runs (from `/api/history`).

### 4.12 Campaign Schedules (`#schedules-section`, collapsible)

List-only; creation happens in the Launch section. `#schedule-list` renders items from `/api/schedules`.

### 4.13 Right pane (`aside.right-pane`) — command-center column

Always visible on desktop, hidden on narrow screens.

- **Status** — dot + text ("Idle" / "Running") + subtitle.
- **Passover** — two rows:
  - "OP · InMail · Sales Nav" — monthly reset state
  - "CC" — weekly reset state
- **Selected** — big count + sub "N accounts · N targets."
- **Next schedule** — name + time (or "None / No upcoming runs").
- **Live activity** feed — last ~10 events (`.rp-feed-item` with time + text).

### 4.14 Run bar (`.run-bar`) — sticky bottom

- Left: state dot + text.
- Right:
  - "View Status" button (scrolls to `#nav-status`).
  - **Preset pill** `#preset-pill` — opens a popover upward with pinned "Last Used," saved presets, and "+ Save current as…" row.
  - **Start Campaign** button (gold CTA).

---

## 5. Client JavaScript overview (`public/js/app.js`)

All UI state lives in this one file. Key global concerns:

- **Label editing** — `enterEditMode` / `saveEdits` / `cancelEdits` / `resetEdits`. Every `[data-edit="key"]` element is an editable label; overrides stored in `localStorage` under a single key.
- **Theme** — `setTheme('dark'|'light')`, persisted.
- **Section collapse** — `toggleSection(id)` adds/removes `.collapsed`. Collapse state not persisted.
- **Campaign mode** — `modeStep(+/-1)`, `onModeChange()` syncs the hidden `<select>` and shows/hides dependent subsections (message gap, template sections, yes/no note toggle).
- **Summary math** — `updateCampaignSummary()` recomputes Actions / Duration / Finishes from selected accounts × limits × rate, fires on any input change.
- **Profiles** — `loadProfiles()` → `/api/profiles`; rendered into `#profiles-grid`; selection state tracked per-ID; `applyPreset` / `applyFilter` filter visible cards.
- **Templates** — `saveCurrentTemplate`, `loadSelectedTemplate`, `deleteSelectedTemplate`. Placeholder chips insert tokens via cursor-position splice.
- **Presets** — `saveCurrentAsPreset`, `loadLastUsedPreset`, popover toggles.
- **Campaign control** — `startCampaign()` POSTs full payload to `/api/campaign/start`; polls `/api/campaign/status` on interval to drive Live Status + right-pane feed; `stopCampaign()` POSTs to `/api/campaign/stop`.
- **History** — `loadHistory()`, `downloadCsv()`, `clearHistory()`.
- **Server log** — `toggleServerLog()` / `copyServerLog()` / `clearServerLog()` — polls `/api/server-log`.
- **Notifications** — `requestNotificationPermission()` (browser), `sendTestNotification()` (server email).

---

## 6. APIs the UI consumes

Auth:
- `POST /api/auth/login` — `{email, password}` → sets cookie
- `POST /api/auth/signup` — same
- `POST /api/auth/logout`
- `GET  /api/me` — current user

Meta:
- `GET  /api/health` — `{version}` for version chips
- `GET  /api/server-log` / `DELETE /api/server-log`

Campaign assets:
- `GET  /api/profiles` — GoLogin profiles
- `GET  /api/soo-status` — State of Operations / passover status
- `GET  /api/sheet/preview?url=...` — preview rows

Campaign lifecycle:
- `POST /api/campaign/start` — payload = full page state
- `POST /api/campaign/stop`
- `GET  /api/campaign/status` — polled while running

Persistence:
- `GET/POST/DELETE /api/presets[/name]`, `POST /api/presets/_last_used`
- `GET/POST/DELETE /api/templates[/name]`
- `GET/POST/DELETE /api/schedules[/id]`
- `GET    /api/history`, `DELETE /api/history`, `GET /api/export/csv`

Notifications:
- `POST /api/notify/test`

---

## 7. Conventions to keep when editing

1. **Monochrome + hairlines only.** No cards, shadows, gradients, or new accent colors. If you need to draw a divider, use `border: 1px solid var(--hairline)` — nothing else.
2. **Radii are 0 or 9999px.** Pick a side; don't invent `6px` rounding.
3. **Type scale already exists.** Use `var(--display)` for numbers/titles, Hanken Grotesk for everything else. Don't add new font imports.
4. **Labels are uppercase, tracked-out, tiny.** Follow existing `.rp-label` / `.nav-section-label` patterns.
5. **Every user-visible string in `index.html` should carry `data-edit="unique-key"`** so it's editable via the sidebar Edit mode. When you add copy, add a `data-edit` key.
6. **Collapsible sections** use the pattern `<div class="section collapsible collapsed"><h2 class="section-toggle" onclick="toggleSection('id')"><span class="caret">▾</span> ...</h2><div class="collapsible-body">...</div></div>`. Reuse it; don't invent new collapse mechanics.
7. **No framework.** Vanilla JS, no bundler, no npm for the frontend. `app.js` is loaded as a single `<script src="/js/app.js">`.
8. **Right pane + run bar stay in sync with main content.** If you add a new major state, consider whether it needs a right-pane row and/or run-bar indicator.
9. **Core campaign logic is off-limits.** For UI work, assume the backend contract is fixed; if you need a new field, flag it rather than editing `src/`.

---

## 8. Sketch/exploration files

`public/sketches.html`, `preset-sketches.html`, `preset-sketches-v2.html`, `topbar-sketches.html` are design playgrounds — not linked from the live app. Safe to reference for visual direction, safe to delete if you're told they're stale.
