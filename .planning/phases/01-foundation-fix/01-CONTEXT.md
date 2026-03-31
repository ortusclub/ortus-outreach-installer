# Phase 1: Foundation Fix - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Deploy the existing variable mapping fix to the Google Apps Script editor, enable TTS override in the ElevenLabs agent Security settings, and audit the agent prompt to ensure all 14 dynamic variables are referenced. Verify with a real test call.

</domain>

<decisions>
## Implementation Decisions

### Deployment Method
- **D-01:** Deploy the fixed code to Apps Script editor via browser paste using computer-use/Chrome tools (open editor → Cmd+A → delete → paste from clipboard → Cmd+S). No Apps Script API setup needed.
- **D-02:** No redeployment step needed — sidebar uses HEAD deployment, so saving the code makes it live.

### Variable Audit
- **D-03:** All 14 dynamic variables are required for every call — no optional fields. The sidebar must eventually enforce this (Phase 3 VARS-04 handles validation).
- **D-04:** The 14 variables are: caller_name, host_name, host_first_name, event_name, event_date, event_time, event_city, event_area, event_venue, event_format, event_context, target_audience, prospect_name, prospect_email.

### Agent Prompt Audit
- **D-05:** Use ElevenLabs API to GET the current agent config (`GET /v1/convai/agents/{agent_id}`), check which variables are referenced in the prompt template, and PATCH any missing ones in (`PATCH /v1/convai/agents/{agent_id}`).
- **D-06:** Agent ID: `agent_5601kmzey4mve8pswpwvmhckcgnr`, Branch ID: `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`.

### Dashboard Prerequisites
- **D-07:** Enable TTS override in the ElevenLabs agent Security settings via the dashboard UI. This is a manual step — navigate to agent settings, find Security tab, toggle TTS override on.

### Testing
- **D-08:** Verify with a real test call — submit a 1-recipient batch to user's phone number with all 14 variables filled in.
- **D-09:** Success = the agent greets the prospect using the correct host name, event name, and other sidebar-entered event details.

### Claude's Discretion
- Exact order of operations (deploy code first, then audit prompt, then test)
- How to structure the API calls for prompt audit
- Error handling approach if API calls fail

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code
- `elevenlabs-apps-script.js` — The complete Apps Script source with the variable mapping fix (lines 182-201 have the correct `conversation_initiation_client_data.dynamic_variables` nesting)

### Research
- `.planning/research/STACK.md` — API endpoints, request/response formats, Apps Script constraints
- `.planning/research/PITFALLS.md` — Critical pitfalls including silent variable failures and v2 endpoint quirk
- `.planning/research/SUMMARY.md` — Executive summary of all research findings

### Project
- `.planning/PROJECT.md` — Project context, agent IDs, phone number IDs
- `.planning/REQUIREMENTS.md` — Requirements DASH-01, DASH-02, VARS-01, VARS-02, VARS-03

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `elevenlabs-apps-script.js` — Complete Apps Script source already has the variable mapping fix at lines 182-201
- `elevenlabsGet()` / `elevenlabsPost()` — Existing API helper functions for ElevenLabs API calls
- `CONFIG` object — Contains agent ID, branch ID, phone number ID, API base URL

### Established Patterns
- Google Apps Script V8 runtime — `var` declarations, `UrlFetchApp.fetch()` for HTTP calls
- API key retrieved via `getApiKey()` which checks ScriptProperties first, falls back to CONFIG
- `Logger.log()` for debugging API responses

### Integration Points
- `submitBatchCall()` function — where variables are nested into recipients (already fixed in local file)
- `getSidebarHtml()` — HTML string that defines the sidebar UI (will need voice dropdown in Phase 2)
- Apps Script editor at `https://script.google.com/u/0/home/projects/1FxYM43Yi-OMXuFOwiYCPKs-tKs0BaUG2IzrBo3AVlvnnl_TFuYwVrxPL/edit`

</code_context>

<specifics>
## Specific Ideas

- The RESUME.md documents the exact steps for browser paste deployment (open editor, Cmd+A, delete, paste, save)
- ElevenLabs API key: `sk_24138756ab4b5a842c6d44cf1851b5536931888de6752303` (unrestricted, already in CONFIG)
- Research confirmed: `conversation_initiation_client_data.dynamic_variables` is the correct nesting format
- Research confirmed: `elevenlabsGet()` prepends `/v1` — must use full URL for any `/v2` endpoints (relevant for Phase 2)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-fix*
*Context gathered: 2026-03-31*
