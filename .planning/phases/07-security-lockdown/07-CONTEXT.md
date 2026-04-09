# Phase 7: Security Lockdown - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove all hardcoded secrets from source code, move them to `.env`, and add basic HTTP authentication to the Express dashboard so only authorized users can access any route. Core automation logic is NOT modified.

</domain>

<decisions>
## Implementation Decisions

### Authentication approach
- **D-01:** Basic HTTP auth via Express middleware — username/password loaded from `DASHBOARD_USER` and `DASHBOARD_PASS` in `.env`
- **D-02:** Auth protects ALL routes — both dashboard HTML pages and all `/api/*` endpoints. No unauthenticated access.
- **D-03:** No session management, no login page — browser-native basic auth prompt is sufficient for an internal team tool

### Secret migration
- **D-04:** All hardcoded tokens removed from source: GoLogin JWT in `server.js:5` and `campaign.js:105`, Apps Script URL in `server.js:12`
- **D-05:** Existing GoLogin JWT token is kept (not rotated) — just moved to `.env`. Git history exposure accepted (private repo).
- **D-06:** App fails at startup with clear error if any required `.env` variable is missing: `GOLOGIN_API_TOKEN`, `SHEETS_WEBAPP_URL`, `DASHBOARD_USER`, `DASHBOARD_PASS`
- **D-07:** `.env.example` is updated to document all required variables with placeholder values
- **D-08:** Deployment model: a developer sets up `.env` once. Operators only interact via the dashboard — they never touch env vars or tokens.

### .gitignore verification
- **D-09:** `.env` is already in `.gitignore` — verify it remains so and `data/state.json` stays gitignored too

### Claude's Discretion
- Exact middleware implementation (inline function vs separate file)
- Error message format for missing env vars
- Whether to use a lightweight auth library or hand-roll basic auth parsing

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Source files to modify
- `server.js` — Lines 3-14: hardcoded tokens and URLs to remove, auth middleware to add
- `src/campaign.js` — Line 105: `getToken()` function with hardcoded fallback JWT
- `.env.example` — Current template, needs updating with all required vars
- `.gitignore` — Verify `.env` remains listed

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `dotenv` is already a dependency and loaded at `server.js:1` — no new packages needed for env loading
- `.env.example` already exists with `GOLOGIN_API_TOKEN` and `PORT`

### Established Patterns
- `process.env.X` is the existing pattern for reading env vars
- `server.js` uses Express middleware chain (`app.use()`) — auth middleware slots in naturally
- `campaign.js:104-106` has a `getToken()` helper that wraps env access — good pattern to keep

### Integration Points
- Auth middleware goes before `express.static('public')` and all route handlers in `server.js`
- `getToken()` in `campaign.js` needs its hardcoded fallback removed — should throw if env var missing
- `/api/health` endpoint may need to stay unauthenticated for monitoring (Claude's discretion)

</code_context>

<specifics>
## Specific Ideas

- Operators are non-technical — they should never see env var errors. The deployer (Antonio) configures `.env` once.
- Browser basic auth prompt is fine for internal use — no need for a styled login page.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-security-lockdown*
*Context gathered: 2026-04-09*
