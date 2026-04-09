# Phase 8: Reliability Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-09
**Phase:** 08-reliability-hardening
**Areas discussed:** Async I/O scope, Shutdown behavior, Health check depth

---

## Async I/O Scope

| Option | Description | Selected |
|--------|-------------|----------|
| State I/O only (Recommended) | Convert loadState()/saveState() to async. Leave existsSync/mkdirSync. | ✓ |
| Convert everything | All sync I/O including existsSync/mkdirSync | |
| You decide | Claude picks pragmatic approach | |

**User's choice:** State I/O only
**Notes:** existsSync/mkdirSync run once at startup, not during campaigns

---

## Shutdown Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Finish current lead (Recommended) | Set abort flag, let lead finish, save state, close profiles, exit | ✓ |
| Abort immediately | Kill current action, save state as-is, close profiles, exit | |
| You decide | Claude picks safest approach | |

**User's choice:** Finish current lead
**Notes:** None

---

## Health Check Depth

| Option | Description | Selected |
|--------|-------------|----------|
| Quick LinkedIn check | Open profile, check URL for login/authwall. 15s timeout. | |
| Deep verification | Open profile, navigate LinkedIn, scroll feed, check rate-limit banners. 30-60s per profile. | ✓ |
| You decide | Claude picks balance | |

**User's choice:** Deep verification
**Notes:** User wants thorough checks before committing profiles to a campaign

---

## Claude's Discretion

- Whether closeAllProfiles() is a new export or the Map is exported directly
- Exact error handling for async state I/O failures
- Whether health check is a separate function or inline

## Deferred Ideas

None
