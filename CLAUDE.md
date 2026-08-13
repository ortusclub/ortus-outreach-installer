## Project

**Ortus Outreach** — LinkedIn outreach automation for The Ortus Club. Electron desktop app
that drives multiple GoLogin browser profiles to send connection requests, follow-ups,
and direct messages from a Google Sheet of leads. Used by ~3 colleagues on macOS laptops.

**Core value:** Reliable, observable, hands-off outreach. The campaign loop must keep
running even when individual accounts hit limits, sessions expire, or laptops are slow.

### Constraints

- **Runtime:** Node ≥22 (currently v25.9.0), no bundler for frontend, vanilla JS + Express 4
- **Browser automation:** GoLogin SDK 2.2.8 + puppeteer-core ^22.15.0, headed only
- **Test framework:** `node --test` (no Jest, no Vitest)
- **Distribution:** electron-builder DMG for macOS (no auto-update yet)
- **End-user hardware:** colleagues run on slow/overloaded machines; assume CPU/RAM
  starvation when tuning timeouts

## Technology Stack

| Library | Version | Purpose |
|---------|---------|---------|
| express | ^4.21.0 | HTTP server, routes |
| gologin | 2.2.8 | Browser profile management |
| puppeteer-core | ^22.15.0 | Browser automation |
| node-cron | ^4.2.1 | Scheduled campaign triggers |
| nodemailer | ^8.0.5 | Notification emails (errors/digests) |
| bcryptjs | ^3.0.3 | Password hashing for local auth |
| cookie-parser | ^1.4.7 | Session cookie parsing |
| pidusage | ^4.0.1 | Process resource sampling |
| dotenv | ^16.4.5 | .env loading |
| electron (dev) | ^33.4.11 | Desktop shell |
| electron-builder (dev) | ^25.1.8 | DMG builds |

## Architecture

- `server.js` (1158 lines) — Express app, all HTTP routes, campaign orchestration entry points
- `src/campaign.js` (1503 lines) — campaign loop, parking, watchdog, throttle, state, history
- `src/gologin-launcher.js` / `src/local-launcher.js` — browser launching paths
- `src/linkedin/` — outreach actions, navigation, selectors (**off-limits — see Conventions**)
- `src/sheets.js` / `src/sheets-writer.js` — Google Sheets read/write
- `src/disk-check.js` / `src/resource-monitor.js` — preflight + runtime resource checks
- `src/auth.js` — local auth (bcryptjs)
- `src/notifier.js` — email notifications
- `src/caffeinate.js` — keep-awake on macOS during runs
- `public/index.html` + `public/js/app.js` (3946 lines) + `public/css/style.css` —
  command-deck UI (monochrome, hairlines, gold only on Start CTA)
- `electron/main.js` — Electron shell

## Conventions

- **Atomic JSON writes** — write to `<file>.tmp` then `rename`; see `appendErrorLog` in `src/campaign.js` and `saveState` patterns.
- **NDJSON for crash-safe append-only logs** — see `appendFatalErrorSync` in `server.js` for the fatal-error log written from synchronous error handlers.
- **Bugatti command-deck design system** — monochrome, hairlines, gold only on Start CTA, radii 0 or 9999, no other accent colors. Tokens defined at top of `public/css/style.css`.
- **Testing pattern** — `node --test tests/*.test.js`. Pure-helper unit tests preferred over integration tests; manual browser verification for UI changes.
- **Off-limits files** — `src/linkedin/outreach.js` and `src/linkedin/actions.js`. The user has been burned by changes here. Never modify these without an explicit user request.

## Workflow

**Current version:** v2.13.13 (May 2026). Distributed as DMG via GitHub Releases.

This repo uses the superpowers plugin for Claude Code: brainstorming → writing-plans →
subagent-driven-development. Specs live in `docs/superpowers/specs/`, plans in
`docs/superpowers/plans/`. Each lens (operator UX, reliability, code health, etc.)
ships as a feature branch (`<lens>-<version>`) with end-of-branch verification, then
fast-forward merge to `main`.

## Operator rules (read this — these override defaults)

These rules apply to ALL work on this repo. They're durable, not session-specific.

0. **NEVER GUESS. MEASURE.** Every state in this app is readable. Never assert what
   a value is, or reason from what it "must be", without printing it first.
   - **Server state:** `curl` the API with a session cookie. Mint one by HMAC-SHA256
     signing `base64url(JSON.stringify({email, exp}))` with the secret at
     `"$ORTUS_DATA_DIR/.session-secret"` — `dev:app` sets `ORTUS_DATA_DIR` to
     `"$HOME/Library/Application Support/The Ortus Outreach/data"`. Send it as
     `Cookie: ortus_session=<body>.<sig>`.
   - **Browser state** (`mgSelected`, `mgAccounts`, `btn.disabled`, any module-scope
     variable in `app.js`): relaunch with
     `ORTUS_DATA_DIR=... ./node_modules/.bin/electron . --remote-debugging-port=9222`
     and read it over CDP — `fetch('http://localhost:9222/json')` for the page target,
     then `Runtime.evaluate` over the raw WebSocket. Node's global `WebSocket` uses
     `addEventListener`, not the `ws` package's `.on()`.
   - **Screenshots and screen recordings are evidence of the symptom, never the cause.**
     Extract frames with `ffmpeg -vf fps=1` and read them, then go measure the values.
   - Server-side `console.log` lands in `/tmp/dev-app.log`. An empty log is itself a
     measurement: it means the request never arrived.

