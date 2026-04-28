---
title: v3 Phase 11 — Check DMs Design Decisions
date: 2026-04-21
context: Captured from /gsd-explore session before formalizing v3.0 milestone
status: design-locked
---

# Check DMs — Design Decisions (Phase 11 of v3.0)

## Core behavior

New campaign mode `check_dms` that scans LinkedIn DMs for replies to prospects we previously messaged, and surfaces new replies in the dashboard + sheet.

## Locked decisions

### Trigger model
- **Manual, on-demand.** Button in the Campaign section ("Check DMs"). No cron, no auto-run after send campaigns, no background monitor.
- Rationale: operators described this as a "morning ritual" — they want conscious triage, not passive notifications.

### Per-profile scoping
- Each GoLogin profile only checks its own sent DMs. When operator clicks "Check DMs" with Antonio's profile selected, we only look at sheet rows where:
  - `Message = "sent"` AND
  - `Account Used = Antonio`
- Rationale: matches how campaigns already run (round-robin per profile, `accountUsed` tracked per row). Respects account cookie separation — no cross-contamination.
- Multi-account: operator can select multiple profiles before clicking; we iterate sequentially like existing campaign round-robin.

### Detection method
- **Primary:** LinkedIn Voyager API `/voyager/api/messaging/conversations` — same authenticated-JSON pattern we already use in `src/linkedin/helpers.js` for degree-badge checks.
  - Returns paginated list: participant URN/name, last message preview, direction, unread flag, timestamp.
- **Fallback:** DOM scrape of `linkedin.com/messaging/` inbox list — if Voyager tightens access or returns a structural change.
- Rationale: Voyager is faster, no selector fragility, already battle-tested in this codebase. Scraper is the escape hatch.

### Match logic (LinkedIn conversation → sheet row)
- Fuzzy match conversation participant's first + last name against `firstName`+`lastName` on candidate rows (already filtered to "this profile's sent DMs").
- Tiebreak by LinkedIn URL if present on the sheet row (we store it during campaigns).
- Unmatched conversations: logged but not surfaced (they're likely personal contacts, not campaign leads).

### Delta semantics — "only new replies since last run"
- Track `last_check_at` per profile in local state (suggested: `data/check-dms-state.json`, keyed by profile name).
- On each run, only surface replies where LinkedIn's `last_message_at` > this profile's `last_check_at`.
- Update `last_check_at` to the run's start time only after a successful scan completes (don't advance on partial failure).
- First-ever run per profile: show all replies (no watermark yet).

### Output — UI
- New "Replies" panel in the Campaign section, populated when the check finishes.
- Each row shows: prospect name, last message snippet (~80–100 chars from Voyager payload), timestamp, "Open Thread" button.
- "Open Thread" opens `linkedin.com/messaging/thread/{threadId}` via `shell.openExternal` (system browser, not inside the Electron window) — keeps LinkedIn's cookie state intact.

### Output — sheet writeback
- New columns (auto-added via `ensureTrackingColumns` pattern already used for Status/OP/Message/etc):
  - `Reply` — "yes" / empty
  - `Reply At` — ISO timestamp of the reply
  - `Reply Preview` — first ~100 chars of the reply
- Non-destructive: if row already has `Reply="yes"` from a prior run, don't overwrite (operator may have edited).

### Explicitly deferred to later phases or seeds
- **Full-thread text fetch** — only shows inbox-list snippet in v1. Upgrade path captured in seed `.planning/seeds/check-dms-full-thread-upgrade.md`.
- **Auto-responder filtering** — "Thanks for connecting!" autoresponders will pollute the panel until filtered. Seed: `.planning/seeds/check-dms-auto-responder-filter.md`.
- **"Handled in our app" state** — considered and rejected. Rationale: LinkedIn's own read/unread state would drift from ours within a day; two sources of truth = trust neither. Let LinkedIn own read-state.
- **Auto follow-up on replies** — not in scope. Operator decides how to respond, in LinkedIn.
- **Notifications** (email/push) — not in scope for v1.

## Rate limiting
- Apply existing per-action delays if Voyager shows signs of throttling (empirically, degree-badge checks hit it occasionally). One API call per page of conversations — volumes should be low.

## Open questions tracked (non-blocking for Phase 11)
- Multiple threads with the same participant name — how to disambiguate before we have a stored LinkedIn URL. For now: if sheet row has URL, match on that; otherwise match on first+last and accept that collisions will be rare enough for v1.
- Storage location for `last_check_at` — leaning `data/check-dms-state.json` next to existing state files.

## Upstream plumbing (already in place — confirmed via code read)
- `Account Used` column written per-row in `src/campaign.js` on every message send — this IS the per-profile scoping key.
- `ensureTrackingColumns` in `src/sheets-writer.js` auto-adds new tracking columns — extend to include `Reply`, `Reply At`, `Reply Preview`.
- Voyager authenticated-JSON call pattern already exists (used for 1st-degree badge detection).
