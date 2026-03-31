# Phase 3: UX Polish - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Add voice preview playback, voice label display, bookmarked voice sorting, and required field validation to the Google Sheets sidebar.

</domain>

<decisions>
## Implementation Decisions

### Voice Preview
- **D-01:** Small play button (▶) next to the voice dropdown. Click to play/stop the selected voice's sample.
- **D-02:** Use server-side proxy for audio — add a `getVoicePreview(voiceId)` server function that fetches the preview audio from ElevenLabs and returns it as base64. This guarantees playback in the GAS sandbox regardless of CORS.
- **D-03:** Client-side plays audio via `new Audio("data:audio/mpeg;base64," + base64data)`.
- **D-04:** Button shows ▶ when stopped, ■ when playing. Clicking while playing stops playback.

### Voice Labels
- **D-05:** Keep the current Phase 2 format: "Name - accent, gender, description" in the dropdown option text. No separate label tags or colored badges needed — the inline format is sufficient.
- **D-06:** The `/v1/voices` API `labels` object provides accent, gender, description fields. Already parsed in `getVoiceList()`.

### Bookmarked Voices
- **D-07:** Bookmarked/favorited voices sort to the top of the dropdown list.
- **D-08:** The `/v1/voices` API doesn't return `is_bookmarked` or `favorited_at_unix` reliably (was null in testing). May need to check the `/v2/voices` response or use a different field. Research should verify.

### Input Validation
- **D-09:** All 14 sidebar fields are required (carried from Phase 1 D-03). Block submission entirely if any are empty.
- **D-10:** Empty required fields get red borders (CSS class `.field-error` with `border-color: #c62828`).
- **D-11:** Submit button is disabled until all required fields are filled. Show a validation message below the button listing which fields are empty.
- **D-12:** Validation runs on submit click, not on every keystroke (simpler, less distracting).

### Implementation Constraints (from Phase 2 lessons)
- **D-13:** NO `//` comments in sidebar JS — GAS renders the script as a single line, so `//` comments destroy everything after them.
- **D-14:** NO single quotes `''` inside the GAS HTML string — use double quotes `""` for all JS strings inside `getSidebarHtml()`.
- **D-15:** Use `createElement`/`appendChild` instead of `innerHTML` string assignments where possible to avoid escaping issues.

### Claude's Discretion
- Exact CSS for the play button (should match existing gold accent #C5A255)
- How to handle the case where a voice has no preview_url
- Whether to cache preview audio or fetch each time (fetch each time is fine — previews are small)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code
- `elevenlabs-apps-script.js` — Complete Apps Script source. Key areas:
  - Lines 678-720: `getVoiceList()` — fetches and parses voices (labels already extracted)
  - Lines 780-784: Voice dropdown HTML in `getSidebarHtml()`
  - Lines 900-927: Voice loading JS (async, createElement pattern)
  - Lines 836-876: `submit()` function — where validation should be added

### Prior Phases
- `.planning/phases/01-foundation-fix/01-CONTEXT.md` — D-03: all 14 variables required
- `.planning/phases/02-voice-selection-core/02-CONTEXT.md` — D-05 CacheService, D-07 v2 URL quirk, D-13 loading state

### Research
- `.planning/research/PITFALLS.md` — CORS behavior for preview_url in GAS sandbox

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getVoiceList()` already returns `voice_id`, `name`, `description`, `category` — voice data is ready
- Sidebar CSS already has `.field`, `.btn`, `.status-err` classes
- `showStatus()` function in sidebar JS for displaying messages

### Established Patterns
- `google.script.run.withSuccessHandler().withFailureHandler()` for async calls
- `createElement`/`appendChild` for DOM manipulation (Phase 2 pattern)
- Gold accent color: `#C5A255`, error red from existing `.status-err`: `#c62828`

### Integration Points
- Voice dropdown (id `voice_id`) — add play button next to it
- `submit()` function — add validation before `google.script.run.submitBatchCall()`
- `getVoiceList()` — may need to add `preview_url` to the returned voice objects

</code_context>

<specifics>
## Specific Ideas

- Preview URLs from the API look like `https://storage.googleapis.com/eleven-public-prod/...` — almost certainly CORS-blocked in GAS iframe
- The `getVoicePreview` server function can use `UrlFetchApp.fetch(preview_url)` then `Utilities.base64Encode(response.getBlob().getBytes())` to return base64 audio
- Need to add `preview_url` to the voice objects returned by `getVoiceList()` — currently stripped out

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-ux-polish*
*Context gathered: 2026-03-31*
