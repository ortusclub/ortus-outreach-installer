# ElevenLabs Calling Integration — Sidebar Enhancements

## What This Is

Enhancements to the Ortus Club's ElevenLabs batch calling integration, which lives as a Google Apps Script attached to a Google Sheet. The system reads leads from the sheet, submits batch outbound calls via ElevenLabs Conversational AI + Twilio, and tracks results. Two specific improvements are needed: voice selection from the sidebar and fixing dynamic variable mapping.

## Core Value

The sidebar must reliably pass all user-entered event details (host name, event name, etc.) to the ElevenLabs agent so every call is personalized — and let operators switch the calling voice without leaving the sheet.

## Requirements

### Validated

- ✓ Batch call submission from Google Sheets sidebar — existing
- ✓ Lead reading from sheet with phone/name/email column detection — existing
- ✓ Call tracking columns (Status, Date, Duration, Batch ID, Notes) — existing
- ✓ Batch status checking and sheet update — existing
- ✓ ElevenLabs API integration (POST/GET helpers) — existing
- ✓ Webhook handler for call completion callbacks — existing
- ✓ Auto-poll trigger for batch status — existing
- ✓ Scheduling (immediate or deferred) — existing

### Active

- [ ] Voice selection dropdown in sidebar — fetch available voices from ElevenLabs API and let operator pick before submitting
- [ ] Fix dynamic variable mapping — ensure all sidebar inputs (host_name, event_name, event_date, etc.) are correctly passed through `conversation_initiation_client_data.dynamic_variables` and received by the agent

### Out of Scope

- Agent switching (different agent personas/scripts) — not needed now, voice switching covers the use case
- Call recording/transcription management — separate concern
- Multi-sheet support — single sheet workflow is sufficient
- New deployment of the Apps Script — sidebar uses HEAD deployment, no redeploy needed

## Context

- **Platform**: Google Apps Script (server-side JS) + HTML sidebar
- **APIs**: ElevenLabs Conversational AI (`/v1/convai/*`), Twilio (via ElevenLabs phone number import)
- **Agent**: `agent_5601kmzey4mve8pswpwvmhckcgnr` / branch `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`
- **Phone**: +1 617 600 0320 (`phnum_8701kn1e7q5rfbgsrwp8xzfk1dad`)
- **Sheet**: `1qBjityRlSsRfRLXJN7yv_J_yoNElkdzL1fOE0jh_OoU`
- **Current voice**: Alice (British, Clear) — voice_id `Xb7hH8MSUJpSbSDYk0k2`
- **Known bug**: Variable mapping fix exists in local file `elevenlabs-apps-script.js` (correct `conversation_initiation_client_data.dynamic_variables` nesting) but has NOT been deployed to Apps Script editor yet
- **All code lives in a single file**: `elevenlabs-apps-script.js` — this is the Apps Script source that gets pasted into the editor

## Constraints

- **Runtime**: Google Apps Script (V8 engine, no ES modules, no npm)
- **Deployment**: Code is pasted into Apps Script editor; sidebar uses HEAD deployment (no redeploy needed after code changes)
- **API limits**: ElevenLabs API rate limits apply; batch concurrency capped at 5
- **Voice API**: Need to verify the correct ElevenLabs endpoint for listing voices and updating agent voice settings

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Voice switching, not agent switching | User confirmed — same agent, different voices | — Pending |
| Single-file Apps Script | Simplicity; paste-and-go workflow | ✓ Good |
| HEAD deployment for sidebar | No redeploy needed after code edits | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-31 after initialization*
