---
phase: 05-reporting-and-sheet-integration
plan: 01
subsystem: api, sheet-integration
tags: [elevenlabs, google-apps-script, conversation-api, transcripts, reporting]

requires:
  - phase: 04-agent-intelligence
    provides: Data collection fields configured on agent (outcome, call_type, follow_up_action, etc.)
provides:
  - 9 new tracking columns populated per completed call
  - getConversationDetail, formatTranscript, buildRecordingUrl, extractDataCollection helpers
  - Enhanced updateSheetWithCallResults with full conversation detail fetch
  - Enhanced handleCallWebhook with opportunistic detail fetch
affects: [05-02, sheet-ui, reporting]

tech-stack:
  added: []
  patterns: [per-call detail fetch after batch poll, skip-if-already-fetched optimization, HYPERLINK formula for recordings]

key-files:
  created: []
  modified: [elevenlabs-apps-script.js]

key-decisions:
  - "Skip detail fetch when transcript cell already populated to avoid redundant API calls"
  - "Recording URL written as HYPERLINK formula since audio endpoint requires xi-api-key header"
  - "Callback field combines callback_requested and callback_when into single readable string"

patterns-established:
  - "Detail fetch pattern: batch poll updates status, then fetches per-conversation detail for completed calls only"
  - "Column guard pattern: every setValue/setFormula checks index !== -1 before writing"

requirements-completed: [RPT-01, RPT-02, RPT-03, RPT-04, RPT-05, RPT-06]

duration: 2min
completed: 2026-04-01
---

# Phase 05 Plan 01: Fetch Conversation Detail and Populate Reporting Columns Summary

**9 new sheet columns (Outcome, Call Type, Summary, Transcript, Recording, Follow Up, Callback, Email Confirmed, Seen Invite) auto-populated from ElevenLabs conversation detail API after each completed call**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-01T08:41:49Z
- **Completed:** 2026-04-01T08:43:43Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Extended CALL_TRACKING_COLUMNS from 5 to 14 entries with 9 new reporting columns
- Built 4 helper functions: getConversationDetail, formatTranscript, buildRecordingUrl, extractDataCollection
- Enhanced updateSheetWithCallResults to fetch full conversation detail per completed call and write all 9 new columns
- Enhanced handleCallWebhook with opportunistic detail fetch when conversation_id is present in webhook payload
- Transcript formatted as multi-line Agent/User turns in a single cell
- Recording column uses HYPERLINK formula pointing to conversation audio endpoint

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend CALL_TRACKING_COLUMNS and add helper functions** - `87f4a80` (feat)
2. **Task 2: Enhance updateSheetWithCallResults and handleCallWebhook** - `103d1ce` (feat)

## Files Created/Modified
- `elevenlabs-apps-script.js` - Extended with 9 new tracking columns, 4 helper functions, enhanced batch result update and webhook handler

## Decisions Made
- Skip detail fetch when transcript cell already populated -- avoids redundant API calls on subsequent polls
- Recording URL written as HYPERLINK formula since the audio endpoint requires the xi-api-key header (cannot be a direct playable link)
- Callback field combines callback_requested ("true"/"false") and callback_when into a single readable string like "Yes - next Tuesday" or "No"
- Data collection field mapping uses safe extraction with empty string defaults for missing keys

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. Copy updated `elevenlabs-apps-script.js` to the Apps Script editor.

## Next Phase Readiness
- All 14 tracking columns are now managed by CALL_TRACKING_COLUMNS and auto-created via ensureCallColumnsOnSheet
- Ready for Plan 02 (sheet UI formatting/polish) which can style these new columns
- Recording links will work once user accesses them with API key in headers

---
*Phase: 05-reporting-and-sheet-integration*
*Completed: 2026-04-01*
