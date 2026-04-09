# Requirements: Ortus GoLogin Clone — Delivery Hardening

**Defined:** 2026-04-09
**Core Value:** Operators can run multi-account LinkedIn outreach campaigns reliably and safely.

## v2.0 Requirements

Requirements for delivery hardening. Each maps to roadmap phases.

### Security

- [ ] **SEC-01**: All API tokens and secrets are loaded from `.env` only — no hardcoded values in source code
- [ ] **SEC-02**: Express dashboard is protected by basic authentication (username/password from `.env`)
- [ ] **SEC-03**: `.env` file is in `.gitignore` and never committed

### Reliability

- [ ] **REL-01**: Campaign state file I/O uses async `readFile`/`writeFile` instead of sync variants
- [ ] **REL-02**: Duplicate `extractSheetId()` is consolidated into a single shared utility
- [ ] **REL-03**: Graceful shutdown handler closes all active GoLogin profiles on SIGINT/SIGTERM before exit
- [ ] **REL-04**: Profile health check verifies each selected GoLogin profile can reach LinkedIn (not logged out) before starting the campaign

### Operational

- [ ] **OPS-01**: Campaign scheduling — operator can set a cron-style schedule to auto-start campaigns
- [ ] **OPS-02**: Configurable rate-limit safety — daily/hourly caps per profile and randomized delay ranges between actions
- [ ] **OPS-03**: Campaign history — completed campaign logs are persisted to disk and viewable from the dashboard
- [ ] **OPS-04**: CSV export — operator can download campaign results as a CSV file from the dashboard

### Dashboard UX

- [ ] **UX-01**: Template save/load — dashboard UI wires into the existing `/api/templates` endpoints (save named templates, load/delete)
- [ ] **UX-02**: Progress bar correctly shows per-campaign progress (not cumulative across runs)
- [ ] **UX-03**: Campaign history panel shows past campaign summaries with date, mode, profiles used, and success/error counts

## v3.0 Requirements (Future)

### Sales Navigator

- **NAV-01**: Sales Navigator URL support (`/sales/lead/`) with adapted DOM selectors
- **NAV-02**: Sales Nav search result list processing

### Column Mapping

- **MAP-01**: Column mapping UI lets operators map sheet columns to expected fields

## Out of Scope

| Feature | Reason |
|---------|--------|
| Sales Navigator support | Different DOM selectors, significant scope — deferred to v3.0 |
| Agent switching (LinkedIn personas) | Single-account-per-profile model is sufficient |
| Multi-sheet column mapping UI | Nice-to-have, deferred to v3.0 |
| LinkedIn group messaging | Different product surface |
| Proxy management | GoLogin handles this internally |
| Mobile/responsive dashboard | Internal tool, desktop only |
| Database storage | JSON file state is sufficient for single-operator use |
| Core automation logic changes | Working features must not be modified |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 7 | Pending |
| SEC-02 | Phase 7 | Pending |
| SEC-03 | Phase 7 | Pending |
| REL-01 | Phase 8 | Pending |
| REL-02 | Phase 8 | Pending |
| REL-03 | Phase 8 | Pending |
| REL-04 | Phase 8 | Pending |
| OPS-01 | Phase 9 | Pending |
| OPS-02 | Phase 9 | Pending |
| OPS-03 | Phase 9 | Pending |
| OPS-04 | Phase 9 | Pending |
| UX-01 | Phase 10 | Pending |
| UX-02 | Phase 10 | Pending |
| UX-03 | Phase 10 | Pending |

**Coverage:**
- v2.0 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-04-09*
*Last updated: 2026-04-09 after roadmap creation*
