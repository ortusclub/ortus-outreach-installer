# Phase 1: Foundation Fix - Research

**Researched:** 2026-03-31
**Domain:** ElevenLabs Conversational AI API + Google Apps Script deployment
**Confidence:** HIGH

## Summary

Phase 1 is a deployment and configuration phase with minimal new code. The variable mapping fix already exists in `elevenlabs-apps-script.js` (lines 182-201) with the correct `conversation_initiation_client_data.dynamic_variables` nesting. The work is: (1) deploy that fixed file to the Apps Script editor via browser paste, (2) use the ElevenLabs API to audit the agent prompt and ensure all 14 dynamic variables are referenced, (3) enable TTS override in the agent Security settings via dashboard, and (4) verify with a real test call.

The agent prompt audit is the most technically interesting part. The ElevenLabs API exposes `GET /v1/convai/agents/{agent_id}` which returns the prompt at `conversation_config.agent.prompt.prompt`. This text can be searched for `{{variable_name}}` references. If any of the 14 variables are missing, `PATCH /v1/convai/agents/{agent_id}` can update the prompt. The existing `elevenlabsGet()` helper in the Apps Script already prepends `/v1`, so the endpoint paths `/convai/agents/{agent_id}` work directly.

**Primary recommendation:** Execute in order: deploy code -> audit/patch agent prompt via API -> enable TTS override in dashboard -> test call. All steps are verifiable independently.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Deploy the fixed code to Apps Script editor via browser paste using computer-use/Chrome tools (open editor -> Cmd+A -> delete -> paste from clipboard -> Cmd+S). No Apps Script API setup needed.
- **D-02:** No redeployment step needed -- sidebar uses HEAD deployment, so saving the code makes it live.
- **D-03:** All 14 dynamic variables are required for every call -- no optional fields.
- **D-04:** The 14 variables are: caller_name, host_name, host_first_name, event_name, event_date, event_time, event_city, event_area, event_venue, event_format, event_context, target_audience, prospect_name, prospect_email.
- **D-05:** Use ElevenLabs API to GET the current agent config (`GET /v1/convai/agents/{agent_id}`), check which variables are referenced in the prompt template, and PATCH any missing ones in (`PATCH /v1/convai/agents/{agent_id}`).
- **D-06:** Agent ID: `agent_5601kmzey4mve8pswpwvmhckcgnr`, Branch ID: `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`.
- **D-07:** Enable TTS override in the ElevenLabs agent Security settings via the dashboard UI. This is a manual step.
- **D-08:** Verify with a real test call -- submit a 1-recipient batch to user's phone number with all 14 variables filled in.
- **D-09:** Success = the agent greets the prospect using the correct host name, event name, and other sidebar-entered event details.

### Claude's Discretion
- Exact order of operations (deploy code first, then audit prompt, then test)
- How to structure the API calls for prompt audit
- Error handling approach if API calls fail

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DASH-01 | Enable TTS override in ElevenLabs agent Security settings | Manual dashboard toggle; verified this is a prerequisite for voice override in Phase 2 (Pitfall 1 in PITFALLS.md) |
| DASH-02 | Audit agent prompt to ensure all 14 dynamic variables are referenced | GET/PATCH API endpoints verified; prompt lives at `conversation_config.agent.prompt.prompt`; variables use `{{var_name}}` syntax |
| VARS-01 | All sidebar inputs correctly nested under `conversation_initiation_client_data.dynamic_variables` | Fix already exists in local file lines 182-201; 12 shared variables nested correctly |
| VARS-02 | Per-lead variables (prospect_name, prospect_email) correctly nested per recipient | Fix already exists in local file lines 186-187; built per-recipient in the loop |
| VARS-03 | Deploy the fixed Apps Script code to the Google Apps Script editor | Browser paste workflow per D-01; HEAD deployment means saving = live |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Google Apps Script | V8 runtime | Server-side logic, API calls | Already in use; only option for Sheets sidebar |
| ElevenLabs `/v1/convai/agents/{id}` | v1 | GET/PATCH agent config for prompt audit | Official endpoint for reading and updating agent prompt |
| ElevenLabs `/v1/convai/batch-calling/submit` | v1 | Submit test batch call | Already used by existing code |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | -- | -- | All dependencies are native GAS services |

**Installation:** None. Single-file paste into Apps Script editor.

## Architecture Patterns

