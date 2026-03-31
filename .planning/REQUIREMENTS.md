# Requirements: ElevenLabs Calling Integration — Sidebar Enhancements

**Defined:** 2026-03-31
**Core Value:** Reliably pass all sidebar inputs to the ElevenLabs agent and let operators switch voice without leaving the sheet.

## v1 Requirements

### Dashboard Prerequisites

- [ ] **DASH-01**: Enable TTS override in ElevenLabs agent Security settings (manual dashboard step)
- [x] **DASH-02**: Audit agent prompt to ensure all 14 dynamic variables are referenced in the template

### Variable Mapping

- [ ] **VARS-01**: All sidebar inputs (host_name, event_name, event_date, event_time, event_city, event_area, event_venue, event_format, event_context, target_audience, caller_name, host_first_name) are correctly nested under `conversation_initiation_client_data.dynamic_variables` in the batch payload
- [ ] **VARS-02**: Per-lead variables (prospect_name, prospect_email) are correctly nested under `conversation_initiation_client_data.dynamic_variables` per recipient
- [ ] **VARS-03**: Deploy the fixed Apps Script code to the Google Apps Script editor
- [ ] **VARS-04**: Empty required fields are highlighted with red borders and batch submission is blocked until filled

### Voice Selection

- [x] **VOICE-01**: Sidebar displays a voice selection dropdown populated from ElevenLabs `/v2/voices` API
- [ ] **VOICE-02**: Voice dropdown shows loading state while fetching voices from the API
- [x] **VOICE-03**: Selected voice is applied to all recipients in the batch via `conversation_initiation_client_data.conversation_config_override.tts.voice_id`
- [x] **VOICE-04**: Last-used voice is persisted and pre-selected on next sidebar open
- [x] **VOICE-05**: Voice labels (accent, gender, tone) are displayed next to each voice name in the dropdown or below it
- [x] **VOICE-06**: Play button next to dropdown lets operator preview the voice audio before submitting
- [x] **VOICE-07**: Bookmarked/favorited voices appear at the top of the dropdown list
- [x] **VOICE-08**: If no voice is selected, `conversation_config_override` is omitted entirely from the payload (not sent as empty/null)

## v2 Requirements

### Enhanced Calling

- **CALL-01**: Test call button to send a single call to operator's number before batch submission
- **CALL-02**: Voice category filter (premade, cloned, professional)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Agent switching from sidebar | Same agent, different voices covers the use case |
| Voice cloning from sidebar | Separate workflow, use ElevenLabs dashboard |
| Custom TTS settings (stability, speed sliders) | Operators are not audio engineers, adds confusion |
| Real-time call monitoring | Different product surface, use ElevenLabs dashboard |
| Multi-voice per batch (different voice per recipient) | Use case is "one voice for this campaign" |
| Full-text voice search | Small voice library, dropdown + labels is sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DASH-01 | Phase 1 | Pending |
| DASH-02 | Phase 1 | Complete |
| VARS-01 | Phase 1 | Pending |
| VARS-02 | Phase 1 | Pending |
| VARS-03 | Phase 1 | Pending |
| VARS-04 | Phase 3 | Pending |
| VOICE-01 | Phase 2 | Complete |
| VOICE-02 | Phase 2 | Pending |
| VOICE-03 | Phase 2 | Complete |
| VOICE-04 | Phase 2 | Complete |
| VOICE-05 | Phase 3 | Complete |
| VOICE-06 | Phase 3 | Complete |
| VOICE-07 | Phase 3 | Complete |
| VOICE-08 | Phase 2 | Complete |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-31*
*Last updated: 2026-03-31 after initial definition*
