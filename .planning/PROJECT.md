# Ortus GoLogin Clone — LinkedIn Outreach Automation

## What This Is

A LinkedIn outreach automation tool for The Ortus Club, comparable to PhantomBuster and Linked Helper. Uses multiple GoLogin browser profiles to run connection campaigns, follow-up messaging, InMail, and connection status checks against lead lists from Google Sheets. Includes a web dashboard for campaign control and live monitoring.

## Core Value

Operators can run multi-account LinkedIn outreach campaigns reliably and safely — selecting GoLogin profiles, feeding lead lists, and tracking results — without manual browser work.

## Current Milestone: v2.0 Delivery Hardening

**Goal:** Harden the working automation tool for team delivery — fix security issues, improve reliability, add operational features, and polish the dashboard UX without touching core automation logic.

**Target features:**
- Remove hardcoded secrets, use .env exclusively
- Add basic auth to the Express server
- Convert sync file I/O to async in campaign orchestrator
- Wire template save/load into the dashboard UI
- Fix progress bar and add campaign history persistence
- Deduplicate shared utilities
- Add graceful shutdown with profile cleanup
- Campaign scheduling (cron-style)
- CSV export of campaign results
- Profile health check before campaign start
- Configurable rate-limit safety (daily/hourly caps, randomized delays)

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

### Active

(Defined in REQUIREMENTS.md — v2.0 Delivery Hardening scope)

### Out of Scope

- Sales Navigator URL support — different DOM selectors, deferred to v3.0
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
*Last updated: 2026-04-09 after milestone v2.0 started*
