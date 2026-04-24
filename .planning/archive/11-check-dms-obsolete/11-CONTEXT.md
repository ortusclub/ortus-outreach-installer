# Phase 11: Check DMs — Context

**Gathered:** 2026-04-21
**Status:** Ready for planning
**Source:** Promoted from `.planning/notes/v3-phase11-check-dms-design.md` (design locked via `/gsd-explore` session)

<domain>
## Phase Boundary

Deliver a new **manual, on-demand `check_dms` campaign mode** that scans LinkedIn DMs for replies to prospects previously messaged by the selected GoLogin profile(s), and surfaces new replies in the dashboard (Replies panel) + writes back to the Google Sheet.

**In scope:**
- New "Check DMs" button inside the existing Campaign section (no tab-framework dependency — that's Phase 12)
- Per-profile scoping: scan only rows where `Message="sent"` AND `Account Used` matches the running profile
- Voyager API primary detection path + DOM scrape fallback
- Per-profile `last_check_at` watermark for "only new replies since last run"
- Replies panel in the dashboard with prospect name, snippet, timestamp, "Open Thread" (external browser)
- Sheet writeback: auto-add `Reply`, `Reply At`, `Reply Preview` columns; non-destructive
- Clear error surfacing when Voyager fails and fallback is attempted

**Out of scope (explicitly deferred — see `<deferred>` block):**
- Full-thread text fetch beyond inbox snippet
- Auto-responder filtering
- Auto follow-up on replies
- Email/push notifications
- "Handled in our app" read-state tracking (let LinkedIn own read-state)
- Tab framework (Phase 12)

</domain>

<decisions>
## Implementation Decisions

### Trigger model
- **Manual, on-demand.** Button in the Campaign section labeled "Check DMs". No cron, no auto-run after send, no background monitor.
- Rationale: operators treat this as a "morning ritual" — conscious triage, not passive notifications.

### Per-profile scoping
- Each GoLogin profile only checks its own sent DMs. Scan rows where:
  - `Message = "sent"` AND
  - `Account Used = <running profile name>`
- Multi-profile: operator can select multiple profiles before clicking; iterate sequentially (same pattern as existing campaign round-robin in `src/campaign.js`).
- No cross-contamination: Antonio's profile never checks Patricia's rows.

### Detection method
- **Primary:** LinkedIn Voyager API `GET /voyager/api/messaging/conversations` — authenticated JSON call via the same pattern already used in `src/linkedin/helpers.js` and `src/linkedin/outreach.js` (degree-badge checks).
  - Returns paginated list of conversations: participant URN/name, last message preview, direction, unread flag, timestamp (`lastActivityAt` / `events[].createdAt`).
  - One API call per page; pagination via `start` + `count` params or `createdBefore` cursor (researcher must confirm exact shape).
- **Fallback:** DOM scrape of `linkedin.com/messaging/` inbox list — triggered when Voyager returns non-2xx or structurally invalid payload.
- Rationale: Voyager is faster, no selector fragility, already battle-tested in the codebase. Scrape is the escape hatch.

### Match logic (LinkedIn conversation → sheet row)
- Fuzzy match conversation participant's **first + last name** (case-insensitive, trim whitespace) against `firstName` + `lastName` columns on candidate rows (already filtered to "this profile's sent DMs").
- Tiebreak by LinkedIn URL if present on the sheet row (the campaign stores LinkedIn URL during sends).
- Unmatched conversations: log (for debugging) but do NOT surface in the Replies panel (they're likely personal contacts, not campaign leads).

### Delta semantics — "only new replies since last run"
- Persist `last_check_at` per GoLogin profile in a new local state file: `{ORTUS_DATA_DIR}/data/check-dms-state.json`, keyed by profile name.
  - Example: `{ "Antonio": "2026-04-21T08:00:00.000Z", "Patricia": "2026-04-20T14:30:00.000Z" }`
- On each run: only surface replies where LinkedIn's last-message timestamp > that profile's `last_check_at`.
- Update `last_check_at` to the **run's start time** only AFTER a successful scan completes (don't advance on partial failure — operator must be able to retry and not lose replies).
- First-ever run per profile (no watermark yet): show ALL replies.

### Output — UI (dashboard)
- New "Replies" panel in the Campaign section (vanilla JS + CSS, served via Express static), populated when the check finishes.
- Each row shows:
  - Prospect name (`firstName lastName`)
  - Last message snippet (first ~80–100 chars from the Voyager payload)
  - Timestamp (formatted relative, e.g., "2h ago")
  - "Open Thread" button
- "Open Thread" opens `https://www.linkedin.com/messaging/thread/{threadId}/` via **`shell.openExternal`** (system browser — NOT inside the Electron window). This keeps LinkedIn's cookie state intact and avoids auth loops inside Electron.

### Output — sheet writeback
- New auto-added columns (via `ensureTrackingColumns` pattern in `src/sheets-writer.js`):
  - `Reply` — `"yes"` or empty
  - `Reply At` — ISO timestamp of the reply (e.g., `2026-04-21T09:15:00.000Z`)
  - `Reply Preview` — first ~100 chars of the reply
- **Non-destructive**: if row already has `Reply="yes"` from a prior run, do NOT overwrite (operator may have manually edited `Reply At` or `Reply Preview`).
- Apps Script write-back goes through the existing webapp POST pattern (no new Apps Script endpoint needed — extend the existing writer).

### Error handling
- If Voyager returns non-2xx: log the status + URL, attempt DOM-scrape fallback.
- If fallback also fails: write an error line to the Replies panel (e.g., "Check DMs failed for profile Antonio: Voyager 429; fallback also failed. Watermark NOT advanced — retry later.") — operator is never left wondering whether the scan ran.
- Do NOT advance `last_check_at` on partial/complete failure.

### Rate limiting
- Apply existing per-action delays (see current Voyager pattern in `src/linkedin/helpers.js`) if signs of throttling appear.
- One API call per page of conversations; volumes per profile expected to be low (< 5 pages).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design note (source of truth)
- `.planning/notes/v3-phase11-check-dms-design.md` — design-locked decisions (this CONTEXT.md is a promotion, but keep the original as the history record)

### Existing Voyager pattern (reference implementation)
- `src/linkedin/helpers.js` — authenticated Voyager JSON call pattern used for degree-badge checks. **The new `/voyager/api/messaging/conversations` call MUST follow this same auth/header/error-handling pattern.**
- `src/linkedin/outreach.js` — also uses Voyager; confirms the shape reuse

### Sheet writeback pattern
- `src/sheets-writer.js` — contains `ensureTrackingColumns` helper for auto-adding columns. **Extend this to include `Reply`, `Reply At`, `Reply Preview`.**
- `src/campaign.js` — writes `Account Used` per row on send; this is the per-profile scoping key

### State persistence pattern
- Per-user data dir via `ORTUS_DATA_DIR` (set in Electron `main.js` to `app.getPath('userData')/data`). The new `check-dms-state.json` MUST live inside this dir, co-located with existing state files.
- `src/paths.js` — the helper that resolves state-file paths

### Launcher / profile cycling
- `src/gologin-launcher.js` — how GoLogin profiles are launched
- `src/campaign.js` — round-robin profile iteration pattern; "Check DMs" SHOULD NOT duplicate this — call into the same helpers to open each profile sequentially

### Dashboard integration
- `public/js/app.js` — existing campaign controls, polling loop, template save/load; "Check DMs" button + Replies panel must fit this file's patterns
- `public/index.html` — existing Campaign section markup
- `public/css/style.css` — current styling (monochrome "command deck" aesthetic — do NOT introduce colored backgrounds or new fonts)

### Electron shell
- `electron/main.js` (or equivalent) — `shell.openExternal` import for "Open Thread" button

### Requirements
- `.planning/REQUIREMENTS.md` — DMS-01 through DMS-07

### Seeds (DO NOT implement, but cite)
- `.planning/seeds/check-dms-full-thread-upgrade.md` — future upgrade path
- `.planning/seeds/check-dms-auto-responder-filter.md` — future filter

</canonical_refs>

<specifics>
## Specific Ideas

### Exact endpoint (primary)
- `GET https://www.linkedin.com/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=search&...`
  - The researcher MUST verify the exact query shape (LinkedIn has multiple variants — `q=search`, `q=participants`, plus the newer `/messaging/conversationsV2` endpoint). Pick the one that returns "all conversations sorted by last-message time" without requiring a specific participant filter.

### Exact thread URL format
- `https://www.linkedin.com/messaging/thread/{threadId}/`
  - `threadId` comes from the Voyager payload's `entityUrn` (e.g., `urn:li:fs_conversation:2-ZDdkM2M0MDUt...`) — strip the prefix to `2-ZDdkM2M0MDUt...`

### State-file shape
```json
{
  "Antonio": { "last_check_at": "2026-04-21T08:00:00.000Z" },
  "Patricia": { "last_check_at": "2026-04-20T14:30:00.000Z" }
}
```

### Dashboard polling
- Reuse the existing Express polling endpoint pattern (used for campaign status). "Check DMs" progress should be pollable: `GET /check-dms/status` returning `{ running, currentProfile, repliesFound, errors }`.

### Multi-profile iteration
- When operator selects profiles `[Antonio, Patricia]` and clicks Check DMs:
  1. Launch GoLogin profile "Antonio" → run Voyager scan → close profile
  2. Launch GoLogin profile "Patricia" → run Voyager scan → close profile
  3. Aggregate results in the Replies panel (grouped by profile OR interleaved by timestamp — pick one, consistent with existing campaign summary pattern)

</specifics>

<deferred>
## Deferred Ideas (NOT this phase)

### Captured as seeds (trigger-based future work)
- **Full-thread text fetch** — only show inbox-list snippet in v1. Upgrade path captured in `.planning/seeds/check-dms-full-thread-upgrade.md`. Trigger: operators click "Open Thread" > ~50% of the time.
- **Auto-responder filtering** — "Thanks for connecting!" autoresponders will pollute the panel until filtered. Seed: `.planning/seeds/check-dms-auto-responder-filter.md`. Trigger: > ~30% of surfaced replies are auto-generated.

### Considered and rejected
- **"Handled in our app" read-state tracking** — rejected. LinkedIn's own read/unread state would drift from ours within a day; two sources of truth = trust neither. Let LinkedIn own read-state.
- **Auto follow-up on replies** — not in scope. Operator decides how to respond, inside LinkedIn.
- **Email/push notifications** — morning-ritual model makes this unnecessary.

### Phase boundary clarifications
- **Tab framework** (Phase 12) — Check DMs does NOT depend on the tab bar. Lives inside the existing Campaign section. If a future phase wraps it in a tab, it's a mechanical wrap, not a redesign.

</deferred>

<open_questions>
## Open Questions (non-blocking — researcher should resolve)

1. **Exact Voyager endpoint + query params** — `/voyager/api/messaging/conversations` vs `/messaging/conversationsV2` vs some other variant. Which one is authoritative as of 2026-04? What pagination shape (cursor vs offset)?
2. **Auth headers** — the existing `src/linkedin/helpers.js` pattern likely sets `csrf-token`, `x-restli-protocol-version: 2.0.0`, and cookies. Researcher must confirm the complete header set needed for the messaging endpoint specifically.
3. **Pagination stop condition** — once a page's messages are all older than `last_check_at`, can we short-circuit and stop paginating? (Presumably yes if results are sorted by `lastActivityAt DESC`.)
4. **Name collision** — multiple conversations with the same `firstName lastName` when no LinkedIn URL is stored on the row. Strategy: log and skip (accept the collision is rare for v1), or prompt the operator to disambiguate? Decision leaning: log + skip + surface a "? ambiguous" row in the panel so operator sees it.

</open_questions>

---

*Phase: 11-check-dms*
*Context gathered: 2026-04-21 — promoted from design note*