### Existing Code Structure
The entire system is a single file (`elevenlabs-apps-script.js`) with these sections:
```
elevenlabs-apps-script.js
  CONFIG                        # API keys, agent/branch/phone IDs
  MENU & UI                     # onOpen(), showSidebar(), getSidebarHtml()
  BATCH CALLING                 # submitBatchCall(), checkBatchStatus()
  API HELPERS                   # elevenlabsGet(), elevenlabsPost()
  SHEET UTILITIES               # getHeaders(), findColumn(), etc.
  SIDEBAR HTML (inline string)  # HTML/CSS/JS for the sidebar UI
```

### Pattern 1: API Helper Usage
**What:** All ElevenLabs API calls go through `elevenlabsGet(endpoint, apiKey)` and `elevenlabsPost(endpoint, payload, apiKey)`. These prepend `CONFIG.API_BASE` (`https://api.elevenlabs.io/v1`) to the endpoint.
**When to use:** For any `/v1` endpoint. Pass the path WITHOUT the `/v1` prefix.
**Example:**
```javascript
// GET agent config -- endpoint is /convai/agents/{id}, helper prepends /v1
var agentConfig = elevenlabsGet('/convai/agents/' + CONFIG.AGENT_ID, apiKey);
var prompt = agentConfig.conversation_config.agent.prompt.prompt;
```

### Pattern 2: Agent Prompt Audit via API
**What:** GET the agent config, extract the prompt text, search for `{{variable_name}}` patterns, identify missing variables, PATCH the prompt if needed.
**When to use:** DASH-02 requirement.
**Example:**
```javascript
// 1. GET current agent config (with branch_id for branch-specific config)
var config = elevenlabsGet(
  '/convai/agents/' + CONFIG.AGENT_ID + '?branch_id=' + CONFIG.BRANCH_ID,
  apiKey
);

// 2. Extract prompt text
var promptText = config.conversation_config.agent.prompt.prompt;

// 3. Check for each variable
var requiredVars = [
  'caller_name', 'host_name', 'host_first_name', 'event_name',
  'event_date', 'event_time', 'event_city', 'event_area',
  'event_venue', 'event_format', 'event_context', 'target_audience',
  'prospect_name', 'prospect_email'
];
var missing = [];
requiredVars.forEach(function(v) {
  if (promptText.indexOf('{{' + v + '}}') === -1) {
    missing.push(v);
  }
});

// 4. If missing, PATCH the prompt to include them
// (Need to construct updated prompt with missing variables added)
```

### Pattern 3: PATCH Agent Config
**What:** Update agent prompt via PATCH. The PATCH body uses `conversation_config` as the top-level key.
**When to use:** When variables are missing from the prompt template.
**Important:** The existing `elevenlabsPost()` helper uses `method: 'post'`. For PATCH, either modify it or make a direct `UrlFetchApp.fetch()` call with `method: 'patch'`.
**Example:**
```javascript
// Direct PATCH call (elevenlabsPost uses POST method, not PATCH)
var url = CONFIG.API_BASE + '/convai/agents/' + CONFIG.AGENT_ID;
var patchPayload = {
  conversation_config: {
    agent: {
      prompt: {
        prompt: updatedPromptText
      }
    }
  }
};
var options = {
  method: 'patch',
  contentType: 'application/json',
  headers: { 'xi-api-key': apiKey },
  payload: JSON.stringify(patchPayload),
  muteHttpExceptions: true
};
var response = UrlFetchApp.fetch(url, options);
```

### Anti-Patterns to Avoid
- **Using `elevenlabsPost()` for PATCH requests:** The helper hardcodes `method: 'post'`. Use direct `UrlFetchApp.fetch()` with `method: 'patch'` instead.
- **Forgetting `branch_id` on GET:** The agent has a branch. Always pass `?branch_id=agtbrch_0801kmzey97dfhwbwgctcmkv4ez4` to get the branch-specific prompt.
- **Editing the prompt in the dashboard instead of API:** The API approach is auditable and repeatable. Dashboard edits are manual and error-prone.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Apps Script deployment | clasp CLI setup, Apps Script API OAuth | Browser paste (Cmd+A, delete, paste, Cmd+S) | User decided D-01: no API setup needed, paste is faster for single-file |
| Agent prompt inspection | Manual dashboard reading | `GET /v1/convai/agents/{id}` API call | API is programmatic, auditable, catches all 14 variables reliably |
| Variable reference checking | Manual text search | Programmatic `indexOf('{{var}}')` loop | 14 variables -- manual checking will miss one |

## Common Pitfalls

