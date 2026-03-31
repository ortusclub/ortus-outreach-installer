# Roadmap: ElevenLabs Calling Integration — Sidebar Enhancements

## Overview

This project fixes the broken dynamic variable mapping in the ElevenLabs batch calling sidebar, then layers voice selection on top so operators can pick a calling voice without leaving Google Sheets. Phase 1 deploys the existing variable fix and enables the dashboard prerequisites. Phase 2 adds a functional voice dropdown with per-batch override. Phase 3 polishes the experience with voice previews, labels, bookmarks, and input validation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation Fix** - Deploy variable mapping fix, enable TTS override, audit agent prompt
- [ ] **Phase 2: Voice Selection Core** - Voice dropdown with per-batch override and last-used persistence
- [ ] **Phase 3: UX Polish** - Voice previews, labels, bookmarks, and input validation

## Phase Details

### Phase 1: Foundation Fix
**Goal**: Batch calls receive all sidebar-entered event details as dynamic variables, and the agent is ready to accept voice overrides
**Depends on**: Nothing (first phase)
**Requirements**: DASH-01, DASH-02, VARS-01, VARS-02, VARS-03
**Success Criteria** (what must be TRUE):
  1. Operator submits a batch call and the agent greets the prospect using the correct host name, event name, and other sidebar-entered details
  2. TTS override is enabled in the ElevenLabs agent Security settings (confirmed via dashboard)
  3. All 14 dynamic variables are referenced in the agent prompt template (confirmed via audit)
  4. The fixed Apps Script code is live in the Google Apps Script editor
**Plans:** 2 plans
Plans:
- [x] 01-01-PLAN.md — Audit agent prompt for all 14 dynamic variable references, PATCH if missing (DASH-02)
- [ ] 01-02-PLAN.md — Deploy fixed code to Apps Script editor, enable TTS override, verify with test call (DASH-01, VARS-01, VARS-02, VARS-03)

### Phase 2: Voice Selection Core
**Goal**: Operators can select a calling voice from a dropdown in the sidebar and that voice is used for all calls in the batch
**Depends on**: Phase 1
**Requirements**: VOICE-01, VOICE-02, VOICE-03, VOICE-04, VOICE-08
**Success Criteria** (what must be TRUE):
  1. Operator sees a voice dropdown in the sidebar populated with available ElevenLabs voices
  2. Dropdown shows a loading indicator while voices are being fetched from the API
  3. Operator selects a voice, submits a batch, and all calls in that batch use the selected voice
  4. Operator closes and reopens the sidebar and sees the last-used voice pre-selected
  5. If no voice is selected, the batch payload omits the conversation_config_override entirely (agent default voice is used)
**Plans**: TBD
**UI hint**: yes

### Phase 3: UX Polish
**Goal**: Operators can preview voices, see voice metadata, bookmark favorites, and get validation feedback on required fields
**Depends on**: Phase 2
**Requirements**: VARS-04, VOICE-05, VOICE-06, VOICE-07
**Success Criteria** (what must be TRUE):
  1. Operator can play a voice sample directly from the sidebar before submitting
  2. Each voice in the dropdown displays accent, gender, and tone labels
  3. Bookmarked/favorited voices appear at the top of the dropdown list
  4. Empty required sidebar fields are highlighted with red borders and batch submission is blocked until filled
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation Fix | 0/2 | Planned | - |
| 2. Voice Selection Core | 0/TBD | Not started | - |
| 3. UX Polish | 0/TBD | Not started | - |
