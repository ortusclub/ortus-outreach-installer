# Phase 2: Voice Selection Core - Research

**Researched:** 2026-03-31
**Domain:** ElevenLabs Voice API + Google Apps Script sidebar UI
**Confidence:** HIGH

## Summary

Phase 2 adds a voice selection dropdown to the existing ElevenLabs batch calling sidebar in Google Apps Script. The dropdown fetches voices from the ElevenLabs `/v2/voices` API, displays them with labels, caches the result via `CacheService`, persists the last-used voice via `PropertiesService.getUserProperties()`, and injects the selected voice into each recipient's `conversation_config_override.tts.voice_id` in the batch payload.

The existing codebase is a single-file Google Apps Script (`elevenlabs-apps-script.js`) with all sidebar HTML inline in `getSidebarHtml()`. The phase requires: (1) a new server-side `getVoiceList()` function with cache-aside pattern, (2) a new `getLastUsedVoiceId()` function reading user properties, (3) modifications to `submitBatchCall()` to inject the voice override conditionally, (4) sidebar HTML additions for the dropdown with async loading, and (5) sidebar JS changes to collect and pass voice_id.

**Primary recommendation:** Build three new server-side functions (`getVoiceList`, `getLastUsedVoiceId`, `saveLastUsedVoiceId`), modify `submitBatchCall` to conditionally inject `conversation_config_override.tts.voice_id`, and add the dropdown to `getSidebarHtml()` between the Caller Name field and Host Name row. Use `getUserProperties()` (not `getScriptProperties()`) for per-user voice persistence.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Voice dropdown goes directly below the "Caller Name" field, before "Host Name". Groups voice + caller identity together at the top of the sidebar.
- **D-02:** Use a standard `<select>` element with a `<label>VOICE</label>` matching the existing sidebar styling (`.field` class, uppercase label, 13px font).
- **D-03:** Each dropdown option shows voice name + labels (accent, gender, tone) inline -- e.g. "Alice -- British, Female, Clear". Parse the `labels` object from the `/v2/voices` API response.
- **D-04:** Bookmarked voices appear at the top of the dropdown (VOICE-07 is Phase 3 scope, but structure the data to support it).
- **D-05:** Use `CacheService.getScriptCache()` with 1-hour TTL to cache the voice list JSON.
- **D-06:** On sidebar open, try cache first. On cache miss, fetch from `/v2/voices?page_size=100&sort=name`. Store the serialized voice list in cache.
- **D-07:** The `elevenlabsGet()` helper prepends `/v1`, so the voice list endpoint must use a manually constructed full URL: `https://api.elevenlabs.io/v2/voices?page_size=100&sort=name`.
- **D-08:** First-time use: dropdown shows "Agent default voice" as placeholder option. No voice is pre-selected.
- **D-09:** If operator doesn't pick a voice, `conversation_config_override` is omitted entirely from the payload -- agent uses its configured default (VOICE-08).
- **D-10:** After first use: last-used voice ID is stored in `PropertiesService.getUserProperties()` and pre-selected on next sidebar open (VOICE-04).
- **D-11:** Use per-recipient `conversation_initiation_client_data.conversation_config_override.tts.voice_id` -- NOT agent-level PATCH. Non-destructive, avoids race conditions.
- **D-12:** The override sits alongside `dynamic_variables` as a sibling under `conversation_initiation_client_data`. Both go into the same recipient object in `submitBatchCall()`.
- **D-13:** Show "Loading voices..." as the dropdown's initial placeholder text while the API call completes. Replace with voice options on success. Show "Error loading voices" on failure.

### Claude's Discretion
- Exact HTML/CSS for the dropdown (follow existing sidebar patterns -- `.field`, `.btn`, etc.)
- Error handling if `/v2/voices` API fails (show error in dropdown, allow submission without voice selection)
- How to structure the `getVoiceList()` server-side function (cache check, fetch, parse, return)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VOICE-01 | Sidebar displays a voice selection dropdown populated from ElevenLabs `/v2/voices` API | `/v2/voices` endpoint verified: returns `voices` array with `voice_id`, `name`, `labels` (key-value object), `preview_url`, `category`. Use `page_size=100&sort=name`. |
| VOICE-02 | Voice dropdown shows loading state while fetching voices from the API | `google.script.run` is async; show "Loading voices..." placeholder in `<select>`, replace `<option>` elements in success handler. |
| VOICE-03 | Selected voice is applied to all recipients in the batch via `conversation_config_override.tts.voice_id` | Batch calling API confirmed: `conversation_config_override.tts.voice_id` is a valid per-recipient field under `conversation_initiation_client_data`. |
| VOICE-04 | Last-used voice is persisted and pre-selected on next sidebar open | `PropertiesService.getUserProperties()` provides per-user persistence across sessions. 9KB per property limit is plenty for a voice_id string. |
| VOICE-08 | If no voice is selected, `conversation_config_override` is omitted entirely from the payload | Conditional injection: only add `conversation_config_override` block when `voice_id` is truthy. ElevenLabs docs say to omit fields rather than send empty/null. |
</phase_requirements>

