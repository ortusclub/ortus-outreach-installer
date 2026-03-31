<!-- GSD:project-start source:PROJECT.md -->
## Project

**ElevenLabs Calling Integration — Sidebar Enhancements**

Enhancements to the Ortus Club's ElevenLabs batch calling integration, which lives as a Google Apps Script attached to a Google Sheet. The system reads leads from the sheet, submits batch outbound calls via ElevenLabs Conversational AI + Twilio, and tracks results. Two specific improvements are needed: voice selection from the sidebar and fixing dynamic variable mapping.

**Core Value:** The sidebar must reliably pass all user-entered event details (host name, event name, etc.) to the ElevenLabs agent so every call is personalized — and let operators switch the calling voice without leaving the sheet.

### Constraints

- **Runtime**: Google Apps Script (V8 engine, no ES modules, no npm)
- **Deployment**: Code is pasted into Apps Script editor; sidebar uses HEAD deployment (no redeploy needed after code changes)
- **API limits**: ElevenLabs API rate limits apply; batch concurrency capped at 5
- **Voice API**: Need to verify the correct ElevenLabs endpoint for listing voices and updating agent voice settings
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Platform
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Google Apps Script | V8 runtime | Server-side logic, API calls | Already in use; no alternative for Sheets sidebar |
| HTML Service | Built-in | Sidebar UI | Only option for GAS sidebars |
### APIs
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| ElevenLabs `/v2/voices` | v2 | List available voices with metadata | Returns `preview_url`, `labels`, `is_bookmarked` -- everything needed for the picker |
| ElevenLabs `/v1/convai/batch-calling/submit` | v1 | Submit batch calls with voice override | Existing endpoint; add `conversation_config_override.tts.voice_id` per recipient |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | -- | -- | GAS provides `UrlFetchApp`, `PropertiesService`, `HtmlService` natively |
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Voice list endpoint | `/v2/voices` (paginated) | `/v1/voices` (returns all) | v2 has filtering, pagination, proper `has_more` flag. v1 may work for small libraries but is legacy. |
| Voice override | `conversation_config_override.tts` | PATCH agent voice setting | Override is per-batch, non-destructive. PATCH mutates the agent globally -- dangerous for concurrent operators. |
| State persistence | `PropertiesService.getUserProperties()` | `CacheService` | User properties persist across sessions; cache expires. |
## Installation
- `getVoices()` -- calls `/v2/voices`, returns array of `{voice_id, name, labels, preview_url, is_bookmarked}`
- Modified `submitBatchCall()` -- accepts `voice_id` parameter, injects `conversation_config_override`
## Sources
- [ElevenLabs List Voices v2](https://elevenlabs.io/docs/api-reference/voices/search) -- HIGH confidence
- [ElevenLabs Batch Calling Submit](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- HIGH confidence
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