### Pitfall 1: Agent Prompt Does Not Reference All Variables
**What goes wrong:** Variables are passed in the API payload but the agent prompt does not contain `{{variable_name}}` placeholders. The agent ignores them silently.
**Why it happens:** Dynamic variables must exist in BOTH the API payload AND the agent's prompt template. Passing them via API alone does nothing.
**How to avoid:** Programmatically audit the prompt via GET API, then PATCH any missing variables in.
**Warning signs:** Test call uses generic greetings instead of personalized ones.

### Pitfall 2: PATCH Overwrites Entire Prompt Section
**What goes wrong:** PATCH request replaces the entire `conversation_config.agent.prompt` object, losing LLM settings, temperature, tool IDs, etc.
**Why it happens:** Sending only `{ prompt: updatedText }` under the prompt object may clear other fields.
**How to avoid:** GET the full agent config first, modify only the `prompt.prompt` string, send back the complete prompt object in the PATCH.
**Warning signs:** Agent behavior changes (different model, no tools, etc.) after the PATCH.

### Pitfall 3: Branch-Specific Config Not Fetched
**What goes wrong:** GET returns the main agent config, not the branch-specific one. Prompt audit passes but the branch has a different prompt.
**Why it happens:** Agent ID `agent_5601kmzey4mve8pswpwvmhckcgnr` has branch `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`. GET without `branch_id` returns the default.
**How to avoid:** Always pass `?branch_id=agtbrch_0801kmzey97dfhwbwgctcmkv4ez4` on both GET and PATCH.
**Warning signs:** Prompt text looks different from what you see in the dashboard for the branch.

### Pitfall 4: Variable Syntax Mismatch
**What goes wrong:** The prompt uses `{variable}` (single braces) or `{{ variable }}` (spaces inside braces) instead of `{{variable}}` (no spaces).
**Why it happens:** Different templating engines use different syntax. ElevenLabs uses `{{variable_name}}` with no spaces.
**How to avoid:** When auditing, check for the exact `{{variable_name}}` pattern. When patching, use `{{variable_name}}` exactly.
**Warning signs:** Variables show up as literal text in the call.

### Pitfall 5: Code Paste Truncation
**What goes wrong:** Large file paste into Apps Script editor gets truncated or the editor freezes.
**Why it happens:** The file is ~650 lines. Browser paste into a web-based editor can be slow.
**How to avoid:** Use Cmd+A to select ALL existing code first, then delete, then paste. Wait for the editor to finish processing before saving.
**Warning signs:** Syntax errors in the Apps Script editor after paste.

## Code Examples

### GET Agent Config and Extract Prompt
```javascript
// Source: ElevenLabs API docs - GET /v1/convai/agents/{agent_id}
// Note: elevenlabsGet() prepends CONFIG.API_BASE which is https://api.elevenlabs.io/v1
var apiKey = getApiKey();
var agentConfig = elevenlabsGet(
  '/convai/agents/' + CONFIG.AGENT_ID + '?branch_id=' + CONFIG.BRANCH_ID,
  apiKey
);

// Response structure:
// {
//   agent_id: "agent_5601...",
//   name: "...",
//   conversation_config: {
//     agent: {
//       prompt: {
//         prompt: "You are a calling agent for {{host_name}}...",
//         llm: "gpt-4o-mini",
//         temperature: 0.7,
//         ...
//       }
//     },
//     tts: { ... },
//     ...
//   }
// }

var promptText = agentConfig.conversation_config.agent.prompt.prompt;
Logger.log('Current prompt length: ' + promptText.length);
```

### Audit Variables in Prompt
```javascript
var REQUIRED_VARS = [
  'caller_name', 'host_name', 'host_first_name', 'event_name',
  'event_date', 'event_time', 'event_city', 'event_area',
  'event_venue', 'event_format', 'event_context', 'target_audience',
  'prospect_name', 'prospect_email'
];

var missing = [];
var found = [];
REQUIRED_VARS.forEach(function(varName) {
  if (promptText.indexOf('{{' + varName + '}}') !== -1) {
    found.push(varName);
  } else {
    missing.push(varName);
  }
});

Logger.log('Found: ' + found.join(', '));
Logger.log('Missing: ' + missing.join(', '));
```

