# Manual Bulk Reply Check — Design

**Status:** Approved. All decisions locked (item 6 resolved 2026-06-25: dry-run ON by default).
**Origin:** `docs/manual-bulk-reply-check-HANDOFF.md` (full context + code pointers).

## Goal
Replace the slow per-lead reply check (`checkProfileDmsPerLead`, `src/linkedin/check-dms.js:689`
— one `/messaging/compose/` page nav per sent lead, ~20s each, name-based direction
detection) with a **manual, observable bulk inbox sweep** that is fast, identity-safe,
full-coverage, and previewable before it ever writes to the sheet.

## Key enabler (already in the codebase)
The cheap bulk path exists, just demoted to the scheduled/legacy route:
- `checkProfileDms()` — `src/linkedin/check-dms.js:212`: one nav to `linkedin.com/messaging/`,
  lets LinkedIn fire its own `messengerConversations` XHR, replays that authenticated
  Voyager call via injected `fetch`.
- `getConversationsPage()` — `src/linkedin/helpers.js:1379` (JSESSIONID→csrf cookie trick).
  `normalizeConversation()` `helpers.js:1443` returns per-conversation: `threadId`,
  `lastActivityAt`, `unreadCount`, `participants[{firstName,lastName,profileUrl}]`,
  `lastMessage{text,actor,deliveredAt}`.
- `fetchNewConversations()` `check-dms.js:154` paginates with a watermark.
- `matchConversationToSheet()` `check-dms.js:116` — currently NAME-based (ambiguous).
- Scheduler entry `src/post-campaign-reply-check.js:160` stays untouched.

No new browser capability — all Voyager fetches run in `page.evaluate` on the linkedin.com
origin, exactly as today.

## Locked decisions
1. Motivation = speed + reliability + coverage, AND must be **manual**.
2. **Manual UX + placement (resolved 2026-06-25):** the feature **is the existing
   "Check DMs" campaign type** (`mode === 'check_dms'`), re-enabled from its current
   greyed "Unavailable" state. There is NO new dashboard card, drawer, or sidebar route.
   Selecting Check DMs in Section I · Campaign Type **always opens the A3 split view** —
   a self-contained mode that takes over the main area (the way Follower Growth /
   Sales Nav Scrape do). A3 = a left list of replies (grouped Campaign replies /
   Unmatched) + a right read pane for the selected reply, with a "Check replies now"
   CTA, the dry-run toggle, and streaming progress. The old per-lead engine behind
   `check_dms` is replaced by the bulk inbox-sweep. The hourly scheduler stays but is
   secondary; manual is the trusted path.
3. **Scope:** campaign-lead replies front and center, PLUS an "unmatched new replies"
   section so nothing is silently dropped.
4. **Matching:** participant URN/profileUrl first (extract slug or `ACwAA…` URN from the
   sheet's profile URL), name only as fallback; if identity can't be resolved confidently
   → route to the unmatched bucket, never guess. Fixes the same-name false-match class.
5. **Drill-in:** preview-only via the `lastMessage` preview the bulk scan already returns.
   ZERO extra tab opens. Operator clicks into LinkedIn themselves for full history.
6. **Write-back:** dry-run toggle **defaults ON** — first runs are read-only/preview,
   showing what WOULD be written. Operator flips dry-run OFF to enable append-to-Replies-tab
   + bump Stage→`Replied`. (Resolved 2026-06-25.)

## Design (3 units)
1. **Inbox sweeper** — reuse/harden `getConversationsPage` + `fetchNewConversations`.
   One `/messaging/` nav per profile; no per-thread opens; preview-only.
2. **Identity-safe matcher** — upgrade `matchConversationToSheet`: URN/profileUrl first,
   name fallback, skip-on-doubt → unmatched bucket. Classify matched campaign reply vs
   unmatched new reply.
3. **Check DMs mode = A3 view + run controller** — re-enable the `check_dms` mode card
   (remove its `disabled` flag); when `mode === 'check_dms'`, render the self-contained
   A3 split panel (hide the normal campaign sections, as Follower Growth does). The
   panel's "Check replies now" CTA calls the sweep route, streams progress, and fills
   the left list / right read pane. Dry-run toggle gates write-back (default ON). The
   existing `/api/check-dms/*` route is repointed to the bulk inbox-sweep engine.

## YAGNI / out of scope
- No thread drill-in for full history. No new scheduler logic (existing one untouched).
- No changes to the send/compose flow.

## Error handling
- Per-profile failures isolated — one bad/rate-limited profile doesn't abort the sweep;
  it's reported in the run summary. Keep the ~20s `waitForFunction` for the lazy XHR but
  surface "couldn't load inbox for profile X" instead of failing silently. Log every
  matched/unmatched/skipped decision for audit.

## Next step
Invoke `writing-plans` to produce the commit-sized implementation plan.
