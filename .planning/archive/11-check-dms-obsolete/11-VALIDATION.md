---
phase: 11
slug: check-dms
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-21
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node --test` (Node built-in test runner, Node 20+) — zero new production deps |
| **Config file** | None — finds `tests/**/*.test.js` by convention |
| **Quick run command** | `node --test tests/check-dms-*.test.js` |
| **Full suite command** | `node --test tests/**/*.test.js` |
| **Estimated runtime** | ~3s quick, ~10s full (including jsdom/happy-dom UI tests) |

Rationale: Jest / Vitest add transitive deps and transform overhead given `"type": "module"`. `node --test` is stable since Node 20, supports `describe`/`it`, mocking, and JSON output. No package.json prod deps required; one devDep (`happy-dom` or `jsdom`) is a candidate for DOM tests — the planner decides whether to justify or drop it.

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/check-dms-*.test.js`
- **After every plan wave:** Run `node --test tests/**/*.test.js`
- **Before `/gsd-verify-work`:** Full suite must be green + manual DMS-06 verification completed in Electron dev build + one live end-to-end run against a real GoLogin profile with at least one known reply
- **Max feedback latency:** 10 seconds (full suite)

---

## Per-Task Verification Map

> The planner populates this table as tasks are created. Every DMS requirement must map to either an automated test OR a documented manual step (DMS-06 is the only manual-only case).

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD (populated by planner) | — | 0 | — | — | — | — | `node --test tests/check-dms-*.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Critical infrastructure that must exist before any DMS-XX task can be verified:

- [ ] `package.json` — add `"test": "node --test tests/**/*.test.js"` script
- [ ] `tests/fixtures/voyager-conversations-real.json` — **critical** — one live Voyager response payload captured by running a throwaway script against a real GoLogin profile. All response-shape assumptions collapse into this one file.
- [ ] `tests/fixtures/voyager-conversations-DEGRADED.json` — hand-crafted payload with missing/null fields (no `firstName`, `lastActivityAt: null`, malformed URN) for parser-resilience tests
- [ ] `tests/fixtures/sheet-rows-with-sent-dms.json` — mock sheet row set covering: per-profile filter, match hits, name collisions (with + without LinkedIn URL), rows with existing `Reply="yes"`
- [ ] `tests/check-dms-filter.test.js` — DMS-02 stubs (per-profile filter)
- [ ] `tests/check-dms-voyager.test.js` — DMS-03 stubs (Voyager URL + headers + fallback trigger)
- [ ] `tests/check-dms-match.test.js` — match-logic stubs (name match, ambiguous, LinkedIn-URL tiebreak)
- [ ] `tests/check-dms-watermark.test.js` — DMS-07 stubs (filter by watermark, atomic advance)
- [ ] `tests/check-dms-writeback.test.js` — DMS-04 stubs (column ensure, non-destructive skip)
- [ ] `tests/ui/replies-panel.test.js` — DMS-05 stubs (render panel from fixture payload)
- [ ] `tests/ui/check-dms-button.test.js` — DMS-01 stubs (button presence + POST fires)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| "Open Thread" opens in system browser (NOT inside Electron window) | DMS-06 | Automated verification requires spawning the Electron binary and inspecting window chrome, which is out of proportion with the value. | 1. `npm run electron:dev`. 2. Run Check DMs against a profile with a known reply. 3. Click "Open Thread" on a reply row. 4. Verify the LinkedIn conversation URL opens in the system default browser. 5. Verify it did NOT open inside the Electron window or in a new Electron window. |
| Voyager scan against a real account | DMS-01, DMS-03, DMS-07 (integration) | Puppeteer-against-real-LinkedIn can't live in CI (cookie jar, rate limits, flaky). | 1. Ensure at least one sheet row for profile "Antonio" has `Message="sent"` and a known reply in LinkedIn. 2. Select Antonio in the dashboard, click Check DMs. 3. Verify reply appears in Replies panel within ~30s. 4. Verify sheet `Reply`/`Reply At`/`Reply Preview` are populated. 5. Re-run; verify panel is empty (watermark advanced). |

---

## Nyquist Sampling Points

The "signal" is "a real LinkedIn reply surfaces correctly in both UI and sheet." Sample at every major transform:

1. **Voyager response parse** — fixture-driven. Parser extracts `{ participantFirstName, participantLastName, lastMessage, lastActivityAt, entityUrn }`. Schema drift fails the test before prod.
2. **Match logic** — pure function: `(conversations, candidateRows) → matches/misses/ambiguous`.
3. **Watermark filter** — conversations before/after watermark → correct subset surfaces.
4. **Non-destructive writeback** — when `Reply="yes"` already, no update payload is sent.
5. **Atomic watermark advance** — simulate "Profile B throws"; assert Profile A's watermark advances, Profile B's does not.
6. **UI render** — `renderRepliesPanel(el, replies)` produces DOM with correct text + `<a target="_blank">` links.
7. **End-to-end smoke (manual)** — above.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