### PATCH Agent Prompt (if variables missing)
```javascript
// Source: ElevenLabs API docs - PATCH /v1/convai/agents/{agent_id}
// IMPORTANT: Send full prompt object to avoid overwriting other fields
var fullPromptObj = agentConfig.conversation_config.agent.prompt;
// Modify only the prompt text
fullPromptObj.prompt = updatedPromptText; // with missing {{vars}} added

var url = CONFIG.API_BASE + '/convai/agents/' + CONFIG.AGENT_ID
  + '?branch_id=' + CONFIG.BRANCH_ID;
var options = {
  method: 'patch',
  contentType: 'application/json',
  headers: { 'xi-api-key': apiKey },
  payload: JSON.stringify({
    conversation_config: {
      agent: {
        prompt: fullPromptObj
      }
    }
  }),
  muteHttpExceptions: true
};
var response = UrlFetchApp.fetch(url, options);
Logger.log('PATCH response: ' + response.getResponseCode());
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual verification (no automated test framework -- GAS has no built-in test runner) |
| Config file | none |
| Quick run command | Run `submitBatchCall()` from Apps Script editor with 1 recipient |
| Full suite command | Submit batch, listen to call, verify personalization |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DASH-01 | TTS override enabled in Security settings | manual-only | Visual check in ElevenLabs dashboard | N/A |
| DASH-02 | All 14 variables referenced in agent prompt | smoke | Run GET API call, check response programmatically | Wave 0: write audit script |
| VARS-01 | Shared variables nested correctly in payload | smoke | Submit 1-recipient batch, verify API accepts it | N/A (verified by test call) |
| VARS-02 | Per-lead variables nested per recipient | smoke | Submit 1-recipient batch, verify greeting uses prospect_name | N/A (verified by test call) |
| VARS-03 | Fixed code deployed to Apps Script editor | manual-only | Visual check that code is saved in editor | N/A |

### Sampling Rate
- **Per task:** Verify each step independently before moving to next
- **Phase gate:** 1-recipient test call with all 14 variables filled in; agent greets with correct personalized details

### Wave 0 Gaps
- [ ] Write a standalone audit function that can be run from Apps Script editor to GET agent config and log which variables are found/missing
- [ ] No automated test framework needed -- this phase is deployment + configuration, not code development

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Variables at top-level of recipient | Nested under `conversation_initiation_client_data.dynamic_variables` | Current API spec | Variables silently dropped if not nested correctly |
| GET agent without branch_id | GET with `?branch_id=` query param | March 2026 update | Branch-specific config returned correctly |
| PATCH agent without branch_id | PATCH with `?branch_id=` query param | March 2026 update | Branch-specific prompt updated correctly |

## Open Questions

1. **Exact prompt text structure**
   - What we know: Prompt is at `conversation_config.agent.prompt.prompt`; variables use `{{var_name}}` syntax
   - What's unclear: The exact current prompt text and where to best insert missing variables if any are absent
   - Recommendation: GET the prompt first, read it, then decide where to add missing `{{var}}` references contextually

2. **PATCH partial vs full object**
   - What we know: PATCH should accept partial updates per REST convention
   - What's unclear: Whether ElevenLabs PATCH truly does a deep merge or replaces entire nested objects
   - Recommendation: Send the full `prompt` object (not just the string) to be safe -- GET first, modify, send back

3. **TTS override toggle exact location**
   - What we know: It is in ElevenLabs dashboard > Agent > Security tab
   - What's unclear: Exact UI element name and whether it can be toggled via API
   - Recommendation: Manual dashboard toggle per D-07; document exact steps during execution

## Sources

### Primary (HIGH confidence)
- [ElevenLabs GET Agent](https://elevenlabs.io/docs/api-reference/agents/get) -- endpoint path, response structure, branch_id parameter
- [ElevenLabs Update Agent](https://elevenlabs.io/docs/api-reference/agents/update) -- PATCH method, request body structure
- [ElevenLabs Dynamic Variables](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables) -- `{{var_name}}` syntax, must be in prompt template
- [ElevenLabs Batch Calling](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- recipient schema, `conversation_initiation_client_data` nesting

### Secondary (MEDIUM confidence)
- [ElevenLabs Overrides](https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides) -- TTS override requires Security tab toggle (page was 404 during prior research but confirmed via batch calling schema)

### Tertiary (LOW confidence)
- PATCH deep merge behavior -- assumed based on REST conventions; not explicitly confirmed in docs. Mitigation: send full prompt object.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all existing patterns
- Architecture: HIGH -- existing code structure is well understood, API endpoints verified
- Pitfalls: HIGH -- critical pitfalls are concrete with clear mitigations
- API paths: MEDIUM -- prompt location in response confirmed by docs but branch-specific PATCH behavior needs live testing

**Research date:** 2026-03-31
**Valid until:** 2026-04-30 (stable -- no fast-moving dependencies)
