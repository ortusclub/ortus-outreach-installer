# Phase 1: Foundation Fix - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 01-foundation-fix
**Areas discussed:** Deployment method, Variable audit, Agent prompt, Testing

---

## Deployment Method

| Option | Description | Selected |
|--------|-------------|----------|
| Browser paste (Recommended) | Use computer-use/Chrome tools to open Apps Script editor, select all, paste the fixed code, save | ✓ |
| Apps Script API | Push code programmatically via Google Apps Script API. Requires OAuth setup | |
| Manual by you | Claude provides the final code, you paste it yourself | |

**User's choice:** Browser paste (Recommended)
**Notes:** Matches existing workflow from RESUME.md. No redeployment needed — sidebar uses HEAD deployment.

---

## Variable Audit

| Option | Description | Selected |
|--------|-------------|----------|
| All required | Every field must be filled before a batch can be submitted | ✓ |
| Core required, rest optional | Require only essentials (host_name, event_name, event_date), rest optional with fallbacks | |
| All optional | No fields required — agent handles missing data with generic fallbacks | |

**User's choice:** All required
**Notes:** All 14 dynamic variables are required for every call. Phase 3 VARS-04 will add UI validation.

---

## Agent Prompt

| Option | Description | Selected |
|--------|-------------|----------|
| Read + fix via API (Recommended) | Use ElevenLabs API to GET agent config, check variable references, PATCH missing ones | ✓ |
| Manual dashboard check | Open ElevenLabs dashboard, visually check prompt, manually add missing variables | |
| Provide template only | Claude provides ideal prompt template, user updates it in dashboard | |

**User's choice:** Read + fix via API (Recommended)
**Notes:** Fully automated approach — GET the agent config, audit the prompt, PATCH if needed.

---

## Testing

| Option | Description | Selected |
|--------|-------------|----------|
| Real test call (Recommended) | Submit batch with 1 recipient, listen to call, verify agent uses correct details | ✓ |
| API dry-run only | Submit API request and inspect payload/response without making a call | |
| Both | Verify payload format first, then make real test call | |

**User's choice:** Real test call (Recommended)
**Notes:** Test call to user's own phone number. Success = agent greets with correct host name, event details, etc.

### Test Number

| Option | Description | Selected |
|--------|-------------|----------|
| Your number | User provides their phone number for test | ✓ |
| Twilio test number | Use imported Twilio number as both caller and receiver | |
| Decide later | Figure out test number at testing time | |

**User's choice:** Your number

---

## Claude's Discretion

- Exact order of operations (deploy code first, then audit prompt, then test)
- How to structure API calls for prompt audit
- Error handling if API calls fail

## Deferred Ideas

None — discussion stayed within phase scope