1. **Ask first** — before touching code on any "build/fix" request, respond with **two
   concrete artefact-backed questions** (DOM HTML, log paste, console output,
   screenshot reference). The user's short-circuit phrase is "ask first" — if they
   say it, stop whatever you're doing and respond with two questions instead.

2. **Auto-relaunch dev:app after every commit.** In this repo, after every commit
   that touches runtime code, kill+restart `npm run dev:app` in the background so the
   user can immediately verify the change. Pattern:
   ```bash
   pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
   npm run dev:app > /tmp/dev-app.log 2>&1 &
   ```

3. **Sheet mockups must be Sheets-realistic.** When mocking up Google Sheet visuals
   (column layouts, conditional formatting, badges), use cell background + borders +
   font sizes — NOT HTML-only pills, cards, or progress bars. The target medium is a
   spreadsheet, the mockup should look like one.

4. **Auto-send defaults OFF.** Any tool that sends emails/messages/notifications
   externally must ship with the auto-send toggle **disabled by default**. The
   operator opts in explicitly. (Example: post-campaign reminder emails default to
   off in `data/notification-prefs.json`.)

## Skills to invoke (superpowers plugin)

Skills auto-trigger based on what you describe — you don't need slash commands. Names
below are what fires under the hood, so you recognize them when they activate.

| Skill | When | How to invoke |
|---|---|---|
| **brainstorming** | New feature, vague idea | "I want to build X" / "How should we approach Y" — produces a spec in `docs/superpowers/specs/` |
| **writing-plans** | Have a spec, need an executable plan | "Write me a plan for `<spec-file>`" — produces commit-sized tasks in `docs/superpowers/plans/` |
| **subagent-driven-development** | Plan exists, ready to build | "Execute the plan at `<plan-file>`" — runs task-by-task with isolated subagents + two-stage review |
| **systematic-debugging** | Bug bit, root cause unclear | "Debug this: `<error or symptom>`" — forces Phase 1 (evidence) before any fix attempt |

**The chain:** brainstorming → writing-plans → subagent-driven-development. That's
the loop for any non-trivial feature. Skip the chain ONLY for tiny, one-file changes.

## UI / visual work

The UI is **vanilla HTML/CSS/JS** (no React, no bundler). Tokens at top of
`public/css/style.css`. Bugatti command-deck design system: monochrome, hairlines,
gold only on Start CTA, radii 0 or 9999.

**Sketches & mockups** live in `public/sketches/` (free-standing HTML files
prototyping new layouts before committing to changes in `index.html`). When you build
a sketch, name it `<area>-<variant>.html` (e.g. `sheet-A-single-stage.html`) and
index it from `public/sketches/index.html`.

**Visual companion mode** of brainstorming — when a design question is genuinely
visual (mockup comparisons, layout choices), brainstorming can open a local browser
URL to show options. Token-intensive; the operator must explicitly accept the offer
to use it.

**Verifying UI changes** — `npm run dev:app` opens the Electron shell. Reload with
Cmd+R. There's no test suite for UI — manual verification only. For Chrome-extension
work or sheet-render verification, use the `claude-in-chrome` MCP tools to take
screenshots and read console messages.

## Recent shipped work (May 2026)

- **v2.13.x — Multi-status sheet schema:** Per-mode column visibility, v2 Stage
  palette, check_status bulk-first via Sam's Voyager endpoint.
- **Connect + Introduce Back mode** (PR #16): full cold-lead pipeline — send connect
  request, bulk-check for acceptance, auto-fire 3-way intro DM to a configured
  primary person, stamp `Introduction Status` column. Intro DM body lives in
  Section 5 Message Templates with the `{primary name}` / `{primary url}` /
  `{first name}` variable buttons.
- **Post-campaign notifications:** Per-operator opt-in reminder (email + desktop
  popup) fires before each scheduled connection-check sweep. Toggle in
  Sidebar → Notifications. Defaults OFF per the operator rule above.
- **Apps Script:** `google-apps-script.js` is the shared source of truth for ALL
  operators — same code for everyone. What differs per operator is just the
  deployment URL (each Google account publishes the script and gets its own
  `SHEETS_WEBAPP_URL` for the `.env`). When the repo's `.js` changes, every operator
  must paste the new content into their Apps Script editor and redeploy.

## GitHub housekeeping

- Sam typically opens PRs against `source` instead of `main`. Always check the **base
  branch** before merging — if it's not `main`, the PR won't actually ship even when
  merged. Either rebase onto `main` or close + re-open with the right base.
- PR backlog from PRs #6–#15 was cleaned up May 12 2026 (each closed with a SHA
  pointer to where the code actually landed on `main`).