## Standard Stack

### Core Platform
| Technology | Version | Purpose | Why Standard |
|------------|---------|---------|--------------|
| Google Apps Script | V8 runtime | Server-side logic, API calls | Already in use; only option for Sheets sidebar |
| HTML Service | Built-in | Sidebar UI rendering | Only option for GAS sidebars |
| CacheService | Built-in | Voice list caching (1hr TTL) | GAS native; ephemeral caching with auto-expiry |
| PropertiesService | Built-in | Last-used voice persistence | GAS native; per-user storage across sessions |

### APIs
| Endpoint | Method | Purpose | Key Parameters |
|----------|--------|---------|----------------|
| `GET /v2/voices` | GET | List available voices with metadata | `page_size=100`, `sort=name`, `sort_direction=asc` |
| `POST /v1/convai/batch-calling/submit` | POST | Submit batch with voice override | `conversation_config_override.tts.voice_id` per recipient |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `CacheService` (voice list) | No cache, fetch every time | 500-1500ms latency per sidebar open; acceptable fallback if cache causes issues |
| `getUserProperties()` (voice pref) | `getScriptProperties()` | ScriptProperties is shared across all users -- wrong for per-user voice preference |
| `/v2/voices` | `/v1/voices` | v1 returns all voices without pagination; v2 has filtering, sorting, `has_more` flag |

## Architecture Patterns

### Recommended Structure (within single file)

The codebase is a single `.gs` file. New code is added as new functions and HTML additions:

```
elevenlabs-apps-script.js
  +-- getVoiceList()           # NEW: fetch voices with cache-aside
  +-- getLastUsedVoiceId()     # NEW: read from UserProperties
  +-- saveLastUsedVoiceId()    # NEW: write to UserProperties
  +-- submitBatchCall()        # MODIFIED: inject voice override conditionally
  +-- getSidebarHtml()         # MODIFIED: add voice dropdown + async loading JS
```

### Pattern 1: Cache-Aside for Voice List
**What:** Check `CacheService` first. On miss, fetch from API, store in cache, return.
**When to use:** Every `getVoiceList()` call (triggered on sidebar open).
**Example:**
```javascript
// Source: GAS CacheService docs + ElevenLabs /v2/voices API
function getVoiceList() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('VOICE_LIST');
  if (cached) return JSON.parse(cached);

  var apiKey = getApiKey();
  var url = 'https://api.elevenlabs.io/v2/voices?page_size=100&sort=name&sort_direction=asc';
  var options = {
    method: 'get',
    headers: { 'xi-api-key': apiKey },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to fetch voices: ' + response.getResponseCode());
  }

  var data = JSON.parse(response.getContentText());
  var voices = (data.voices || []).map(function(v) {
    var labelParts = [];
    if (v.labels) {
      if (v.labels.accent) labelParts.push(v.labels.accent);
      if (v.labels.gender) labelParts.push(v.labels.gender);
      if (v.labels.description) labelParts.push(v.labels.description);
    }
    return {
      voice_id: v.voice_id,
      name: v.name,
      description: labelParts.join(', '),
      category: v.category || '',
      is_bookmarked: v.favorited_at_unix ? true : false
    };
  });

  // Sort: bookmarked first (for Phase 3 readiness per D-04)
  voices.sort(function(a, b) {
    if (a.is_bookmarked && !b.is_bookmarked) return -1;
    if (!a.is_bookmarked && b.is_bookmarked) return 1;
    return 0;
  });

  cache.put('VOICE_LIST', JSON.stringify(voices), 3600);
  return voices;
}
```

