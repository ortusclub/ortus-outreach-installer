# Project Research Summary

**Project:** ElevenLabs Voice Selection + Variable Mapping
**Domain:** Google Apps Script sidebar integration with ElevenLabs Conversational AI batch calling API
**Researched:** 2026-03-31
**Confidence:** HIGH

## Executive Summary

This project adds voice selection and fixes dynamic variable mapping in an existing Google Apps Script sidebar that submits batch outbound calls via the ElevenLabs API. The existing system works but has two problems: variables are not reaching the agent due to incorrect payload nesting, and the voice is hardcoded. Both are solvable with well-documented API mechanisms and zero new dependencies.

The recommended approach is straightforward: fix the variable nesting bug first (code already exists locally, just needs deployment), then add a voice dropdown that fetches from the `/v2/voices` endpoint and injects a per-recipient `conversation_config_override.tts.voice_id` into the batch payload. This is a non-destructive override -- the agent's default voice is never mutated, avoiding race conditions if multiple operators submit simultaneously. The entire implementation stays within the existing single-file GAS architecture using native services (UrlFetchApp, CacheService, PropertiesService).

The primary risk is a silent failure mode: if the agent's Security tab in the ElevenLabs dashboard does not have TTS override enabled, voice selection will appear to work but calls will use the default voice. This is a one-time manual toggle but must happen before any code is written. The secondary risk is deploying voice selection without the variable fix, which would give operators a polished UI over a broken foundation. The mitigation is simple: deploy and test the variable fix first, then layer voice selection on top.

## Key Findings

### Recommended Stack

No new technologies required. The entire implementation uses native Google Apps Script services. See [STACK.md](STACK.md) for details.

**Core technologies:**
- **Google Apps Script (V8 runtime):** Server-side logic, API proxy -- only option for Sheets sidebar
- **ElevenLabs `/v2/voices` API:** Voice list with pagination, labels, preview URLs -- replaces legacy v1 endpoint
- **ElevenLabs `/v1/convai/batch-calling/submit`:** Existing batch endpoint, now with `conversation_config_override` for voice override
- **CacheService:** 1-hour TTL cache for voice list -- avoids redundant API calls
- **PropertiesService:** Persists last-used voice across sessions

### Expected Features

See [FEATURES.md](FEATURES.md) for full landscape and API details.

**Must have (table stakes):**
- Dynamic variable fix (correct `conversation_initiation_client_data.dynamic_variables` nesting) -- this is the core bug
- Voice selection dropdown populated from `/v2/voices`
- Voice override per batch via `conversation_config_override.tts.voice_id`
- Persist last-used voice selection
- Loading state for voice dropdown

**Should have (differentiators):**
- Voice preview (play sample via `preview_url`)
- Voice label display (accent, gender, tone from `labels` object)
- Variable validation before submit (highlight empty required fields)
- Voice favorites/bookmarks filter (using `is_bookmarked` from API)

**Defer (v2+):**
- Test call button (operators can test by selecting one row)
- Voice category filter (only needed if voice library grows large)
- Custom TTS settings (stability, speed sliders) -- explicitly an anti-feature

### Architecture Approach

Single-file GAS with server-side functions exposed to HTML sidebar via `google.script.run`. No architectural changes to existing pattern. Voice selection adds two new server functions (`getVoiceList()`, `getLastUsedVoiceId()`) and modifies `submitBatchCall()` to inject the override. See [ARCHITECTURE.md](ARCHITECTURE.md) for full data flows and code samples.

**Major components:**
1. **Sidebar HTML** -- voice dropdown + existing form fields, communicates via `google.script.run`
2. **`getVoiceList()` (new)** -- fetches `/v2/voices`, caches in CacheService for 1 hour
3. **`submitBatchCall()` (modified)** -- injects `conversation_config_override.tts.voice_id` per recipient alongside `dynamic_variables`

**Key patterns:**
- Server-side API proxy (never expose API key to sidebar)
- Non-destructive voice override (per-recipient, not agent-level PATCH)
- Cache-aside for voice data (CacheService with 1hr TTL)
- Progressive enhancement (sidebar loads immediately, voice dropdown populates async)

### Critical Pitfalls

See [PITFALLS.md](PITFALLS.md) for full list with detection strategies.

1. **Agent Security settings not enabling TTS override** -- go to ElevenLabs dashboard > Agent > Security tab > enable TTS override BEFORE writing code. Without this, voice selection silently does nothing.
2. **Dynamic variables not defined in agent configuration** -- all 14 variables must be referenced in the agent's prompt template, not just passed via API. Audit the agent prompt.
3. **Deploying voice selection without fixing variable nesting** -- the variable fix exists locally but is not deployed. Ship the fix first, test with a call, then add voice features.
4. **Using `elevenlabsGet()` helper for v2 endpoint** -- the helper prepends `/v1`, resulting in `/v1/v2/voices` (404). Build the full URL manually for the v2 endpoint.
5. **Setting empty override fields** -- omit `conversation_config_override` entirely if no voice is selected. Empty string or null values cause errors per ElevenLabs docs.

## Implications for Roadmap

Based on research, this is a 3-phase implementation with strong dependency ordering.

