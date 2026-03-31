# Architecture Patterns

**Domain:** ElevenLabs Voice Selection + Dynamic Variable Mapping in Google Apps Script
**Researched:** 2026-03-31

## Recommended Architecture

Single-file Google Apps Script with server-side functions exposed to HTML sidebar via `google.script.run`. No architectural changes to existing pattern -- just new functions and sidebar UI additions.

**Key architectural decision:** Voice override uses per-recipient `conversation_config_override.tts.voice_id` in the batch payload, NOT an agent-level PATCH. This avoids mutating shared agent state and is the officially documented override mechanism.

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| Sidebar HTML | UI: voice dropdown, event fields, submit button | Server-side GAS via `google.script.run` |
| `getVoiceList()` (new) | Fetch voice list from ElevenLabs `/v2/voices`, cache result | ElevenLabs API, `CacheService` |
| `getLastUsedVoiceId()` (new) | Return last-used voice from PropertiesService | `PropertiesService` |
| `submitBatchCall()` (modified) | Build recipients with voice override + dynamic variables | ElevenLabs Batch Calling API |
| `PropertiesService` | Persist API key, phone number ID, last-used voice | Used by server-side functions |
| `CacheService` | Cache voice list (1-hour TTL) | Used by `getVoiceList()` |

### Data Flow: Voice Selection

```
1. Sidebar opens
   -> google.script.run.getVoiceList()       (async)
   -> google.script.run.getLastUsedVoiceId()  (async, parallel)

2. Server: getVoiceList()
   a. Check CacheService for "VOICE_LIST" key
   b. Cache HIT  -> parse JSON, return array
   c. Cache MISS -> GET https://api.elevenlabs.io/v2/voices?page_size=100&sort=name
                  -> extract [{voice_id, name, description}]
                  -> CacheService.put("VOICE_LIST", JSON.stringify(list), 3600)
                  -> return array

   Server: getLastUsedVoiceId()
   -> return PropertiesService.getScriptProperties().getProperty("LAST_VOICE_ID")

3. Sidebar receives voice list + last-used voice ID
   -> Populate <select id="voice_id"> dropdown
   -> Pre-select last-used voice (or default Alice if none stored)

4. Operator fills form + picks voice + clicks "Submit Batch Call"
   -> Sidebar JS reads voice_id from dropdown, adds to eventVars:
      eventVars.voice_id = document.getElementById("voice_id").value;
   -> google.script.run.submitBatchCall(eventVars, false);

5. Server: submitBatchCall(eventVars, selectedOnly)
   a. For each recipient, inject conversation_config_override:
      recipient.conversation_initiation_client_data.conversation_config_override = {
        tts: { voice_id: eventVars.voice_id }
      };
   b. Store last-used voice: PropertiesService.setProperty("LAST_VOICE_ID", eventVars.voice_id)
   c. Submit batch (existing logic, unchanged)
   d. Return batch result to sidebar

6. Batch calls go out, each recipient uses the selected voice via override
```

### Data Flow: Variable Mapping (Fix)

```
1. Sidebar collects event fields (host_name, event_name, etc.)
   |
   v
2. Fields passed as eventVars object to submitBatchCall(eventVars, false)
   |
   v
3. Server builds each recipient with correct nesting:
   recipient = {
     phone_number: "+44...",
     conversation_initiation_client_data: {
       conversation_config_override: {
         tts: { voice_id: eventVars.voice_id }
       },
       dynamic_variables: {
         prospect_name: "John Smith",
         prospect_email: "john@example.com",
         caller_name: eventVars.caller_name || 'Sarah',
         host_name: eventVars.host_name || '',
         ...all other event fields
       }
     }
   }
   |
   v
4. Batch payload submitted to POST /v1/convai/batch-calling/submit
```

**Status:** The variable mapping fix already exists in the local `elevenlabs-apps-script.js` (lines 182-200 show correct `conversation_initiation_client_data.dynamic_variables` nesting). It needs to be deployed to the Apps Script editor.

## Where Voice Config Lives: Per-Recipient Override (NOT Agent-Level)

**Decision: Voice is set per-recipient via `conversation_config_override`, NOT by patching the agent.**

