# Follower Growth Campaign — Design

**Date:** 2026-06-23
**Branch context:** builds on `team-connections-mvp` (the Connections tab/DB)
**Status:** Design approved (brainstorm). Phase 1 is the buildable spec; Phase 2 is a documented follow-on.

> Internal name today: "Operation Funnel." This feature grows the **Ortus Club LinkedIn company-page follower count** by having each operator invite their own 1st-degree connections to follow the page. It is distinct from outreach campaigns and from the lead/event lifecycle funnel.

---

## Goal

Bring the standalone Follower Growth workflow (today a separate Google Sheet + its own Apps Script, used manually) **into Ortus Outreach as a new campaign type**, built on top of the Connections DB we already shipped. Phase 1 produces a vetted, budget-aware, per-operator invite list and reports **invites sent**. Phase 2 adds full browser automation of the "Invite to follow" click.

## Architecture (2-3 sentences)

The feature has two touchpoints, both already precedented in the app: the **Connections tab** is the unchanged data source (we add one new scoping filter), and a **new "Follower Growth" campaign type** consumes it via the same "build from warm connections" bridge used for lead workbooks — except it writes to a purpose-built **central FG sheet** instead. Because each operator runs a separate copy of the app (separate DMG installs), the only cross-operator shared state is a central Google Sheet + Apps Script; that sheet is the backend, and the campaign tab renders it as an in-app **Follower Growth database view**. The riskiest piece — automating the Page-admin "Invite to follow" click — is isolated into Phase 2 so it cannot gate the Phase 1 value, and Phase 1's manual-click mode doubles as the permanent fallback if automation proves infeasible.

## Tech Stack

Electron + Express 4 + vanilla JS (ESM, no bundler), Node ≥22, `node --test`. Reuses `src/connections/*` (`search-service.js`, `match.js`, `export.js`, `drive-sync.js`), the connections routes in `server.js`, and a new central FG Apps Script reached via a second configured webapp URL. Monochrome Bugatti design system (`public/css/style.css`).

---

## Locked decisions (from brainstorm 2026-06-23)

1. **New Follower Growth campaign type** inside Ortus Outreach (not a standalone tool).
2. **Full automation** of the "Invite to follow" click is the end goal — via a **new page-invite browser path**, built *alongside* (never inside) the off-limits `src/linkedin/outreach.js` / `src/linkedin/actions.js`. **Deferred to Phase 2.**
3. **Each operator = a Page admin**, inviting only their **own** 1st-degree connections.
4. **Per-account monthly invite budget**, tracked in-app and never overrun.
5. **Targets come from the Connections DB** (buckets A+B — in-DB, DNC-stripped), filtered by a configurable **function/job-title** criterion (defaults toward marketers, adjustable per campaign). Bucket C (un-recorded live connections) is excluded so every invite stays inside DNC-safe data.
6. **Central store = a purpose-built central FG sheet** (3 tabs), surfaced as an **in-app Follower Growth database view**. Operators never open the spreadsheet. Supersedes the legacy standalone FG sheet.
7. **Build is phased:** Phase 1 = targeting + budget + central DB + manual invite (the fallback); Phase 2 = full automation.
8. **v1 reports invites *sent* only** — no follow-conversion tracking.

---

## The per-operator scoping insight (why this is mostly a new output path, not a new engine)

The Connections DB already records, per contact:
- `warmVia` — the list of colleague/operator emails through whom we know this contact (`src/connections/match.js:60`, surfaced as operator names via `colleagues.json` in `search-service.js:85`).
- `linkedin_membership_id` → `linkedinId` (`search-service.js:79`) — the numeric Member ID, our load-bearing dedup identifier.
- DNC flag, job title, company, geo — already filtered by `matchesCriteria` (`match.js:14`) and DNC-split by `searchConnections` (`search-service.js:119`).

So an FG target list for operator *X* is:

