# Phase 4: Agent Intelligence - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Configure the ElevenLabs agent for production-quality outbound B2B calling: port the Vapi conversational prompt (adapted for ElevenLabs), enable built-in tools (voicemail_detection, end_call), increase TTS speed, and configure structured data collection for post-call JSON extraction. No sidebar/sheet changes — this phase is agent configuration only.

</domain>

<decisions>
## Implementation Decisions

### Vapi Prompt Porting
- **D-01:** Adapt the Vapi prompt for ElevenLabs — keep all conversational logic but simplify where ElevenLabs built-in tools handle functionality (voicemail detection → built-in tool, call termination → end_call tool).
- **D-02:** Essential sections to port (ALL of these):
  - Opening flow with "MOST IMPORTANT RULE" (short greeting = live human, NEVER end call early)
  - "SECOND MOST IMPORTANT RULE" (no premature goodbye)
  - Gatekeeper handling (human receptionist/PA)
  - AI screening bot detection and response
  - Event description scripts for ALL formats (dinner, virtual roundtable, in-person roundtable, virtual masterclass, in-person masterclass)
  - Email confirmation flow
  - Common Q&A (Are you AI?, What is The Ortus Club?, Is this a sales call?, etc.)
  - Callback handling
  - Goodbye/end-of-call rules
  - Failed number detection
- **D-03:** AI gatekeeper handling is CRITICAL — must detect AI screening bots ("Record your name and reason", "State your name after the tone"), respond once with name + reason, then wait silently.
- **D-04:** Use ElevenLabs built-in `voicemail_detection` tool instead of prompt-based voicemail detection. The prompt should still include voicemail MESSAGE instructions (what to say after the beep).
- **D-05:** Use ElevenLabs built-in `end_call` tool for reliable call termination on: failed numbers, after voicemail message, and when conversation naturally ends.

### TTS Speed
- **D-06:** Increase TTS speed from 1.0 to 1.1. Set via PATCH to agent config `conversation_config.tts.speed: 1.1`.

### Data Collection
- **D-07:** Configure ElevenLabs data collection to extract structured JSON matching the Vapi post-call schema:
  - `outcome`: Interested | Busy | Declined | Gatekeeper | Callback
  - `call_status`: Spoke to Human | Voicemail | No Answer | Number Failed | AI Gatekeeper | Hung Up (≤30s)
  - `has_seen_invite`: true | false | null
  - `follow_up_action`: resend | bump | none
  - `callback_requested`: true | false
  - `callback_when`: specific time or "unspecified"
  - `prospect_email_confirmed`: email if provided/updated, or empty
- **D-08:** Data collection is configured via the ElevenLabs agent `platform_settings.data_collection` section. Each field needs a name, description, and type.

### Built-in Tools
- **D-09:** Enable these built-in tools on the agent:
  - `voicemail_detection` — auto-detects voicemail greetings
  - `end_call` — agent can programmatically hang up
- **D-10:** Do NOT enable: `transfer_to_number`, `language_detection`, `transfer_to_agent` (not needed for this use case).

### Implementation Method
- **D-11:** All changes are via ElevenLabs API (PATCH agent config). No sidebar/sheet code changes in this phase.
- **D-12:** Use `PATCH /v1/convai/agents/{agent_id}?branch_id={branch_id}` with partial updates for each config change.

### Post-Call Actions
- **D-13:** Post-call sheet updates, SMS, and reporting are Phase 5/6 scope. Phase 4 focuses only on agent configuration.

### Claude's Discretion
- Exact prompt wording adaptations for ElevenLabs (the Vapi prompt is the reference, adapt as needed)
- Data collection field types and descriptions
- Whether to keep the `first_message` empty (current: empty, agent waits for user to speak first — matches Vapi "wait for the person to speak first")

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Vapi Prompt (PRIMARY REFERENCE)
The user provided their complete Vapi prompt in the conversation. It is the authoritative reference for:
- Opening flow and greeting rules
- Gatekeeper/AI screening bot handling
- Event format descriptions (dinner, roundtable, masterclass, virtual/in-person)
- Common Q&A responses
- Voicemail message script
- Post-call JSON schema
- Goodbye/end-of-call rules

The Vapi prompt should be saved as a reference file and read by the executor.

### ElevenLabs Agent Config
- Agent ID: `agent_5601kmzey4mve8pswpwvmhckcgnr`
- Branch ID: `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`
- Current TTS: speed 1.0, stability 0.5, similarity_boost 0.8, model eleven_v3_conversational
- Current LLM: gemini-2.5-flash, temperature 0.0
- Built-in tools: all disabled (need to enable voicemail_detection + end_call)
- Data collection: empty (needs configuration)
- API: `PATCH /v1/convai/agents/{agent_id}?branch_id={branch_id}`

### Prior Research
- `.planning/research/CAPABILITIES.md` — ElevenLabs API capabilities (if exists)
- `.planning/phases/01-foundation-fix/01-01-SUMMARY.md` — Agent prompt audit confirming all 14 variables present

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `elevenlabs-apps-script.js` has `elevenlabsPost()` and `elevenlabsGet()` helpers — but this phase uses direct API calls (curl/script), not the Apps Script
- Phase 1 Plan 01 demonstrated the GET/PATCH pattern for the agent API

### Integration Points
- The agent prompt uses `{{variable_name}}` syntax for dynamic variables — all 14 are already confirmed present
- `platform_settings.data_collection` section of the agent config — currently empty
- `conversation_config.agent.prompt.built_in_tools` — all currently null (disabled)

</code_context>

<specifics>
## Specific Ideas

- The Vapi prompt's `first_message` is empty (agent waits for caller to speak) — ElevenLabs agent already has `first_message: ''` which matches
- The ElevenLabs `end_call` built-in tool lets the agent decide when to hang up via the LLM — perfect for failed numbers and post-voicemail
- Data collection in ElevenLabs extracts structured fields from the conversation automatically after it ends — the LLM analyzes the transcript and fills in the defined fields
- The Vapi prompt's "POST-CALL DATA" section can be adapted into ElevenLabs data collection field definitions rather than prompt instructions

</specifics>

<deferred>
## Deferred Ideas

- Sheet integration for data collection results → Phase 5
- SMS follow-up triggers based on call_status → Phase 6
- Knowledge base for detailed event FAQs → future phase

</deferred>

---

*Phase: 04-agent-intelligence*
*Context gathered: 2026-03-31*
