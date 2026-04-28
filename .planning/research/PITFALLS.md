# Domain Pitfalls

**Domain:** ElevenLabs Voice Selection + Dynamic Variable Mapping in Google Apps Script
**Researched:** 2026-03-31

## Critical Pitfalls

Mistakes that cause batch calls to fail or variables to be silently dropped.

### Pitfall 1: Agent Security Settings Not Enabling TTS Override
**What goes wrong:** You pass `conversation_config_override.tts.voice_id` in the batch payload, but the agent's Security tab in ElevenLabs dashboard does not have TTS override enabled. The batch call either fails entirely or ignores the override silently.
**Why it happens:** Override fields are disabled by default for security. The API docs mention this but it is easy to miss.
**Consequences:** Voice selection appears to work in the sidebar but all calls use the agent's default voice. Operators think they selected "George" but calls go out as "Alice."
**Prevention:** Before writing any code, go to ElevenLabs dashboard > Agent > Security tab > Enable TTS override. Document this as a prerequisite in deployment instructions.
**Detection:** Submit a test batch with a non-default voice. If the call uses the default voice, override is not enabled.

### Pitfall 2: Dynamic Variables Not Defined in Agent Configuration
**What goes wrong:** You pass `dynamic_variables: { host_name: "Jane Doe" }` in the API payload, but the agent's prompt template does not reference `{{host_name}}` or the variable is not registered in the agent's configuration.
**Why it happens:** Dynamic variables must exist in BOTH the API payload AND the agent's template. Passing them via API alone does nothing.
**Consequences:** Agent uses fallback text or says literal placeholder names. Calls sound broken: "Hi, I'm calling on behalf of [blank]."
**Prevention:** Audit the agent's prompt in ElevenLabs dashboard. Verify all 14 variables (`caller_name`, `host_name`, `host_first_name`, `event_name`, `event_date`, `event_time`, `event_city`, `event_area`, `event_venue`, `event_format`, `event_context`, `target_audience`, `prospect_name`, `prospect_email`) are referenced in the prompt template.
**Detection:** Make a test call. Listen for missing or placeholder values.

### Pitfall 3: Deploying Voice Selection Without Fixing Variable Nesting
**What goes wrong:** Voice selection ships but the dynamic variable bug (incorrect nesting) is not deployed. Operators now have a shiny voice picker but calls still use generic scripts.
**Why it happens:** Variable fix exists locally but not in Apps Script editor. Developer focuses on the new feature and forgets the bug fix.
**Consequences:** Wasted development effort. Operators still get impersonal calls.
**Prevention:** Deploy variable fix FIRST. Verify with a test call. Then add voice selection.
**Detection:** Check that `conversation_initiation_client_data.dynamic_variables` is the structure in the deployed Apps Script (not `dynamic_variables` at the top level of the recipient object).

## Moderate Pitfalls

### Pitfall 4: Google Apps Script `UrlFetchApp` Quota Limits
**What goes wrong:** Fetching voices on every sidebar open may hit GAS daily URL fetch quotas (20,000/day for consumer, more for Workspace).
**Prevention:** Cache voice list in `CacheService` with a 1-hour TTL. Voices rarely change. Also, the sidebar calls `getVoices()` once on open, not per-interaction.

### Pitfall 5: Large Voice Library Overflows Dropdown
**What goes wrong:** Account has 200+ voices (community voices, clones, etc.). Dropdown becomes unusable.
**Prevention:** Filter to `voice_type=default` or `category=premade,professional` by default. Show bookmarked voices first. Add category filter if library is large.

### Pitfall 6: `preview_url` Expiry or CORS in Sidebar
**What goes wrong:** `preview_url` from the API may expire or be blocked by CORS when played from a Google Apps Script sidebar (sandboxed iframe).
**Prevention:** Test audio playback in sidebar immediately during development. If CORS blocks it, proxy through a server-side GAS function that fetches the audio and returns it as base64. Alternatively, use `google.script.run` to fetch and return the URL via server-side.
**Detection:** Preview button does nothing or shows error in browser console.

### Pitfall 7: Forgetting to Pass `voice_id` for ALL Recipients
**What goes wrong:** Voice override is applied to first recipient but loop does not inject it for all.
**Prevention:** Apply `conversation_config_override` at the loop level where recipients are built, not as a one-off.

## Minor Pitfalls

### Pitfall 8: API Key Exposed in Client-Side HTML
**What goes wrong:** Someone fetches voices client-side from the sidebar HTML, embedding the API key in JavaScript.
**Prevention:** All API calls go through server-side GAS functions (`google.script.run.getVoices()`). Never call ElevenLabs API from client-side HTML.

### Pitfall 9: Voice Dropdown Shows voice_id Instead of Name
**What goes wrong:** Dropdown `<option>` value is voice_id but display text is also voice_id.
**Prevention:** Set `<option value="${voice_id}">${name} (${labels})</option>`. Trivial but easy to get wrong in string-templated HTML.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Variable fix deployment | Not verifying agent-side variable definitions | Test call immediately after deploy |
| Voice dropdown | Large voice list, CORS on preview | Filter by category, test audio in sandbox |
| Voice override in payload | Security settings not enabled | Manual dashboard check before coding |
| Persistence | Wrong PropertiesService scope | Use `getUserProperties()` not `getScriptProperties()` for per-user preference |

## Sources

- [ElevenLabs Overrides Documentation](https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides) -- MEDIUM confidence (confirmed via search results)
- [ElevenLabs Batch Calling API](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- HIGH confidence (verified schema shows override will fail if not enabled)
- [Google Apps Script Quotas](https://developers.google.com/apps-script/guides/services/quotas) -- HIGH confidence (known limits)
