# Phase 5: Reporting & Sheet Integration - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Automatically fetch detailed post-call data from ElevenLabs (transcripts, summaries, recordings, data collection results, duration) and write it to the Google Sheet with color-coded outcomes and icons. No new sidebar UI beyond what's needed for the auto-fetch trigger.

</domain>

<decisions>
## Implementation Decisions

### Sheet Columns
- **D-01:** Add these new columns to the sheet (in addition to existing Call Status, Call Date, Call Duration, Call Batch ID, Call Notes):
  - **Outcome** — from data_collection: Interested / Busy / Declined / Gatekeeper / Callback
  - **Call Type** — from data_collection: Spoke to Human / Voicemail / No Answer / Number Failed / AI Gatekeeper / Hung Up
  - **Summary** — AI-generated transcript summary (1-2 sentences from `analysis.transcript_summary`)
  - **Transcript** — Full conversation transcript formatted as "User: ... / Agent: ..." in a single cell
  - **Recording** — Clickable hyperlink to download the call recording MP3
  - **Follow Up** — from data_collection: resend / bump / none
  - **Callback** — from data_collection: callback_requested + callback_when
  - **Email Confirmed** — from data_collection: prospect_email_confirmed
  - **Seen Invite** — from data_collection: has_seen_invite (true/false/null)

### Data Format
- **D-02:** Everything in the main sheet — no separate tabs. Full transcript in a cell (may be long, but operator wants single-tab view).
- **D-03:** Transcript format: each turn on a new line within the cell — "User: Hello\nAgent: Hi, this is Sarah..." using newlines within the cell.
- **D-04:** Recording link as a clickable hyperlink in the cell. The recording URL is `https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/audio` with the API key as header — but this won't work as a direct link. Instead, create a Google Drive or store a temporary URL. Alternative: use a formula-based link or note that the recording needs the API key to access.

### Refresh Trigger
- **D-05:** Automated — fetch results as soon as calls complete. Enhance the existing `pollBatchStatus` trigger (runs every 5 min) to also fetch detailed per-call results (transcript, summary, recording, data collection) when a call status changes to done/completed.
- **D-06:** The existing `updateSheetWithCallResults()` function already fetches basic per-call data. Enhance it to also call `GET /v1/convai/conversations/{conversation_id}` for each completed call to get the full detail.

### Visual Design
- **D-07:** Color-coded cells with emoji icons on the Outcome column:
  - ✅ Interested — green background (#e8f5e9)
  - 🗣 Callback — yellow background (#fff3e0)
  - ⏳ Busy — yellow background (#fff3e0)
  - ❌ Declined — red background (#fce4ec)
  - 📧 Voicemail — gray background (#f5f5f5)
  - ☎️ No Answer — gray background (#f5f5f5)
  - 🤖 AI Gatekeeper — blue background (#e3f2fd)
  - ⚠️ Number Failed — red background (#fce4ec)
- **D-08:** Apply colors via Apps Script `setBackground()` when writing results — not conditional formatting rules (more reliable, works with custom values).

### Implementation Approach
- **D-09:** Modify existing `updateSheetWithCallResults()` to fetch full conversation detail per call.
- **D-10:** Add new columns via `ensureCallColumnsOnSheet()` — extend the CALL_TRACKING_COLUMNS array.
- **D-11:** Recording URL: since it requires the API key header, generate a short-lived signed URL or just store the conversation_id and let operators use a "Play Recording" button in the sidebar (Phase 3 already has audio playback infrastructure). Claude's discretion on the best approach.

### Claude's Discretion
- Exact column ordering
- How to handle the recording link (direct URL with API key in query param vs conversation ID reference)
- Whether to truncate very long transcripts in the cell
- Error handling for calls that have no transcript yet (still in progress)

</decisions>

<canonical_refs>
## Canonical References

### Source Code
- `elevenlabs-apps-script.js` — Key areas:
  - `updateSheetWithCallResults()` — existing function to enhance
  - `ensureCallColumnsOnSheet()` — adds tracking columns
  - `checkBatchStatus()` / `pollBatchStatus()` — existing auto-poll
  - `CALL_TRACKING_COLUMNS` array — defines which columns exist
  - `mapCallStatus()` — maps API statuses to display values

### ElevenLabs API (verified in Phase 4)
- `GET /v1/convai/conversations/{id}` — returns transcript, analysis, metadata, has_audio
- `GET /v1/convai/conversations/{id}/audio` — returns MP3 recording (1.3MB typical)
- `analysis.data_collection_results` — 7 structured fields from data collection
- `analysis.transcript_summary` — AI-generated summary
- `analysis.call_successful` — success/failure classification
- `metadata.call_duration_secs` — call duration
- `metadata.termination_reason` — how call ended

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `elevenlabsGet()` — API GET helper (prepends /v1)
- `getHeaders()` / `findColumnIndex()` — sheet column utilities
- `normalizePhone()` — phone number matching
- `mapCallStatus()` — status string mapping
- Phase 3 audio playback infrastructure (getVoicePreview pattern)

### Integration Points
- `updateSheetWithCallResults(batchId, apiKey)` — main function to enhance
- `pollBatchStatus()` — triggers updateSheetWithCallResults when batch is done
- `CALL_TRACKING_COLUMNS` — extend with new column names

</code_context>

<specifics>
## Specific Ideas

- The conversation detail API returns `transcript` as an array of `{role, message, time_in_call_secs}` objects — need to format into readable string
- `data_collection_results` is a dict with field names as keys — map to sheet columns
- Colors should be applied per-cell via `setBackground()` not conditional formatting
- The `conversation_id` is available per call from the batch conversations endpoint

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-reporting-and-sheet-integration*
*Context gathered: 2026-04-01*
