# Phase 6: SMS Follow-Up & Scheduling - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Add automatic SMS follow-up via Twilio when calls hit voicemail/no-answer/AI gatekeeper. Add configurable SMS templates in the sidebar. Add opt-in auto-callback scheduling with max 1 retry per prospect.

</domain>

<decisions>
## Implementation Decisions

### SMS Triggers
- **D-01:** Auto-send follow-up SMS when call outcome is: Voicemail, No Answer, or AI Gatekeeper.
- **D-02:** Do NOT send SMS on: Declined, Busy, Hung Up, Callback, or Interested outcomes.
- **D-03:** SMS is triggered automatically after the call results are fetched (inside `fetchLatestResults` or the poll trigger), not manually.

### SMS Content
- **D-04:** SMS templates are configurable from the sidebar — operator can edit the message before batch submission.
- **D-05:** Add a "SMS Template" textarea field in the sidebar, pre-populated with a default template that includes dynamic variables: {{prospect_name}}, {{host_first_name}}, {{event_name}}, {{event_date}}.
- **D-06:** Default template example: "Hi {{prospect_name}}, {{host_first_name}} from The Ortus Club tried to reach you about {{event_name}} on {{event_date}}. Please check your email for the invite details or reply to this text."

### Twilio Setup
- **D-07:** Use Twilio REST API directly from Google Apps Script via UrlFetchApp.
- **D-08:** SMS sent FROM the same number (+1 617 600 0320) — same number that called them.
- **D-09:** Twilio Account SID and Auth Token hardcoded in the CONFIG object at the top of the file (matching existing pattern for API key).
- **D-10:** Twilio API endpoint: `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json` with Basic auth (AccountSid:AuthToken).

### Callback Scheduling
- **D-11:** Opt-in auto-callback: add a toggle in the sidebar "Auto-schedule callbacks" (default OFF).
- **D-12:** When toggled ON and a call outcome is "Callback" with a `callback_when` value, automatically submit a new 1-person batch call scheduled for the requested time.
- **D-13:** Max 1 auto-callback per prospect — if the same person requests a callback again on the retry call, do NOT auto-schedule another. Track this with a "Callback Sent" column or flag.
- **D-14:** The auto-scheduled call uses the same event variables from the original batch.

### Implementation Approach
- **D-15:** SMS sending function: `sendFollowUpSms(phoneNumber, message)` using Twilio REST API.
- **D-16:** SMS template variable replacement happens server-side before sending — replace {{prospect_name}}, {{host_first_name}}, etc. with actual values from the batch call eventVars.
- **D-17:** Add "SMS Sent" column to track which leads received an SMS (prevent duplicate sends).
- **D-18:** Add SMS-related fields to sidebar: SMS template textarea, auto-callback toggle.

### Claude's Discretion
- Exact sidebar placement of SMS template and auto-callback toggle
- Error handling for Twilio API failures (log error, don't block the rest of the flow)
- How to parse "in 10 minutes" / "in like twenty minutes" into a scheduled timestamp

</decisions>

<canonical_refs>
## Canonical References

### Source Code
- `elevenlabs-apps-script.js` — Key areas:
  - CONFIG object (line ~32): add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
  - CALL_TRACKING_COLUMNS: add "SMS Sent", "Callback Sent"
  - `fetchLatestResults()`: trigger SMS after writing outcome
  - `submitBatchCall()`: reference for submitting auto-callback batch
  - `getSidebarHtml()`: add SMS template textarea + auto-callback toggle

### Twilio API
- Endpoint: `POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`
- Auth: Basic (AccountSid:AuthToken)
- Body: `To`, `From`, `Body` (form-urlencoded)
- From number: +16176000320

### Prior Phases
- Phase 4: data_collection returns `callback_requested` and `callback_when`
- Phase 5: `fetchLatestResults` fetches outcomes and writes to sheet

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `UrlFetchApp.fetch()` for HTTP calls (used throughout for ElevenLabs API)
- `submitBatchCall(eventVars)` — can be called to auto-schedule callback
- `PropertiesService.getScriptProperties()` — could store SMS template defaults
- `CALL_TRACKING_COLUMNS` array — extend with SMS/callback tracking

### Established Patterns
- CONFIG object for hardcoded credentials
- `ensureCallColumnsOnSheet()` for adding new columns
- `google.script.run` for sidebar-to-server communication
- `getSidebarHtml()` single-quoted string with backslash continuations (NO // comments, NO single quotes in JS)

### Integration Points
- `fetchLatestResults()` — add SMS trigger after writing outcome
- `submitBatchCall()` — reuse for auto-callback submission
- Sidebar HTML — add SMS template + toggle below the existing form

</code_context>

<specifics>
## Specific Ideas

- Twilio Basic auth in GAS: `Utilities.base64Encode(accountSid + ':' + authToken)` in Authorization header
- SMS body is form-urlencoded, not JSON: `To=+phone&From=+16176000320&Body=message`
- For callback time parsing: "in 10 minutes" → `new Date(Date.now() + 10*60*1000)`, convert to Unix timestamp for `scheduled_time_unix`
- The sidebar already saves form defaults — SMS template can be saved the same way

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-sms-follow-up-and-scheduling*
*Context gathered: 2026-04-01*