Rationale:
1. The ElevenLabs batch calling API supports `conversation_config_override.tts.voice_id` per recipient (confirmed from official API schema at `/v1/convai/batch-calling/submit`).
2. This avoids mutating shared agent state -- no race conditions if multiple operators submit simultaneously.
3. The agent's default voice remains unchanged; overrides apply only to the specific batch.
4. This is the officially documented override mechanism.

**Prerequisite:** The agent's Security tab in the ElevenLabs dashboard must have "Voice ID" override enabled. Without this, the override will be silently ignored or cause an error. This is a one-time manual step.

**Persistence:** The sidebar remembers the last-used voice via `ScriptProperties.setProperty("LAST_VOICE_ID", voiceId)`. This is a UX convenience, not the agent's actual voice setting.

### Why Not Agent-Level PATCH?

| Approach | Per-Recipient Override | Agent-Level PATCH |
|----------|----------------------|-------------------|
| Mutates shared state? | No | Yes -- changes voice for ALL future calls |
| Race condition risk? | None | Last operator to submit wins |
| Requires extra API call? | No -- part of batch payload | Yes -- PATCH before every batch |
| Rollback needed? | No | Would need to restore previous voice |

Per-recipient override is strictly better for this use case.

## Where Voice List Is Cached: CacheService (Server-Side)

**Decision: Cache in CacheService with 1-hour TTL.**

| Option | Verdict | Why |
|--------|---------|-----|
| **CacheService** | USE THIS | Built for ephemeral data. 1hr TTL. Max 100KB per value (plenty for 100 voices). Auto-expires. |
| Client-side (sessionStorage) | Reject | Sidebar HTML is regenerated on every open; no persistent client state. |
| ScriptProperties | Reject | 9KB per property limit. No TTL. Wrong tool for ephemeral data. |
| No cache | Acceptable fallback | 500-1500ms latency per sidebar open. Tolerable but unnecessary. |

### Cache Implementation

```javascript
function getVoiceList() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('VOICE_LIST');
  if (cached) return JSON.parse(cached);

  var apiKey = getApiKey();
  // NOTE: v2 endpoint -- do NOT use elevenlabsGet() helper (it prepends /v1)
  var url = 'https://api.elevenlabs.io/v2/voices?page_size=100&sort=name';
  var options = {
    method: 'get',
    headers: { 'xi-api-key': apiKey },
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(response.getContentText());

  var voices = (data.voices || []).map(function(v) {
    var desc = '';
    if (v.labels) {
      desc = [v.labels.accent, v.labels.description].filter(Boolean).join(', ');
    }
    return { voice_id: v.voice_id, name: v.name, description: desc };
  });

  cache.put('VOICE_LIST', JSON.stringify(voices), 3600);
  return voices;
}
```

## Recipient Object: Combined Voice Override + Dynamic Variables

Both `conversation_config_override` and `dynamic_variables` are siblings under `conversation_initiation_client_data`:

```javascript
var recipient = {
  phone_number: phone,
  conversation_initiation_client_data: {
    conversation_config_override: {
      tts: { voice_id: eventVars.voice_id }
    },
    dynamic_variables: {
      prospect_name: prospectName,
      prospect_email: email,
      caller_name: eventVars.caller_name || 'Sarah',
      host_name: eventVars.host_name || '',
      host_first_name: eventVars.host_first_name || '',
      event_name: eventVars.event_name || '',
      event_date: eventVars.event_date || '',
      event_time: eventVars.event_time || '',
      event_city: eventVars.event_city || '',
      event_area: eventVars.event_area || '',
      event_venue: eventVars.event_venue || '',
      event_format: eventVars.event_format || 'roundtable',
      event_context: eventVars.event_context || '',
      target_audience: eventVars.target_audience || '',
    }
  }
};
```

## Patterns to Follow

### Pattern 1: Server-Side API Proxy
**What:** All ElevenLabs API calls go through server-side GAS functions. Sidebar HTML never makes direct API calls.
**When:** Always. GAS sidebar runs in a sandboxed iframe; API keys must stay server-side.

### Pattern 2: Non-Destructive Voice Override
**What:** Override voice at the batch payload level, never mutate the agent's configuration.
**When:** Always. Multiple operators may submit batches concurrently. Agent-level mutation causes race conditions.

### Pattern 3: Cache-Aside for API Data
**What:** Check cache first, fetch on miss, populate cache after fetch.
**When:** Voice list fetching. 1-hour TTL is a good balance between freshness and performance.

