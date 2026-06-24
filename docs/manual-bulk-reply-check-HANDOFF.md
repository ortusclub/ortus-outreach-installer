# Manual Bulk Reply Check — Handoff

Context to resume this work in another tab/session. This is a DESIGN, approved in
principle — not yet implemented. Resume by re-reading this, then go to `writing-plans`.

## The problem
Production reply detection (`checkProfileDmsPerLead`, `src/linkedin/check-dms.js:689`)
opens `/messaging/compose/?recipient=<publicId>` and DOM-scrapes — **one full page
navigation per sent lead, ~20s each**. Slow, rate-limit-prone, hard to test, and
name-based direction detection. Goal: make reply-checking fast, observable, identity-safe,
full-coverage, and **manual**.

## Key finding: the cheap path already exists
A bulk inbox scan is ALREADY in the codebase, just demoted to the legacy/scheduled path:
- `checkProfileDms()` — `src/linkedin/check-dms.js:212`. Navigates ONCE to
  `linkedin.com/messaging/`, lets LinkedIn fire its own `messengerConversations` XHR,
  then replays that authenticated Voyager GraphQL call via injected `fetch`.
- `getConversationsPage()` — `src/linkedin/helpers.js:1379` (uses JSESSIONID→csrf-token
  cookie trick, same as the HS extension). `normalizeConversation()` `helpers.js:1443`
  returns per-conversation: `threadId`, `lastActivityAt`, `unreadCount`,
  `participants[{firstName,lastName,profileUrl}]`, `lastMessage{text,actor,deliveredAt}`.
- `fetchNewConversations()` `check-dms.js:154` paginates with a watermark.
- `matchConversationToSheet()` `check-dms.js:116` — currently matches by NAME (ambiguous).
- Scheduler entry: `src/post-campaign-reply-check.js:160` → `scanRepliesForProfile` →
  legacy `checkProfileDms`.
- Engine: puppeteer-core; all Voyager fetches run inside `page.evaluate` on the
  linkedin.com origin, so bulk API polling is the existing mechanism, not new capability.

## Decisions made (locked)
1. **Motivation = all of speed + reliability + coverage**, AND it must be **manual**.
2. **Manual UX:** one button "Check replies now" → sweeps all active profiles once and
   stops, with a **visible/streaming run** (which profile, conversations scanned, replies
   found) so it can finally be tested/trusted. Keep the hourly scheduler too, but manual
   is the primary trusted path.
3. **Scope = C:** campaign-lead replies front and center, PLUS an "unmatched new replies"
   section so nothing is silently dropped.
4. **Matching = A + skip-on-doubt:** match on participant URN/profileUrl first
   (extract slug or `ACwAA…` URN from the sheet's profile URL), name only as fallback;
   if identity can't be resolved confidently, route to the unmatched bucket — never guess.
   (Fixes the same-name false-match class that's bitten CC+IC.)
5. **Drill-in = (i) preview-only.** Use the `lastMessage` preview the bulk scan already
   returns. ZERO extra tab opens. (User clicks into LinkedIn themselves for full history.)
6. **Write-back:** lean = ON but with a **dry-run toggle defaulting ON** (read-only until
   trusted), then flip off to append Replies tab + bump Stage→`Replied`.
   >>> THIS IS THE ONE OPEN ITEM the user hadn't final-confirmed when we paused. <<<

## Design (3 units)
1. **Inbox sweeper** — reuse/harden `getConversationsPage`+`fetchNewConversations`.
   One `/messaging/` nav per profile; no per-thread opens; preview-only.
2. **Identity-safe matcher** — upgrade `matchConversationToSheet`: URN/profileUrl first,
   name fallback, skip-on-doubt → unmatched bucket. Classify: matched campaign reply vs
   unmatched new reply.
3. **Manual run controller + results view** — new button + server route + UI panel.
   Sweeps active profiles sequentially, streams progress. Two result sections (campaign /
   unmatched). Dry-run toggle gates write-back.

## YAGNI / out of scope
- No thread drill-in for full history. No new scheduler logic (existing one untouched).
- No changes to send/compose flow.

## Error handling
- Per-profile failures isolated (one bad/rate-limited profile doesn't abort the sweep;
  reported in run summary). Keep the ~20s waitForFunction for the lazy XHR but surface
  "couldn't load inbox for profile X" instead of failing silently. Log every
  matched/unmatched/skipped decision for audit.

## Next step when resuming
Confirm the write-back/dry-run default (item 6), then invoke the `writing-plans` skill to
produce the implementation plan. Design doc would land at
`docs/superpowers/specs/YYYY-MM-DD-manual-bulk-reply-check-design.md`.