### Pattern 2: Conditional Voice Override Injection
**What:** Only add `conversation_config_override` when a voice is actually selected. Omit entirely otherwise.
**When to use:** In `submitBatchCall()` recipient builder loop.
**Example:**
```javascript
// Source: ElevenLabs batch calling API docs
var recipient = {
  phone_number: phone,
  conversation_initiation_client_data: {
    dynamic_variables: {
      prospect_name: prospectName,
      // ... all other variables
    }
  }
};

// Only inject override if voice_id is present (D-09, VOICE-08)
if (eventVars.voice_id) {
  recipient.conversation_initiation_client_data.conversation_config_override = {
    tts: { voice_id: eventVars.voice_id }
  };
}
```

### Pattern 3: Async Dropdown Population on Sidebar Load
**What:** Sidebar loads immediately with "Loading voices..." placeholder. Two parallel `google.script.run` calls fetch voice list and last-used voice ID. On success, populate dropdown and pre-select.
**When to use:** Sidebar initialization.
**Example:**
```javascript
// Source: GAS HTML Service communication docs
var voicesLoaded = false;
var lastVoiceLoaded = false;
var voiceList = [];
var lastVoiceId = '';

google.script.run
  .withSuccessHandler(function(voices) {
    voiceList = voices;
    voicesLoaded = true;
    if (lastVoiceLoaded) populateDropdown();
  })
  .withFailureHandler(function(err) {
    var sel = document.getElementById('voice_id');
    sel.innerHTML = '<option value="">Error loading voices</option>';
  })
  .getVoiceList();

google.script.run
  .withSuccessHandler(function(id) {
    lastVoiceId = id || '';
    lastVoiceLoaded = true;
    if (voicesLoaded) populateDropdown();
  })
  .withFailureHandler(function() {
    lastVoiceLoaded = true;
    if (voicesLoaded) populateDropdown();
  })
  .getLastUsedVoiceId();

function populateDropdown() {
  var sel = document.getElementById('voice_id');
  sel.innerHTML = '<option value="">Agent default voice</option>';
  voiceList.forEach(function(v) {
    var opt = document.createElement('option');
    opt.value = v.voice_id;
    opt.textContent = v.name + (v.description ? ' — ' + v.description : '');
    if (v.voice_id === lastVoiceId) opt.selected = true;
    sel.appendChild(opt);
  });
}
```

### Anti-Patterns to Avoid
- **Using `elevenlabsGet()` for v2 endpoint:** Helper prepends `/v1` to all paths. URL becomes `https://api.elevenlabs.io/v1/v2/voices` -- 404 error. Build full URL manually.
- **Sending empty voice override:** Setting `voice_id: ""` or `voice_id: null` in the override. ElevenLabs docs: "omit any fields you don't want to override." Omit `conversation_config_override` entirely.
- **Using `getScriptProperties()` for voice preference:** This is shared across all users. Use `getUserProperties()` for per-user state.
- **PATCH agent voice before batch:** Mutates shared agent state, race condition with concurrent operators. Use per-recipient override.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Voice list caching | Custom expiry logic with timestamps | `CacheService.getScriptCache()` with TTL parameter | Built-in TTL, auto-cleanup, 100KB limit per value |
| Per-user state persistence | Global variable or script property per user | `PropertiesService.getUserProperties()` | Per-user isolation is built in, survives sidebar close/reopen |
| Async sidebar communication | `fetch()` from client-side | `google.script.run` with success/failure handlers | Required GAS pattern; keeps API keys server-side |

## Common Pitfalls

### Pitfall 1: elevenlabsGet() Prepends /v1 to v2 Endpoint
**What goes wrong:** Calling `elevenlabsGet('/v2/voices')` results in URL `https://api.elevenlabs.io/v1/v2/voices` -- 404.
**Why it happens:** The helper function prepends `CONFIG.API_BASE` which is `https://api.elevenlabs.io/v1`.
**How to avoid:** Build the full URL manually: `https://api.elevenlabs.io/v2/voices?page_size=100&sort=name`.
**Warning signs:** 404 error when fetching voices.

### Pitfall 2: Empty Override Causes API Rejection
**What goes wrong:** Sending `conversation_config_override: { tts: { voice_id: "" } }` may cause the API to reject the call or behave unpredictably.
**Why it happens:** ElevenLabs API expects overrides to be omitted, not set to empty values.
**How to avoid:** Wrap the override injection in an `if (eventVars.voice_id)` check. Only add the entire `conversation_config_override` block when a voice is selected.
**Warning signs:** Calls fail or use unexpected voice when "Agent default voice" is selected.