### Pattern 4: Progressive Enhancement in Sidebar
**What:** Load sidebar immediately with form fields. Populate voice dropdown asynchronously.
**When:** Sidebar initialization. Show "Loading voices..." placeholder, replace on success.

### Pattern 5: Graceful Degradation for Voice Fetch
**What:** If voice list fails to load, show error in dropdown but do not block batch submission.
**When:** API errors, rate limits, network issues. Operator can still submit with default voice.

## Anti-Patterns to Avoid

### Anti-Pattern 1: PATCH Agent Voice Before Each Batch
**What:** Using `PATCH /v1/convai/agents/{agent_id}` to change voice before submitting.
**Why bad:** Mutates shared state. Race conditions with concurrent operators. Extra API call.
**Instead:** Use `conversation_config_override.tts.voice_id` per recipient.

### Anti-Pattern 2: Client-Side API Calls from Sidebar
**What:** Fetching voices directly from sidebar JavaScript using `fetch()`.
**Why bad:** Exposes API key in client-side code. GAS sidebar is sandboxed.
**Instead:** All API calls through `google.script.run` to server-side functions.

### Anti-Pattern 3: Using elevenlabsGet() for v2 Endpoint
**What:** Calling `elevenlabsGet('/v2/voices')` -- helper prepends `CONFIG.API_BASE` which is `/v1`.
**Why bad:** Results in URL `https://api.elevenlabs.io/v1/v2/voices` -- 404 error.
**Instead:** Build the full URL manually for the v2 voices endpoint.

### Anti-Pattern 4: Setting Empty Override Fields
**What:** Including `voice_id: ""` or `voice_id: null` in the override.
**Why bad:** Per ElevenLabs docs: "omit any fields you don't want to override rather than setting them to empty strings or null values."
**Instead:** Only include `conversation_config_override` block when a voice is actually selected.

## Suggested Implementation Order

### Step 1: Enable TTS Override in Dashboard (manual, no code)
- Open ElevenLabs dashboard -> Agent -> Security tab
- Enable "Voice ID" override
- **Risk:** LOW -- one-time toggle
- **Blocking:** All voice selection features depend on this

### Step 2: Deploy Variable Mapping Fix (no new code)
- Copy existing `elevenlabs-apps-script.js` into Apps Script editor
- Test with a small batch to verify variables reach the agent
- **Risk:** LOW -- code already written

### Step 3: Add Voice List Server Functions
- Add `getVoiceList()` with CacheService caching
- Add `getLastUsedVoiceId()` to read from ScriptProperties
- Build full URL for v2 endpoint (do not use elevenlabsGet helper)
- **Risk:** LOW -- isolated read-only functions

### Step 4: Integrate Voice Override into submitBatchCall
- Read `eventVars.voice_id` in `submitBatchCall()`
- Add `conversation_config_override.tts.voice_id` to each recipient
- Store last-used voice in ScriptProperties
- Only add override block if voice_id is present
- **Risk:** MEDIUM -- modifies batch payload

### Step 5: Update Sidebar HTML
- Add voice dropdown between header and first form field
- Wire async voice list population on sidebar load
- Add voice_id to eventVars in submit function
- **Risk:** LOW -- UI only

### Step 6: End-to-End Test
- Verify voice dropdown loads
- Select non-default voice, submit with 1-2 test numbers
- Confirm call uses selected voice and variables are personalized
- Check default agent voice unchanged after batch

## Sources

- [ElevenLabs Overrides Documentation](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides) -- conversation_config_override structure, Security tab prerequisites (HIGH confidence)
- [ElevenLabs Submit Batch Calling Job](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- recipient schema confirming conversation_config_override support (HIGH confidence)
- [ElevenLabs List Voices API (v2)](https://elevenlabs.io/docs/api-reference/voices/search) -- GET /v2/voices with pagination (HIGH confidence)
- [Google Apps Script CacheService](https://developers.google.com/apps-script/reference/cache/cache-service) -- TTL, size limits (HIGH confidence)
- [Google Apps Script HTML Service Communication](https://developers.google.com/apps-script/guides/html/communication) -- google.script.run patterns (HIGH confidence)
- [Apps Script CacheService Limits](https://justin.poehnelt.com/posts/exploring-apps-script-cacheservice-limits/) -- 100KB value, 1000 items, 6hr max TTL (MEDIUM confidence)