> Connections **where `warmVia` includes X** → filtered by **function/title** → **DNC-stripped** (already happens) → **deduped vs `FG Invites` by Member ID** → capped at **X's remaining monthly budget**.

Every verb except *scope-by-operator*, *dedupe-vs-FG-Invites*, and *cap-at-budget* already exists. Those three are the genuinely new logic.

---

## Central FG store — schema (new sheet, 3 tabs)

### Tab 1 · `FG Invites` — one row per *target × operator*

| Column | Meaning |
|---|---|
| Target Name | Full name |
| LinkedIn URL | Profile slug / URL |
| Member ID | Numeric `linkedin_membership_id` — **dedup key** |
| Company | Snapshot at queue time |
| Job Title | Snapshot at queue time |
| Function Match | Which filter keyword matched (e.g. `marketing`) |
| Geo | Snapshot at queue time |
| Invited By | Operator name (the `warmVia` owner running the campaign) |
| Account | The LinkedIn account that will send / sent the invite |
| Status | `Queued` → `Invited`, or `Skipped` |
| Invited At | Timestamp the invite was sent (blank while `Queued`) |
| FG Note | Terminal/skip reason: `not in DB` / `DNC` / `already invited` / `ambiguous` |
| Month | Budget month, e.g. `2026-06` |

No `Followed At` / `Expired` — follow-conversion is out of scope for v1.

### Tab 2 · `FG Budgets` — per account, per month

| Account | Operator | Month | Allowance | Sent | Remaining |

`Remaining = Allowance − Sent`. LinkedIn may refund credits when invitees accept; the app does **not** model refunds — the operator's true available count is visible on LinkedIn, and the app's number is a guide that only ever counts what it sent.

### Tab 3 · `FG Funnel` — rollup (QUERY-derived view, like Ops Log v2 views)

Per operator + grand total:

| Eligible pool | **Invites sent** |

**Invites sent** is the headline metric, sliceable by operator and month. The whole v1 funnel is **pool → invited**, full stop.

---

## Phase 1 — buildable scope

### Data flow (no automation)

1. Operator opens a **Follower Growth campaign**, selects themselves (the inviting account) and sets the **function/title filter** (defaults toward marketers, editable chips).
2. App runs a Connections DB search scoped `warmVia = this operator`, DNC-stripped, **deduped vs `FG Invites` by Member ID**, capped at the account's **remaining monthly budget** (`Allowance − Sent` from `FG Budgets`).
3. The resulting **vetted invite list** is shown in the in-app **Follower Growth database view** and written to `FG Invites` as `Queued`.
4. Operator clicks the invites on LinkedIn manually (the fallback path), then marks the batch done → rows flip `Queued → Invited`, `Invited At` stamped, `FG Budgets.Sent` increments. *(Phase 2 automates step 4.)*

### Components / files

**Source layer (Connections DB) — add operator scoping:**
- `src/connections/match.js` — extend `matchesCriteria` (or add a sibling filter) to accept an `operator` (colleague email) and keep only contacts whose `warmVia` includes it.
- `src/connections/search-service.js` — add an FG-flavored builder analogous to `buildLeadRows` (`search-service.js:160`) that returns FG rows (Member ID, function-match, operator, account, month) rather than the lead-CSV `HEADER` shape, deduped against a supplied set of already-invited Member IDs.

**Central FG store layer (new):**
- New `src/connections/fg-sync.js` (mirrors `drive-sync.js`): `getFgInvites()`, `getFgBudgets()`, `appendFgInvites(rows)`, `markInvited(memberIds, account, month)` — all via the 302-safe `postWebApp` pattern already used by `createWorkbookTab` (`drive-sync.js:87`), pointed at a **second configured webapp URL** (the central FG Apps Script).
- New central FG Apps Script (separate file) implementing the 3-tab sheet: read invites/budgets, append queued rows, flip to `Invited`, recompute `FG Budgets` + `FG Funnel`. Uses `LockService` to serialize writes (multiple operators on separate machines may write concurrently).