### Pitfall 3: Voice Override Silently Ignored (Security Setting)
**What goes wrong:** Voice override is in the payload but all calls use the agent's default voice.
**Why it happens:** Agent Security settings in ElevenLabs dashboard do not have "Voice ID" override enabled (Phase 1 prerequisite DASH-01).
**How to avoid:** Verify DASH-01 is complete before testing Phase 2 code.
**Warning signs:** Calls go out successfully but always use the same voice regardless of selection.

### Pitfall 4: CacheService Default TTL is 10 Minutes
**What goes wrong:** Voice list expires from cache every 10 minutes instead of every hour.
**Why it happens:** `CacheService.put(key, value)` without a third argument defaults to 600 seconds (10 minutes). Must explicitly pass `3600` as the TTL.
**How to avoid:** Always pass the TTL: `cache.put('VOICE_LIST', JSON.stringify(voices), 3600)`.
**Warning signs:** Frequent API calls visible in GAS execution logs.

### Pitfall 5: PropertiesService Scope Confusion
**What goes wrong:** All operators share the same "last used voice" because `getScriptProperties()` was used instead of `getUserProperties()`.
**Why it happens:** The existing codebase uses `getScriptProperties()` for API key and phone number (which are shared). Easy to follow the same pattern for voice preference.
**How to avoid:** Use `PropertiesService.getUserProperties()` for the `LAST_VOICE_ID` property. This gives each user their own isolated storage.
**Warning signs:** Operator A selects "George", Operator B opens sidebar and sees "George" pre-selected (instead of their own last choice).

### Pitfall 6: Labels Object Structure is Key-Value, Not Fixed Schema
**What goes wrong:** Code references `v.labels.accent` but the `labels` field is a generic key-value object, not a guaranteed schema with `accent`, `gender`, `description` keys.
**Why it happens:** ElevenLabs API docs define `labels` as an object of key-value pairs. Common keys include `accent`, `description`, `gender`, `use_case`, `age` -- but not all voices have all keys.
**How to avoid:** Use defensive access: `v.labels.accent || ''`, filter out empty values, join non-empty labels into the display string.
**Warning signs:** "undefined" appearing in dropdown option text.

### Pitfall 7: Voice Override Applied to Only First Recipient
**What goes wrong:** Only the first call in the batch uses the selected voice; rest use default.
**Why it happens:** `conversation_config_override` injection is placed outside the recipient loop, or applied to a single recipient object instead of within the loop.
**How to avoid:** Apply the override inside the `for` loop that builds each recipient object (lines 159-204 in current code).
**Warning signs:** First call sounds different from subsequent calls in the same batch.

## Code Examples

### Voice Dropdown HTML (insert after Caller Name field, before Host Name row)
```html
<!-- Source: Matches existing sidebar patterns (.field, label, select) -->
<div class="field">
  <label>Voice</label>
  <select id="voice_id">
    <option value="">Loading voices...</option>
  </select>
</div>
```

### Collecting voice_id in Submit Function
```javascript
// Source: Existing submit() pattern in sidebar JS (line 766+)
// Add to eventVars object alongside other fields:
eventVars.voice_id = document.getElementById('voice_id').value;
```

### Saving and Loading Last-Used Voice
```javascript
// Source: GAS PropertiesService docs
function getLastUsedVoiceId() {
  return PropertiesService.getUserProperties().getProperty('LAST_VOICE_ID') || '';
}

function saveLastUsedVoiceId(voiceId) {
  if (voiceId) {
    PropertiesService.getUserProperties().setProperty('LAST_VOICE_ID', voiceId);
  }
}
```

