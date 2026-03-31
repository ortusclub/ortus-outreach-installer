# Technology Stack

**Project:** ElevenLabs Voice Selection + Variable Mapping
**Researched:** 2026-03-31

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

No installation needed. Single-file paste into Apps Script editor.

New server-side functions to add:
- `getVoices()` -- calls `/v2/voices`, returns array of `{voice_id, name, labels, preview_url, is_bookmarked}`
- Modified `submitBatchCall()` -- accepts `voice_id` parameter, injects `conversation_config_override`

## Sources

- [ElevenLabs List Voices v2](https://elevenlabs.io/docs/api-reference/voices/search) -- HIGH confidence
- [ElevenLabs Batch Calling Submit](https://elevenlabs.io/docs/api-reference/batch-calling/create) -- HIGH confidence
