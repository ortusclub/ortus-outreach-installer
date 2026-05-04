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

**Ask-first protocol** — before touching code on any "build/fix" request, ask the user
two concrete questions with how-to-answer instructions (DOM HTML, log paste, console
output). Full rule: `.claude/ASK-FIRST.md`. The user can short-circuit me with the
phrase "ask first" if I forget.

This repo uses the superpowers plugin for Claude Code: brainstorming → writing-plans →
subagent-driven-development. Specs live in `docs/superpowers/specs/`, plans in
`docs/superpowers/plans/`. Each lens (operator UX, reliability, code health, etc.)
ships as a feature branch (`<lens>-<version>`) with end-of-branch verification, then
fast-forward merge to `main`.

Recent lenses shipped:
- 2.8.19 — operator UX paper-cuts (lens A)
- 2.8.20 — reliability under stress (lens B)
- 2.8.21 — code health & hygiene (lens C, this branch)
