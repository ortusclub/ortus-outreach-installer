# Phase 4: Agent Intelligence - Research

**Researched:** 2026-04-01
**Domain:** ElevenLabs Conversational AI Agent Configuration API
**Confidence:** HIGH

## Summary

Phase 4 is entirely API-driven: all changes are PATCH requests to the ElevenLabs agent endpoint. No code changes to the sidebar or Apps Script. The research verified all four configuration areas against the live API with test PATCH calls: (1) built-in tools (voicemail_detection, end_call), (2) TTS speed override, (3) prompt replacement, and (4) structured data collection fields.

The critical finding is that PATCH behavior varies by section: `built_in_tools` and nested `conversation_config` objects merge deeply (individual tool enablement preserves others), while `data_collection` replaces at the object level (must send ALL fields in a single PATCH). The prompt field is a simple string replacement. All payloads were tested against the live agent branch and reverted.

**Primary recommendation:** Execute as 2-3 sequential PATCH calls: (1) prompt + TTS speed + built-in tools in one call, (2) data collection in a separate call. Verify each with GET after.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Adapt the Vapi prompt for ElevenLabs — keep all conversational logic but simplify where ElevenLabs built-in tools handle functionality
- D-02: Essential sections to port: opening flow, gatekeeper handling, AI screening bot detection, ALL event format descriptions, email confirmation, common Q&A, callback handling, goodbye rules, failed number detection
- D-03: AI gatekeeper handling is CRITICAL — must detect AI screening bots and respond correctly
- D-04: Use ElevenLabs built-in voicemail_detection tool instead of prompt-based detection. Prompt still includes voicemail MESSAGE instructions.
- D-05: Use ElevenLabs built-in end_call tool for reliable call termination
- D-06: Increase TTS speed from 1.0 to 1.1
- D-07: Configure data collection with 7 fields: outcome, call_status, has_seen_invite, follow_up_action, callback_requested, callback_when, prospect_email_confirmed
- D-08: Data collection via platform_settings.data_collection section
- D-09: Enable voicemail_detection and end_call built-in tools
- D-10: Do NOT enable transfer_to_number, language_detection, transfer_to_agent
- D-11: All changes via ElevenLabs API PATCH. No sidebar/sheet code changes.
- D-12: Use PATCH /v1/convai/agents/{agent_id}?branch_id={branch_id}
- D-13: Post-call sheet updates, SMS, reporting are Phase 5/6 scope

### Claude's Discretion
- Exact prompt wording adaptations for ElevenLabs
- Data collection field types and descriptions
- Whether to keep first_message empty (current: empty, matches Vapi behavior)

### Deferred Ideas (OUT OF SCOPE)
- Sheet integration for data collection results (Phase 5)
- SMS follow-up triggers based on call_status (Phase 6)
- Knowledge base for detailed event FAQs (future phase)
</user_constraints>

## API Behavior — Verified via Live Testing

### PATCH Merge Semantics (HIGH confidence — tested live)

| Config Section | Merge Behavior | Implication |
|----------------|---------------|-------------|
| `conversation_config.tts` | **Deep merge** — only sent fields update, others preserved | Can PATCH `speed` alone without sending voice_id, stability, etc. |
| `conversation_config.agent.prompt.prompt` | **String replace** — overwrites entire prompt text | Must send the complete adapted prompt |
| `conversation_config.agent.prompt.built_in_tools` | **Deep merge** — individual tool keys merge independently | Can enable `end_call` in one call and `voicemail_detection` in another; both persist |
| `platform_settings.data_collection` | **Shallow replace** — entire object replaced | Must send ALL 7 fields in a single PATCH; a second PATCH with fewer fields deletes the rest |

### Disabling a Built-in Tool
Set the tool key to `null` to disable:
```json
{"conversation_config": {"agent": {"prompt": {"built_in_tools": {"end_call": null}}}}}
```

