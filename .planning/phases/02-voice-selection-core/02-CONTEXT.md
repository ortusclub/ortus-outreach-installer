# Phase 2: Voice Selection Core - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a voice selection dropdown to the Google Sheets sidebar that fetches available voices from the ElevenLabs `/v2/voices` API, displays them with labels, and injects the selected voice into the batch call payload via `conversation_config_override.tts.voice_id`. Persist last-used voice across sessions.

</domain>

<decisions>
## Implementation Decisions

### Dropdown Placement
- **D-01:** Voice dropdown goes directly below the "Caller Name" field, before "Host Name". Groups voice + caller identity together at the top of the sidebar.
- **D-02:** Use a standard `<select>` element with a `<label>VOICE</label>` matching the existing sidebar styling (`.field` class, uppercase label, 13px font).

### Voice Display
- **D-03:** Each dropdown option shows voice name + labels (accent, gender, tone) inline — e.g. "Alice — British, Female, Clear". Parse the `labels` object from the `/v2/voices` API response.
- **D-04:** Bookmarked voices appear at the top of the dropdown (VOICE-07 is Phase 3 scope, but structure the data to support it).

### Caching Strategy
- **D-05:** Use `CacheService.getScriptCache()` with 1-hour TTL to cache the voice list JSON. This is a new pattern for this codebase but the correct GAS tool for ephemeral caching.
- **D-06:** On sidebar open, try cache first. On cache miss, fetch from `/v2/voices?page_size=100&sort=name`. Store the serialized voice list in cache.
- **D-07:** The `elevenlabsGet()` helper prepends `/v1`, so the voice list endpoint must use a manually constructed full URL: `https://api.elevenlabs.io/v2/voices?page_size=100&sort=name`.

### Default Behavior
- **D-08:** First-time use: dropdown shows "Agent default voice" as placeholder option. No voice is pre-selected.
- **D-09:** If operator doesn't pick a voice, `conversation_config_override` is omitted entirely from the payload — agent uses its configured default (VOICE-08).
- **D-10:** After first use: last-used voice ID is stored in `PropertiesService.getUserProperties()` and pre-selected on next sidebar open (VOICE-04).

### Voice Override Injection
- **D-11:** Use per-recipient `conversation_initiation_client_data.conversation_config_override.tts.voice_id` — NOT agent-level PATCH. This is non-destructive and avoids race conditions.
- **D-12:** The override sits alongside `dynamic_variables` as a sibling under `conversation_initiation_client_data`. Both go into the same recipient object in `submitBatchCall()`.

### Loading State
- **D-13:** Show "Loading voices..." as the dropdown's initial placeholder text while the API call completes. Replace with voice options on success. Show "Error loading voices" on failure.

### Claude's Discretion
- Exact HTML/CSS for the dropdown (follow existing sidebar patterns — `.field`, `.btn`, etc.)
- Error handling if `/v2/voices` API fails (show error in dropdown, allow submission without voice selection)
- How to structure the `getVoiceList()` server-side function (cache check, fetch, parse, return)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code
- `elevenlabs-apps-script.js` — Complete Apps Script source. Key areas:
  - Lines 182-201: `conversation_initiation_client_data.dynamic_variables` nesting (sibling to where voice override goes)
  - Lines 505-545: `elevenlabsGet()` / `elevenlabsPost()` helpers (note: prepends `/v1`)
  - Lines 621-632: `listAgents()` — existing pattern for fetching from ElevenLabs API
  - Lines 663-833: `getSidebarHtml()` — the HTML string that defines the sidebar UI
  - Lines 496-502: `getApiKey()` / `getPhoneNumberId()` — PropertiesService pattern

### Research
- `.planning/research/STACK.md` — API endpoints (`/v2/voices`, per-recipient override format)
- `.planning/research/ARCHITECTURE.md` — Data flow, caching strategy, override injection pattern
- `.planning/research/PITFALLS.md` — v2 endpoint URL quirk, empty override pitfall, CacheService limits

### Prior Phase
- `.planning/phases/01-foundation-fix/01-CONTEXT.md` — Phase 1 decisions (deployment method, agent IDs)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `elevenlabsGet()` — API helper, but prepends `/v1`. Cannot use for `/v2/voices` — need manual URL construction
- `listAgents()` (line 621) — Pattern for fetching lists from ElevenLabs API and returning to sidebar
- `getApiKey()` (line 498) — Established pattern for API key retrieval
- `getSidebarHtml()` (line 663) — All sidebar HTML is a single string. New dropdown goes here.
- `PropertiesService.getScriptProperties()` — Used for API key, phone number ID, batch ID. Use `getUserProperties()` for per-user voice preference.

### Established Patterns
- Server-side functions exposed to sidebar via `google.script.run` (see `submit()` function in sidebar JS)
- All HTML is a single inline string returned by `getSidebarHtml()`
- CSS uses `.field`, `.btn`, `.btn-primary`, `.status` classes with gold (#C5A255) accent
- `var` declarations throughout (V8 runtime, but existing style is `var`)

### Integration Points
- `submitBatchCall(eventVars, selectedOnly)` — Add `voiceId` parameter or include in eventVars
- Recipient object builder (lines 182-201) — Add `conversation_config_override.tts` alongside `dynamic_variables`
- Sidebar `submit()` JS function (line 766) — Collect voice selection and pass to `submitBatchCall()`

</code_context>

<specifics>
## Specific Ideas

- Research confirmed: `conversation_config_override` and `dynamic_variables` are siblings under `conversation_initiation_client_data` — clean addition to existing recipient builder
- The `/v2/voices` response includes `voice_id`, `name`, `labels` (object with accent, gender, tone), `preview_url`, `is_bookmarked` — all needed for current and Phase 3 features
- CacheService value limit is 100KB — voice list JSON should fit comfortably
- `PropertiesService.getUserProperties()` is per-user (vs `getScriptProperties()` which is shared) — correct for personal voice preference

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-voice-selection-core*
*Context gathered: 2026-03-31*
