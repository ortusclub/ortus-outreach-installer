# Phase 2: Voice Selection Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 02-voice-selection-core
**Areas discussed:** Dropdown placement, Voice display, Caching strategy, Default behavior

---

## Dropdown Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Below Caller Name (Recommended) | Right after Caller Name, before Host Name. Groups voice + caller identity at top. | ✓ |
| Own section at top | New 'Voice Settings' header above Event Details. Prominent but adds visual weight. | |
| Above Submit button | Just before Submit. Last thing picked before sending. | |

**User's choice:** Below Caller Name (Recommended)

---

## Voice Display

| Option | Description | Selected |
|--------|-------------|----------|
| Name + labels (Recommended) | Voice name with accent/gender/tone inline (e.g. "Alice — British, Female, Clear") | ✓ |
| Name only | Just the name. Simple but harder to distinguish. | |
| Name + category | Grouped by category (premade, cloned, professional) | |

**User's choice:** Name + labels (Recommended)

---

## Caching Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| CacheService 1hr (Recommended) | GAS CacheService with 1hr TTL. New pattern but correct tool. | ✓ |
| No cache, fetch every time | Simplest code, but 1-3s API call each time | |
| ScriptProperties permanent | Only refreshes manually. Risk of stale data. | |

**User's choice:** CacheService 1hr (Recommended)

---

## Default Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| No selection (Recommended) | Shows "Agent default voice" placeholder. Omits override if not picked. | ✓ |
| Pre-select Alice | Default to current voice. Always sends override. | |
| Pre-select first voice | Auto-select first from API. Arbitrary. | |

**User's choice:** No selection (Recommended)

---

## Claude's Discretion

- Exact HTML/CSS for dropdown (follow existing sidebar patterns)
- Error handling for API failures
- Structure of `getVoiceList()` server-side function

## Deferred Ideas

None — discussion stayed within phase scope