**Routes (`server.js`):**
- `POST /api/fg/build` — given `{ operator, account, jobTitles/function, geo, month }`, run the scoped search, dedupe vs `FG Invites`, cap at remaining budget, return the queued list.
- `POST /api/fg/queue` — write the queued list to `FG Invites`.
- `POST /api/fg/mark-invited` — flip rows to `Invited`, bump `FG Budgets`.
- `GET /api/fg/db` — return the in-app DB view (invites + budgets + funnel rollup).

**UI (`public/index.html` + `public/js/app.js` + `public/css/style.css`):**
- New **Follower Growth** campaign type, gated in the campaign-setup mode list (alongside the existing modes).
- Reuses the Connections chip-filter UI for function/title + geo.
- In-app **Follower Growth database view** rendering `FG Invites` / `FG Budgets` / `FG Funnel`, monochrome Bugatti.
- A per-account **budget meter** (Sent / Allowance / Remaining) shown before and after a build.

### Phase 1 explicitly includes
- Operator-scoped, function-filtered, DNC-safe, budget-capped target building.
- Member-ID dedupe vs already-invited.
- Central FG sheet (3 tabs) as backend + in-app DB view as surface.
- Manual-invite workflow with "mark done" → `Invited` + budget decrement.
- Reporting **invites sent** (per operator, per month, total).

### Phase 1 explicitly excludes (out of scope)
- Any browser automation of the invite click (→ Phase 2).
- Follow-conversion / acceptance tracking, per-person or aggregate.
- Credit-refund modeling.
- Bucket C (un-recorded live connections).
- A clean job-**function** taxonomy (v1 uses title keywords).
- Migrating historical data out of the legacy standalone FG sheet (fresh start; legacy sheet retired manually).

---

## Phase 2 — documented follow-on (not specced here)

Add a **new page-invite browser path** that drives the GoLogin session to click "Invite to follow" for each `Queued` row, up to the account's remaining budget, then flips rows to `Invited` automatically. Built as a standalone module **alongside** `src/linkedin/outreach.js` / `actions.js` (which stay untouched). Must inherit the app's human-like pacing / daily sub-limits and the one-campaign-at-a-time constraint. ToS/detection feasibility for the Page-admin invite button is its own validation task (an automation spike) before this ships. Phase 1's manual mode remains the fallback if automation proves unsafe or unreliable.

---

## Known limitations & constraints on the record

- **Function filter = keyword-on-title** for v1 (the DB has job *title*, not a clean job *function*). Keyword set for marketers: `marketing`, `brand`, `growth`, `content`, `demand`, `comms`, `CMO`, etc. Upgradeable if HubSpot gains a function property.
- **"Invites sent" is the only outcome** — we cannot know which invites converted to follows without scraping the page's pending-invites list (a Phase-2+ stretch). The funnel is honest about this rather than faking conversion.
- **Page-admin prerequisite:** every inviting operator account must be an admin of the Ortus Club page with invite permission. Rollout of admin access is an operational task outside the app.
- **One campaign at a time** per app instance (parallel campaigns crash the app). FG campaigns run sequentially like all others.
- **Concurrent central writes:** operators on separate machines may write to the central FG sheet at the same time; the FG Apps Script serializes with `LockService`.
- **Budget allowance source:** the per-account monthly `Allowance` is a configured/known number (LinkedIn's per-account invite cap); confirm the real figure before launch.

---

## Open items to confirm before/at implementation

- Exact per-account monthly invite **Allowance** number (LinkedIn's current cap).
- Whether the central FG Apps Script is a brand-new deployment (new sheet) — yes per decision; needs one deploy + its webapp URL wired into the app config.
- `colleagues.json` must map each operator's email → name (and ideally Primary URL) so `warmVia` scoping resolves operator identity cleanly.
