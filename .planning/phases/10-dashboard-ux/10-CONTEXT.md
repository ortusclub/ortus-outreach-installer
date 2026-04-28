# Phase 10: Dashboard UX - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire template save/load/delete into the dashboard UI, fix the progress bar to show per-campaign progress, and add a campaign history panel with CSV download. All APIs already exist from previous phases — this is frontend-only work in `public/index.html`, `public/js/app.js`, and `public/css/style.css`.

</domain>

<decisions>
## Implementation Decisions

### Template save/load UI
- **D-01:** Claude's discretion on placement and design — must match the existing dark theme and dashboard aesthetic
- **D-02:** Minimum controls: dropdown to load a saved template, save button (prompts for name), delete button for the selected template
- **D-03:** Wire to existing API: `GET /api/templates` (list), `POST /api/templates` (save), `DELETE /api/templates/:name` (delete)
- **D-04:** When a template is loaded, populate all relevant textareas (connectionNote, followUpMessage, inmail subject/body) from the saved data

### Progress bar fix
- **D-05:** Reset `totalProcessed` to 0 when a new campaign starts (not cumulative across runs)
- **D-06:** Progress bar shows `processedToday / totalTargets` for the CURRENT campaign only
- **D-07:** This is a backend fix in `campaign.js` (`getCampaignStatus()` returns wrong cumulative data) plus frontend fix in `app.js` progress calculation

### Campaign history panel
- **D-08:** Collapsible table below the Live Status section — shows date, mode, profiles used, success count, error count, duration per campaign
- **D-09:** Click a row to expand and see additional detail (templates used, daily limit, total processed)
- **D-10:** Data source: `GET /api/history` (returns array of campaign summaries from Phase 9)
- **D-11:** "Download CSV" button in the history panel header — triggers download from `GET /api/export/csv`
- **D-12:** History loads on page load and refreshes after each campaign completes
- **D-13:** Match existing dashboard dark theme — same card style, colors (#0d1117 bg, #58a6ff accents, #c9d1d9 text)

### Claude's Discretion
- Exact template UI layout (inline bar vs separate section)
- Table styling details (borders, hover states, expand animation)
- Whether to show "no history yet" empty state
- Scheduling UI (if time permits — the API exists but schedule management in the dashboard is a nice bonus)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Source files to modify
- `public/index.html` — Add template controls HTML, history panel section, CSV download button
- `public/js/app.js` — Wire template save/load/delete, fix progress bar, add history fetch/render, CSV download
- `public/css/style.css` — History table styles, collapsible rows, template controls styling
- `src/campaign.js` — Fix `getCampaignStatus()` to return per-campaign progress (not cumulative)

### Existing API endpoints (from prior phases)
- `GET /api/templates` — Returns `{name: {connectionNote, followUp1, inmailSubject, inmailBody}}`
- `POST /api/templates` — Body: `{name, templates: {...}}`
- `DELETE /api/templates/:name` — Removes saved template
- `GET /api/history` — Returns array of campaign summary objects
- `GET /api/export/csv` — Returns CSV with `Content-Disposition: attachment`

### Prior phase context
- `.planning/phases/09-operational-features/09-CONTEXT.md` — History and CSV API design decisions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `escHtml()` in app.js — XSS-safe HTML escaping, use for all dynamic content
- `pollStatus()` in app.js — Already fetches campaign status every 2s, hook history refresh into campaign end detection
- `renderAccountQueue()` — Pattern for rendering dynamic HTML lists
- Existing `.preview-table` CSS class — Can be reused/extended for history table

### Established Patterns
- All dashboard sections use `<div class="section"><h2>N. Title</h2>...</div>` structure
- Buttons use `class="btn btn-secondary"` or `class="btn btn-start"`
- Color scheme: bg #0d1117, accent #58a6ff, text #c9d1d9, error #f85149, warn #d29922

### Integration Points
- Template controls go near existing template textareas (sections 4-6 in index.html)
- History panel goes after the Live Status section
- Progress bar fix: `pollStatus()` in app.js line 301 — change calculation
- Campaign status fix: `getCampaignStatus()` in campaign.js line 500

</code_context>

<specifics>
## Specific Ideas

- History table should feel professional — this is what the team sees when reviewing campaign results
- CSV download should be one-click from the history panel, not a separate page

</specifics>

<deferred>
## Deferred Ideas

- Schedule management UI in the dashboard — API exists from Phase 9 but UI is a nice bonus, not required for delivery

</deferred>

---

*Phase: 10-dashboard-ux*
*Context gathered: 2026-04-09*