### API Endpoint
```
PATCH https://api.elevenlabs.io/v1/convai/agents/{agent_id}?branch_id={branch_id}
Headers: xi-api-key: {key}, Content-Type: application/json
```

- Agent ID: `agent_5601kmzey4mve8pswpwvmhckcgnr`
- Branch ID: `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`

## Code Examples

Verified patterns from live API testing:

### 1. Enable Built-in Tools
```json
{
  "conversation_config": {
    "agent": {
      "prompt": {
        "built_in_tools": {
          "end_call": {
            "type": "system",
            "name": "end_call",
            "description": "",
            "params": {
              "system_tool_type": "end_call"
            }
          },
          "voicemail_detection": {
            "type": "system",
            "name": "voicemail_detection",
            "description": "",
            "params": {
              "system_tool_type": "voicemail_detection",
              "voicemail_message": "Hi {{prospect_name}}, this is {{caller_name}} from The Ortus Club calling on behalf of {{host_first_name}} about an invitation to {{event_name}} on {{event_date}}. Feel free to reply to the email or call back. Thanks."
            }
          }
        }
      }
    }
  }
}
```

**Verified response structure** (fields auto-added by API):
```json
{
  "type": "system",
  "name": "voicemail_detection",
  "description": "",
  "response_timeout_secs": 20,
  "disable_interruptions": false,
  "force_pre_tool_speech": false,
  "assignments": [],
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "tool_error_handling_mode": "auto",
  "params": {
    "system_tool_type": "voicemail_detection",
    "voicemail_message": "Hi {{prospect_name}}, ..."
  }
}
```

### 2. Update TTS Speed
```json
{
  "conversation_config": {
    "tts": {
      "speed": 1.1
    }
  }
}
```
Minimal payload. Deep merge preserves voice_id, stability, similarity_boost, model_id, etc.

### 3. Update Agent Prompt
```json
{
  "conversation_config": {
    "agent": {
      "prompt": {
        "prompt": "FULL PROMPT TEXT HERE"
      }
    }
  }
}
```
String replacement. Must include the entire adapted prompt.

### 4. Configure Data Collection
```json
{
  "platform_settings": {
    "data_collection": {
      "outcome": {
        "type": "string",
        "description": "The call outcome. Must be exactly one of: Interested, Busy, Declined, Gatekeeper, Callback"
      },
      "call_status": {
        "type": "string",
        "description": "The call status. Must be exactly one of: Spoke to Human, Voicemail, No Answer, Number Failed, AI Gatekeeper, Hung Up"
      },
      "has_seen_invite": {
        "type": "boolean",
        "description": "Whether the prospect confirmed they saw the invitation email. true if yes, false if no, null if unknown or not discussed."
      },
      "follow_up_action": {
        "type": "string",
        "description": "The follow-up action requested. Must be exactly one of: resend, bump, none"
      },
      "callback_requested": {
        "type": "boolean",
        "description": "Whether the prospect explicitly asked for a callback."
      },
      "callback_when": {
        "type": "string",
        "description": "When the prospect wants to be called back. A specific time if given (e.g. 'Tuesday 3pm'), 'unspecified' if they asked for callback without a time, or empty string if no callback requested."
      },
      "prospect_email_confirmed": {
        "type": "string",
        "description": "The prospect's email address if they provided or confirmed one during the call. Empty string if not discussed or not provided."
      }
    }
  }
}
```

**Available data types:** string, boolean, integer, number
**Enum support:** Fields can include `"enum": ["Option A", "Option B"]` to constrain values (verified via testing).
**Limits:** 25 fields per agent (non-enterprise), 40 for Trial/Enterprise.

## Architecture Patterns

### Recommended Execution Order
```
Step 1: GET current config (backup/verify starting state)
Step 2: PATCH prompt + TTS speed + built-in tools (single call)
Step 3: GET to verify Step 2 changes
Step 4: PATCH data collection (separate call due to replace semantics)
Step 5: GET to verify data collection
Step 6: Manual test call to verify end-to-end
```