### Phase 1: Foundation Fix + Dashboard Prerequisites
**Rationale:** Everything depends on the variable fix being deployed and the dashboard toggle being set. This is zero-code (or existing-code) work that unblocks all subsequent phases.
**Delivers:** Working dynamic variables in batch calls, TTS override capability enabled
**Addresses:** Dynamic variable fix (table stakes), agent Security settings prerequisite
**Avoids:** Pitfall 3 (deploying features on broken foundation), Pitfall 1 (override not enabled), Pitfall 2 (variables not in agent template)
**Effort:** Low -- deploy existing code, toggle dashboard setting, audit agent prompt, test call

### Phase 2: Voice Selection Core
**Rationale:** With the foundation solid, add the voice picker. The dropdown, override injection, and persistence form a natural unit -- shipping any one without the others is incomplete.
**Delivers:** Functional voice selection dropdown with per-batch override and last-used persistence
**Addresses:** Voice selection dropdown, voice override per batch, persist last-used voice, loading state (all table stakes)
**Avoids:** Pitfall 4 (API quotas -- uses CacheService), Pitfall 7 (applies override to ALL recipients in loop), Pitfall 8 (server-side API proxy)
**Effort:** Medium -- new `getVoiceList()` function, modify `submitBatchCall()`, update sidebar HTML

### Phase 3: UX Polish
**Rationale:** With core functionality working, add quality-of-life features. These are independent of each other and can be shipped incrementally.
**Delivers:** Voice preview playback, label display, input validation, bookmarks filter
**Addresses:** Voice preview, voice labels, variable validation, favorites filter (all differentiators)
**Avoids:** Pitfall 6 (CORS on preview_url -- test early, proxy if needed), Pitfall 5 (large voice list -- filter by bookmarks/category)
**Effort:** Low per feature -- each is an isolated UI addition

### Phase Ordering Rationale

- Phase 1 before Phase 2 is mandatory: voice override will not work without the dashboard toggle, and shipping a voice picker on top of broken variables wastes operator trust.
- Phase 2 groups all voice-related server + client changes together because they share the same data flow (fetch voices -> select -> inject into payload).
- Phase 3 items are independent enhancements that each add value alone. Voice preview should be tested early due to potential CORS issues in the GAS sidebar sandbox.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (voice preview):** CORS behavior in Google Apps Script sandboxed iframes is uncertain. The `preview_url` from ElevenLabs may require server-side proxying. Test this early.

Phases with standard patterns (skip research-phase):
- **Phase 1:** No code to research -- deploy existing file, toggle dashboard setting, audit prompt.
- **Phase 2:** Well-documented API endpoints with verified schemas. Architecture doc includes working code samples. Standard GAS patterns throughout.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. All native GAS services. No version risk. |
| Features | HIGH | API response schemas verified. Feature set is small and well-scoped. Anti-features clearly defined. |
| Architecture | HIGH | Data flows documented with code samples. Override mechanism confirmed from official API schema. |
| Pitfalls | HIGH | Critical pitfalls are concrete and actionable. Detection strategies provided for each. |

**Overall confidence:** HIGH

### Gaps to Address

- **Override failure mode:** Some ElevenLabs docs returned 404 during research. The override mechanism is confirmed via batch calling API schema, but exact error behavior when Security settings are disabled needs live testing.
- **`preview_url` playback in GAS sidebar:** Untested whether audio playback works in the sandboxed iframe. If blocked, will need server-side audio proxying (base64 approach documented in ARCHITECTURE.md).
- **PropertiesService scope:** PITFALLS.md flags using `getUserProperties()` for per-user preference vs `getScriptProperties()` for shared state. The correct scope depends on whether multiple operators use the same Google account -- needs clarification during Phase 2 planning.
- **Voice library size:** Unknown how many voices are in the account. Affects whether category filtering is needed in Phase 2 vs Phase 3.

## Sources

### Primary (HIGH confidence)
- [ElevenLabs List Voices v2](https://elevenlabs.io/docs/api-reference/voices/search) -- voice list schema, pagination, labels
- [ElevenLabs Batch Calling Submit](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- recipient schema, conversation_config_override support
- [ElevenLabs Get Voice](https://elevenlabs.io/docs/api-reference/voices/get) -- preview_url field confirmation
- [Google Apps Script CacheService](https://developers.google.com/apps-script/reference/cache/cache-service) -- TTL, size limits
- [Google Apps Script HTML Service](https://developers.google.com/apps-script/guides/html/communication) -- google.script.run patterns
- [Google Apps Script Quotas](https://developers.google.com/apps-script/guides/services/quotas) -- URL fetch limits

### Secondary (MEDIUM confidence)
- [ElevenLabs Overrides Documentation](https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides) -- override structure confirmed via search results, page was 404
- [ElevenLabs Dynamic Variables](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables) -- confirmed via batch calling docs, page was 404
- [ElevenLabs Batch Calling Overview](https://elevenlabs.io/docs/agents-platform/phone-numbers/batch-calls) -- general batch calling patterns
- [Apps Script CacheService Limits](https://justin.poehnelt.com/posts/exploring-apps-script-cacheservice-limits/) -- 100KB value limit, 6hr max TTL

---
*Research completed: 2026-03-31*
*Ready for roadmap: yes*