### Modified submitBatchCall Recipient Builder
```javascript
// Source: Existing recipient builder (line 182-201) + ElevenLabs batch API docs
var recipient = {
  phone_number: phone,
  conversation_initiation_client_data: {
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

// Conditionally inject voice override (D-09 / VOICE-08)
if (eventVars.voice_id) {
  recipient.conversation_initiation_client_data.conversation_config_override = {
    tts: { voice_id: eventVars.voice_id }
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `/v1/voices` (list all) | `/v2/voices` (paginated, filterable) | ElevenLabs API v2 | Better for large libraries; has `has_more` pagination flag |
| Agent-level PATCH for voice | Per-recipient `conversation_config_override` | Batch calling API design | Non-destructive, no race conditions |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual testing (GAS has no built-in test framework) |
| Config file | none |
| Quick run command | Open sidebar, select voice, submit 1-lead test batch |
| Full suite command | Test all 5 success criteria manually |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VOICE-01 | Dropdown populated with voices from API | manual | Open sidebar, verify dropdown has voices | N/A |
| VOICE-02 | Loading state shown while fetching | manual | Open sidebar on cache miss, observe "Loading voices..." | N/A |
| VOICE-03 | Selected voice used in batch payload | manual | Select non-default voice, submit 1-lead batch, verify via GAS execution log | N/A |
| VOICE-04 | Last-used voice pre-selected on reopen | manual | Select voice, close sidebar, reopen, verify pre-selection | N/A |
| VOICE-08 | No voice = no override in payload | manual | Leave "Agent default voice" selected, submit batch, check GAS execution log for absent conversation_config_override | N/A |

### Sampling Rate
- **Per task commit:** Paste into Apps Script editor, open sidebar, verify change
- **Per wave merge:** Full 5-criteria manual test
- **Phase gate:** All 5 success criteria verified before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Add `Logger.log` statements in `submitBatchCall()` to log the full payload JSON for debugging voice override injection
- [ ] Add `Logger.log` in `getVoiceList()` to log cache hit/miss and voice count

## Open Questions

1. **Voice labels object keys**
   - What we know: The `labels` field is a key-value object. Common keys are `accent`, `description`, `gender`, `use_case`, `age`.
   - What's unclear: Whether all voices consistently have `accent`, `gender`, and `description` keys, or if some are missing or named differently.
   - Recommendation: Use defensive access with fallbacks. Join non-empty label values. Test with actual API response during implementation.

2. **Number of voices in account**
   - What we know: `page_size=100` is the max per page. If the account has more than 100 voices, pagination via `next_page_token` would be needed.
   - What's unclear: How many voices the Ortus account actually has.
   - Recommendation: Start with `page_size=100`. If `has_more` is true in the response, log a warning. Pagination can be added if needed -- unlikely for a business account.

3. **Bookmarked voices detection**
   - What we know: The v2 API response includes `favorited_at_unix` (integer timestamp) per voice. A non-zero value means the voice is bookmarked/favorited by the user.
   - What's unclear: Whether bookmarking is per-API-key or per-user within an organization.
   - Recommendation: Per D-04, sort bookmarked voices to top. Use `favorited_at_unix > 0` as the check. This is Phase 3 scope (VOICE-07) but data structure supports it now.

## Project Constraints (from CLAUDE.md)

- **Runtime**: Google Apps Script (V8 engine, no ES modules, no npm)
- **Deployment**: Code is pasted into Apps Script editor; sidebar uses HEAD deployment
- **Style**: Use `var` declarations (existing codebase convention), not `let`/`const`
- **UI**: Single inline HTML string in `getSidebarHtml()` -- no separate HTML files
- **API calls**: All through server-side GAS functions via `google.script.run`; never from client-side
- **GSD Workflow**: Do not make direct repo edits outside a GSD workflow unless user explicitly asks

## Sources

### Primary (HIGH confidence)
- [ElevenLabs List Voices v2](https://elevenlabs.io/docs/api-reference/voices/search) -- endpoint schema, query params, response format verified
- [ElevenLabs Batch Calling Submit](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- recipient schema, `conversation_config_override.tts.voice_id` confirmed
- [Google Apps Script CacheService](https://developers.google.com/apps-script/reference/cache/cache-service) -- TTL, value limits, getScriptCache vs getUserCache
- [Google Apps Script PropertiesService](https://developers.google.com/apps-script/reference/properties/properties-service) -- getUserProperties vs getScriptProperties scope
- [Google Apps Script HTML Service Communication](https://developers.google.com/apps-script/guides/html/communication) -- google.script.run patterns

### Secondary (MEDIUM confidence)
- [Apps Script CacheService Limits](https://justin.poehnelt.com/posts/exploring-apps-script-cacheservice-limits/) -- 100KB per value, 1000 items, 6hr max TTL, default 10min TTL

### Tertiary (LOW confidence)
- None -- all findings verified with official sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- GAS built-ins are the only option; API endpoints verified against official docs
- Architecture: HIGH -- patterns follow existing codebase conventions; API schemas confirmed
- Pitfalls: HIGH -- each pitfall traced to specific code lines or API behavior documented in official sources

**Research date:** 2026-03-31
**Valid until:** 2026-04-30 (stable domain -- GAS and ElevenLabs API unlikely to change in 30 days)