### Why Combine Prompt + Tools + TTS in One PATCH
All three live under `conversation_config` which deep-merges. Sending them together reduces API calls and ensures atomic update. The data_collection lives under `platform_settings` so it can be in the same or separate call.

### Prompt Adaptation Strategy
The Vapi prompt (04-VAPI-PROMPT-REFERENCE.md) maps to ElevenLabs as follows:

| Vapi Section | ElevenLabs Handling |
|-------------|-------------------|
| WHO YOU ARE | Keep in prompt (identical) |
| EVENT CONTEXT | Keep in prompt (uses same `{{variable}}` syntax) |
| MOST IMPORTANT RULE | Keep in prompt (critical for human detection) |
| SECOND MOST IMPORTANT RULE | Keep in prompt |
| OPENING FLOW | Keep in prompt |
| If they saw invite / didn't see | Keep in prompt (all event format descriptions) |
| Email confirmation | Keep in prompt |
| Common Q&A (all) | Keep in prompt |
| Callbacks | Keep in prompt |
| GOODBYE / END OF CALL | Keep in prompt BUT add: "Use the end_call tool to terminate the call" |
| VOICEMAIL detection logic | REMOVE from prompt (built-in tool handles detection) |
| VOICEMAIL message script | Move to `voicemail_message` param in built-in tool |
| AI SCREENING BOTS | Keep in prompt |
| FAILED NUMBER | Keep in prompt BUT add: "Use the end_call tool" |
| POST-CALL DATA | REMOVE from prompt (data_collection handles this) |

### Anti-Patterns to Avoid
- **Sending partial data_collection:** PATCH replaces the entire object. Missing fields will be deleted.
- **Keeping voicemail detection in prompt AND tool:** Double-detection causes confusion. Remove prompt-based detection logic, keep only the voicemail message in the tool.
- **Keeping POST-CALL DATA in prompt:** Data collection is handled by platform_settings, not the LLM prompt. Remove this section to avoid conflicting instructions.
- **PATCHing prompt without the full text:** The prompt field is a complete string replacement. Sending a partial prompt overwrites everything.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Voicemail detection | Prompt instructions for detecting voicemails | `voicemail_detection` built-in tool | Built-in tool uses audio analysis, not just LLM text analysis. More reliable. |
| Call termination | Relying on LLM to "stop speaking" | `end_call` built-in tool | Programmatic hangup is reliable; LLM "stop speaking" leaves the line open |
| Post-call data extraction | Prompt-based JSON output | `platform_settings.data_collection` | Structured extraction with typed fields; available in webhooks and conversation history |

## Common Pitfalls

### Pitfall 1: Data Collection Replacement Semantics
**What goes wrong:** Developer sends a PATCH with 3 of 7 data collection fields, expecting a merge. The other 4 fields are silently deleted.
**Why it happens:** `data_collection` is replaced at the object level, unlike `built_in_tools` which merges.
**How to avoid:** Always send ALL 7 data collection fields in a single PATCH. Never send partial updates.
**Warning signs:** GET after PATCH shows fewer fields than expected.

### Pitfall 2: Voicemail Message Dynamic Variables
**What goes wrong:** Voicemail message plays with literal `{{prospect_name}}` instead of the actual name.
**Why it happens:** Dynamic variables must match the exact placeholder names defined in `dynamic_variable_placeholders`.
**How to avoid:** Use the same variable names as the prompt: `{{prospect_name}}`, `{{caller_name}}`, `{{host_first_name}}`, `{{event_name}}`, `{{event_date}}`.
**Warning signs:** Test call voicemail plays variable names instead of values.

### Pitfall 3: Prompt Length After Adaptation
**What goes wrong:** Adapted prompt is too long or too short, missing critical sections.
**Why it happens:** Developer removes sections that should stay, or adds unnecessary ElevenLabs-specific boilerplate.
**How to avoid:** Use the mapping table above. Keep all conversational logic. Only remove: voicemail detection logic, POST-CALL DATA section. Add: end_call tool references in goodbye/failed number sections.
**Warning signs:** Prompt is significantly shorter than the Vapi reference (Vapi ~4500 chars, adapted should be similar minus removed sections plus tool references).

