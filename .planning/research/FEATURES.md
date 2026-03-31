# Feature Landscape

**Domain:** ElevenLabs Voice Selection + Dynamic Variable Mapping in Google Apps Script Sidebar
**Researched:** 2026-03-31

## Table Stakes

Features users expect. Missing = integration breaks or is unusable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Voice selection dropdown | Operators need to pick a voice before submitting a batch; current hardcoded Alice/Sarah is inflexible | Medium | Fetch from `/v2/voices` API, populate `<select>`. Each voice object returns `voice_id`, `name`, `category`, `labels`, `preview_url`. |
| Dynamic variable fix (correct nesting) | Variables are not reaching the agent. Without this, every call uses generic fallbacks. This is the core bug. | Low | Local file already has `conversation_initiation_client_data.dynamic_variables` nesting. Needs to be deployed to Apps Script editor. Verify all 14 sidebar fields map correctly. |
| Voice override per batch via `conversation_config_override` | The API supports `conversation_initiation_client_data.conversation_config_override` with TTS voice settings (`voice_id`, `stability`, `speed`, `similarity_boost`). Without this, changing voice requires editing the agent in the ElevenLabs dashboard. | Medium | Must enable override in agent Security settings. Pass `conversation_config_override.tts` in each recipient object. This is the correct mechanism -- NOT agent-level voice switching. |
| Persist last-used voice selection | Operators run batches repeatedly. Re-selecting the voice each time is friction. | Low | Use `PropertiesService.getUserProperties()` to store last `voice_id`. Pre-select on sidebar load. |
| Loading state for voice list | API call to fetch voices takes 1-3 seconds. Without loading indicator, dropdown appears broken. | Low | Show "Loading voices..." placeholder in dropdown, replace on success. |

## Differentiators

