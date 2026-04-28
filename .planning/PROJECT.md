# Ortus GoLogin Clone — LinkedIn Outreach Automation

## What This Is

A LinkedIn outreach automation tool for The Ortus Club, comparable to PhantomBuster and Linked Helper. Uses multiple GoLogin browser profiles to run connection campaigns, follow-up messaging, InMail, and connection status checks against lead lists from Google Sheets. Includes a web dashboard for campaign control and live monitoring.

## Core Value

Operators can run multi-account LinkedIn outreach campaigns reliably and safely — selecting GoLogin profiles, feeding lead lists, and tracking results — without manual browser work.

## Current Milestone: v3.0 Engagement & Intelligence

**Goal:** Extend the outreach automation into a full lifecycle tool — detect replies to sent DMs, and build in Sales Navigator scraping + lead-volume scanning as independent tabs in the app.

**Target features:**
- Check DMs — new campaign mode, per-profile scoping, snippet panel + sheet writeback (design locked in `.planning/notes/v3-phase11-check-dms-design.md`)
- Tab framework — dashboard navigation so Scraper + Scanner land as separate tabs alongside the existing Campaign section
- Ortus City Scanner — port the existing Electron app (`/Users/antoniovarlese/Downloads/ORTUS_SCANNER_CONTEXT.md`) into a tab; Puppeteer-driven Sales Nav city-by-city lead counting
- SN Scraper — Create Saved Search — new tab mode: filter form → Puppeteer applies filters in Sales Nav → saves the search → returns saved-search URL
- SN Scraper — Scrape Saved Search — new tab mode: pick a saved-search URL → paginate → extract leads → CSV/sheet export (reference: `/Users/antoniovarlese/Downloads/ortus-scraper-extension (5).zip`)

## Requirements

### Validated

- ✓ GoLogin profile cycling — launch, connect via Puppeteer, close sequentially — v1.0
- ✓ LinkedIn action detection — connect/message/InMail/status via DOM + Shadow DOM — v1.0
- ✓ Campaign orchestrator — mode-based routing (connect_only, message_only, check_status, connect_and_message, inmail_only, auto) — v1.0
- ✓ Google Sheet read (CSV export) and write-back (Apps Script web app) — v1.0
- ✓ Web dashboard with live polling, profile selection, template editing — v1.0
- ✓ State persistence (processed leads tracking) — v1.0
- ✓ Weekly limit detection, email-required handling, retry logic (3 attempts) — v1.0
- ✓ Open Profile messaging toggle — v1.0
- ✓ Smart DOM settling (MutationObserver) instead of fixed waits — v1.0
- ✓ Connection note personalization with {firstName}, {lastName}, {company}, {title} — v1.0
- ✓ Security lockdown — .env-only secrets, email-based auth, SoO allowlist — v2.0
- ✓ Reliability hardening — async I/O, graceful shutdown, profile health checks — v2.0
- ✓ Operational features — cron-style scheduling, rate-limit config, campaign history, CSV export — v2.0
- ✓ Dashboard UX — template save/load, accurate progress bar, history panel — v2.0
- ✓ Electron desktop packaging — per-user data dir, DMG distribution with First-Time Setup helper — v2.0

### Active

(Defined in REQUIREMENTS.md — v3.0 Engagement & Intelligence scope)

### Out of Scope

- Agent switching (different LinkedIn personas) — out of scope
- Multi-sheet column mapping UI — nice-to-have, deferred
- LinkedIn group messaging — different product surface
- Proxy management — GoLogin handles this internally
- Mobile/responsive dashboard — internal tool, desktop only

## Context

- **Platform**: Node.js (ES modules) + Express + Puppeteer-core + GoLogin SDK
- **GoLogin SDK**: v2.2.8 — manages anti-detect browser profiles
- **Dashboard**: Vanilla JS + CSS, served via Express static
- **State**: JSON file (`data/state.json`) — processed leads, daily counts
- **Sheet integration**: Read via CSV export (public sheets), write via Apps Script web app POST
- **LinkedIn selectors**: Regular DOM + Shadow DOM (interop-outlet) — fragile, needs periodic updates
- **Campaign modes**: connect_only, message_only, check_status, connect_and_message, inmail_only, auto
- **Known working**: All core automation has been tested and is functional

## Constraints

- **Preserve core logic**: Campaign orchestrator, LinkedIn actions, GoLogin launcher, sheet read/write must NOT be modified
- **Runtime**: Node.js with ES modules
- **GoLogin dependency**: SDK v2.2.8, API token required
- **LinkedIn fragility**: DOM selectors break with LinkedIn UI updates — accepted risk
- **No npm additions without justification**: Keep dependencies minimal

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GoLogin SDK for browser profiles | Anti-detect browsers needed for multi-account LinkedIn | ✓ Good |
| Puppeteer-core (not full Puppeteer) | GoLogin provides the browser, only need the protocol layer | ✓ Good |
| element.click() via page.evaluate() | No coordinate/viewport dependencies — works in any zoom/position | ✓ Good |
| CSV export for sheet reading | No Google API auth needed — just public sheet access | ✓ Good |
| Apps Script web app for write-back | Avoids Google Sheets API auth complexity | ✓ Good |
| State in JSON file (not DB) | Simple, sufficient for single-operator use | ⚠️ Revisit if multi-user |
| No framework for dashboard | Vanilla JS keeps it simple, paste-and-go | ✓ Good |
| Preserve core logic in v2.0 | Working automation is the product — don't break it | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-21 — milestone v3.0 Engagement & Intelligence started*