### Pitfall 4: end_call Description Override
**What goes wrong:** Setting a custom description for end_call changes when the LLM decides to use it.
**Why it happens:** The description field is passed to the LLM as context for tool usage. Default (empty) lets the LLM decide naturally.
**How to avoid:** Leave description empty (`""`) for default behavior. The prompt itself should guide when to end calls.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual API testing via curl |
| Config file | None (API-only phase) |
| Quick run command | `curl -s -H "xi-api-key: ..." GET agent endpoint \| python3 -m json.tool` |
| Full suite command | Manual test call via ElevenLabs batch calling |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-04 | voicemail_detection enabled | smoke | GET agent, check built_in_tools.voicemail_detection is not null | N/A |
| D-05 | end_call enabled | smoke | GET agent, check built_in_tools.end_call is not null | N/A |
| D-06 | TTS speed = 1.1 | smoke | GET agent, check tts.speed == 1.1 | N/A |
| D-07 | 7 data collection fields | smoke | GET agent, check data_collection has 7 keys | N/A |
| D-01/D-02 | Prompt ported with all sections | manual | GET agent, inspect prompt text for all required sections | N/A |
| D-03 | AI gatekeeper handling in prompt | manual | Grep prompt text for screening bot keywords | N/A |

### Sampling Rate
- **Per PATCH:** GET immediately after to verify changes applied
- **Phase gate:** Manual test call with real Twilio number to verify voicemail detection, end_call, and data collection

### Wave 0 Gaps
None -- this phase requires no test infrastructure. Validation is API GET checks and manual test calls.

## Open Questions

1. **has_seen_invite null handling**
   - What we know: Data collection supports boolean (true/false). The Vapi schema uses true/false/null.
   - What's unclear: Whether ElevenLabs boolean type returns null when the LLM can't determine the value, or always returns true/false.
   - Recommendation: Use string type with description "Must be one of: true, false, null" instead of boolean, to guarantee null is possible. Or test with a real call.

2. **Data collection accuracy with Gemini 2.5 Flash**
   - What we know: Data collection uses the agent's LLM to analyze the transcript.
   - What's unclear: How accurately Gemini 2.5 Flash extracts structured data from conversational transcripts.
   - Recommendation: Monitor first 10 calls and compare extracted data to actual transcript. Adjust field descriptions if extraction is inaccurate.

## Sources

### Primary (HIGH confidence)
- ElevenLabs API live testing (2026-04-01) -- PATCH/GET on agent_5601kmzey4mve8pswpwvmhckcgnr branch agtbrch_0801kmzey97dfhwbwgctcmkv4ez4
- [Update agent API reference](https://elevenlabs.io/docs/api-reference/agents/update) -- PATCH schema
- [End call system tool docs](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/end-call) -- tool configuration
- [Data collection docs](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/data-collection) -- field types and limits

### Secondary (MEDIUM confidence)
- [Voicemail detection blog post](https://elevenlabs.io/blog/voicemail-detection) -- feature overview
- [System tools overview](https://elevenlabs.io/docs/agents-platform/customization/tools/system-tools) -- tool listing

## Metadata

**Confidence breakdown:**
- API PATCH behavior: HIGH -- tested live with actual API calls, all payloads verified and reverted
- Built-in tools schema: HIGH -- tested enable/disable/merge behavior on live agent
- Data collection schema: HIGH -- tested field creation with types and enum support on live agent
- Prompt adaptation: MEDIUM -- mapping strategy is clear but exact wording needs human review after porting
- Data collection accuracy: LOW -- depends on LLM extraction quality, untested with real calls

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (API is stable; ElevenLabs rarely changes PATCH semantics)