Features that improve operator UX. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Voice preview (play sample) | Operators hear the voice before committing a batch. `preview_url` is returned per voice from the API -- it is a direct audio URL. | Low | Add a small play button next to dropdown. Use `new Audio(preview_url).play()` in sidebar HTML. Google Apps Script HTML sidebar supports `<audio>` elements. |
| Voice label display (accent, gender, tone) | The `labels` object on each voice contains metadata like accent, age, gender, tone. Showing "British, Female, Warm" helps operators pick without previewing. | Low | Parse `labels` object, display as tags below dropdown. |
| Voice favorites / bookmarks | ElevenLabs API returns `is_bookmarked` and `favorited_at_unix`. Could filter to show only bookmarked voices at top. | Low | Filter or sort by `is_bookmarked === true`. Reduces list from potentially hundreds to operator's curated set. |
| Variable validation before submit | Highlight empty required fields (host_name, event_name) before allowing batch submission. Currently no validation -- operators can submit with blank fields. | Low | Add client-side validation in sidebar JS. Check non-empty for critical fields. Show red borders / warning. |
| Test call (single number) | Before batch-submitting 50+ calls, send one test call to verify voice + variables sound right. | Medium | Submit a batch with a single recipient (operator's own number). Reuses existing `submitBatchCall` with a one-item recipients array. Needs a "Test Call" button + phone number input. |
| Voice category filter | API supports filtering by `category`: premade, cloned, generated, professional. Operators likely want premade + professional only. | Low | Add filter tabs or secondary dropdown. Default to `premade` + `professional`. |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Agent switching from sidebar | PROJECT.md explicitly marks this out of scope. Same agent, different voices. Building agent switching adds complexity and confusion. | Voice override via `conversation_config_override` covers the use case. |
| Voice cloning from sidebar | Cloning requires audio samples, consent verification, and is a separate workflow. Does not belong in a calling sidebar. | Use ElevenLabs dashboard for voice creation. Sidebar only selects from existing voices. |
| Custom TTS settings (stability, speed sliders) | Operators are not audio engineers. Exposing raw TTS parameters creates confusion and bad-sounding calls. | Use ElevenLabs default settings per voice. Only override `voice_id`, not tuning parameters. |
| Real-time call monitoring | Listening to calls in progress is a different product surface. Sidebar is for batch submission, not call center management. | Check batch status after completion. Use ElevenLabs dashboard for real-time monitoring. |
| Voice search with full-text | The `/v2/voices` API supports `search` parameter, but with a small voice library (tens, not thousands), a dropdown with labels is sufficient. Search adds UI complexity. | Simple dropdown + optional category filter. |
| Multi-voice per batch (different voice per recipient) | The API technically supports per-recipient `conversation_config_override`, but the use case is "one voice for this campaign." Per-recipient voice adds massive UX complexity. | Single voice selector applies to all recipients in the batch. |

## Feature Dependencies

```
Fix dynamic variable nesting (deploy to Apps Script)
    |
    v
Voice selection dropdown (fetch /v2/voices)
    |
    v
Voice override per batch (conversation_config_override)
    |                          |
    v                          v
Voice preview (play button)    Persist last-used voice
    |
    v
Test call (single recipient)
    |
    v
Variable validation (client-side)
```

**Critical dependency:** The dynamic variable fix must be deployed first. Without it, even voice selection is pointless because the agent will not receive personalization data.

**Voice override dependency:** The agent's Security settings in ElevenLabs dashboard must have TTS override enabled. Without this, passing `conversation_config_override` will cause the batch call to fail. This is a one-time manual step.

## MVP Recommendation

**Phase 1 -- Fix + Voice Selection (must ship together):**
1. Deploy dynamic variable fix (already written, just needs paste into Apps Script editor)
2. Voice selection dropdown (fetch voices, show name + labels)
3. Voice override in batch payload (`conversation_config_override.tts.voice_id`)
4. Persist last-used voice
5. Loading state for voice list

**Phase 2 -- Polish:**
6. Voice preview (play button)
7. Variable validation before submit
8. Voice favorites filter

**Defer:**
- Test call: Valuable but operators can test by selecting one row. Not worth a separate UI flow yet.
- Voice category filter: Only needed if voice library grows large. Start without it.

## API Details for Implementation

### Fetching Voices

```
GET /v2/voices
Header: xi-api-key: {API_KEY}
Params: page_size=100, voice_type=default (or omit for all)
```

Response includes per voice: `voice_id`, `name`, `category`, `labels`, `preview_url`, `is_bookmarked`.

**Note:** This is the v2 endpoint. The older `/v1/voices` endpoint also exists but v2 adds pagination and filtering. In Google Apps Script, use `UrlFetchApp.fetch()` with the API key header.

### Overriding Voice in Batch Call

Each recipient's `conversation_initiation_client_data` supports:

```json
{
  "phone_number": "+44...",
  "conversation_initiation_client_data": {
    "conversation_config_override": {
      "tts": {
        "voice_id": "selected_voice_id_here"
      }
    },
    "dynamic_variables": {
      "prospect_name": "John Smith",
      "host_name": "Jane Doe",
      "event_name": "CIO Roundtable"
    }
  }
}
```

**Prerequisite:** Agent Security settings must have TTS override enabled in the ElevenLabs dashboard.

### Dynamic Variables (Current 14 Fields)

Per the existing sidebar, these variables are passed:
- `prospect_name` (from sheet: First Name + Last Name)
- `prospect_email` (from sheet: Email)
- `caller_name` (sidebar input, default "Sarah")
- `host_name`, `host_first_name` (sidebar inputs)
- `event_name`, `event_date`, `event_time` (sidebar inputs)
- `event_city`, `event_area`, `event_venue` (sidebar inputs)
- `event_format` (sidebar dropdown)
- `event_context`, `target_audience` (sidebar inputs)

All must be defined as dynamic variables in the agent's configuration in the ElevenLabs dashboard, or they will be silently ignored.

## Sources

- [List Voices v2 API](https://elevenlabs.io/docs/api-reference/voices/search) -- HIGH confidence
- [Submit Batch Calling Job](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- HIGH confidence, verified schema
- [Personalization / Overrides](https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides) -- MEDIUM confidence (page was 404 but search results confirmed override mechanism)
- [Dynamic Variables](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables) -- MEDIUM confidence (page 404, confirmed via batch calling docs)
- [Get Voice (preview_url field)](https://elevenlabs.io/docs/api-reference/voices/get) -- HIGH confidence
- [Batch Calling Overview](https://elevenlabs.io/docs/agents-platform/phone-numbers/batch-calls) -- MEDIUM confidence
