# Phase 7: Security Lockdown - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-09
**Phase:** 07-security-lockdown
**Areas discussed:** Auth approach, Secret migration, Token exposure

---

## Auth Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Basic HTTP auth (Recommended) | Username/password from .env, checked via Express middleware. Simple, no sessions. | ✓ |
| Login page + session | HTML login form with cookie-based sessions. More polished but requires session management. | |
| You decide | Claude picks simplest approach for internal tool | |

**User's choice:** Basic HTTP auth
**Notes:** None — recommended option accepted

| Option | Description | Selected |
|--------|-------------|----------|
| Everything (Recommended) | All routes require auth — prevents curling API directly | ✓ |
| Dashboard only | Only protect HTML pages, API stays open | |

**User's choice:** Auth on all routes
**Notes:** None

---

## Secret Migration

| Option | Description | Selected |
|--------|-------------|----------|
| Fail at startup (Recommended) | App prints clear error listing missing vars and exits | ✓ |
| Warn and run | App starts but logs warnings, some features may not work | |
| You decide | Claude picks pragmatic approach | |

**User's choice:** Fail at startup
**Notes:** User emphasized that operators (99% of users) have no idea what tokens or env vars are. Deployment model: developer sets up .env once, operators just use the dashboard.

| Option | Description | Selected |
|--------|-------------|----------|
| All secrets required | GOLOGIN_API_TOKEN, SHEETS_WEBAPP_URL, DASHBOARD_USER, DASHBOARD_PASS all required | |
| Token + auth required | GOLOGIN_API_TOKEN + auth required, SHEETS_WEBAPP_URL optional | |
| You decide | Claude determines required vs optional | |

**User's choice:** (Other) "They shouldn't be inserted by the users, 99% of them have no idea what all of this even is"
**Notes:** Clarified that .env is pre-configured by the deployer. All vars treated as required at startup.

---

## Token Exposure

| Option | Description | Selected |
|--------|-------------|----------|
| Rotate the token | Generate new GoLogin API token, old one becomes useless | |
| Just remove from code | Remove hardcoded values, accept git history has old token | ✓ |
| You decide | Claude picks pragmatic approach | |

**User's choice:** "No use that one" — keep existing token, just move from code to .env
**Notes:** Git history exposure accepted (private repo). No rotation needed.

---

## Claude's Discretion

- Exact middleware implementation approach (inline vs separate file)
- Error message format for missing env vars
- Whether /api/health stays unauthenticated for monitoring

## Deferred Ideas

None
