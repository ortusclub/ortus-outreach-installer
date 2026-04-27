# Ortus Outreach — Code Health & Hygiene

**Date:** 2026-04-27
**Lens:** C (Code health / tech debt) — first of the remaining three lenses (C → D → E)
**Approach:** Single-sweep surgical patch series, five patches in one branch, one ship
**Target version:** 2.8.21
**Memory anchors:** never modify core campaign logic; user has been burned by broken changes — bias toward additive cleanup, no behavior changes; verify before asserting (no guessing about what's used).

## Scope

Five patches in one branch (`code-health-2.8.21`), shipped as a single version bump. Two themes:

| Theme | Patches | Risk |
|---|---|---|
| **Cleanup** | P1, P2, P3, P4 | Low (file moves, doc rewrite, JSON commit, careful deletion) |
| **Safety nets** | P5 | Low (additive tests on extracted pure helpers) |

All patches are **additive or removal-only** — none changes runtime behavior of the campaign loop, parking logic, watchdog, throttle math, UI rendering, or any user-visible flow. P4 is the only patch with a meaningful regression risk; it ships as separate per-deletion sub-commits to keep each revertible.

**Out of scope:**
- Any refactor that splits files (`app.js`, `campaign.js`, `server.js` stay as-is)
- Any deduplication of helpers across files (e.g., `_humanAgo` vs `_humanAgoFromTs` left alone)
- Any change to `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits per memory)
- Any change to behavior of parking, throttle, watchdog, or weeklyLimited transitions
- Integration tests / smoke tests / lint tooling (only pure-helper unit tests this round)
- The Phase 11 `check-dms` feature (still wired to the UI; user did not flag it for removal)
- Frontend `public/js/app.js` test coverage (would need DOM env — defer)

**Verification cadence:** Single end-of-branch verification (no mid-wave checkpoints). Each patch commits independently.

---

## P1 — Move ElevenLabs project out of repo

**Problem:** This repo is the Ortus Outreach Electron app, but it contains 60+ files from a different project (the ElevenLabs Apps Script for the calling sidebar):
- `elevenlabs-apps-script.js` at repo root (89 KB, 2025-04-22)
- `.planning/` directory: `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `archive/`, `config.json`, `notes/`, `phases/` (subdirs `01-foundation-fix` through `06-sms-follow-up-...`), `quick/`, `research/`, `seeds/` — entirely the ElevenLabs project's planning artifacts. Git status shows ~50 of these as already deleted-but-tracked.

None of these files are imported, required, or referenced by Ortus Outreach source code (verified by grep against `src/`, `public/js/`, `server.js`, `electron/`).

**Change:**

Move the ElevenLabs files to a sibling folder outside this repo:

1. Create `../ortus-elevenlabs-calling/` (sibling to `ortus-gologin-clone/`).
2. Move via shell:
   ```bash
   mv elevenlabs-apps-script.js ../ortus-elevenlabs-calling/
   mv .planning ../ortus-elevenlabs-calling/
   ```
3. Stage removal in this repo:
   ```bash
   git add -A elevenlabs-apps-script.js .planning
   ```
4. Commit removals.

No `git init` in the new folder — user can do that themselves if they want it tracked separately. Git history of the moved files remains preserved in this repo's history (always reachable via `git log --all -- .planning/`).

**Acceptance:**
- `elevenlabs-apps-script.js` and `.planning/` are gone from this repo.
- Files exist at `../ortus-elevenlabs-calling/` with original content intact (`diff` returns empty).
- `git status` shows no remaining ElevenLabs-related files.
- `npm test` still passes (sanity check that no test referenced the moved files).
- App still boots: `node server.js` starts cleanly on port 3000.

**Risk:** Low. Files aren't imported by any Ortus Outreach code.

---

## P2 — Rewrite CLAUDE.md for Ortus Outreach

**Problem:** Current `CLAUDE.md` describes "ElevenLabs Calling Integration — Sidebar Enhancements" as the project. This is the wrong project — the codebase is Ortus Outreach. CLAUDE.md is the file Claude reads on every session and uses to ground its behavior; the wrong description has caused at least one stale assumption already.

Also stale at the bottom:
- "GSD Workflow Enforcement" section (user has moved to superpowers brainstorm/plan/execute, no longer uses GSD commands)
- "Developer Profile" placeholder ("Run `/gsd:profile-user` to generate") — references a workflow no longer used

**Change:**

Replace the entire `CLAUDE.md` content with an Ortus-Outreach-accurate version. New structure:

```markdown
## Project

**Ortus Outreach** — LinkedIn outreach automation for The Ortus Club. Electron desktop app
that drives multiple GoLogin browser profiles to send connection requests, follow-ups,
and direct messages from a Google Sheet of leads. Used by ~3 colleagues on macOS laptops.

**Core value:** Reliable, observable, hands-off outreach. The campaign loop must keep
running even when individual accounts hit limits, sessions expire, or laptops are slow.

### Constraints

- **Runtime:** Node ≥22 (currently v25.9.0), no bundler for frontend, vanilla JS + Express 4
- **Browser automation:** GoLogin SDK 2.2.8 + puppeteer-core 22, headed only
- **Test framework:** `node --test` (no Jest, no Vitest)
- **Distribution:** electron-builder DMG for macOS (no auto-update yet)
- **End-user hardware:** colleagues run on slow/overloaded machines; assume CPU/RAM
  starvation when tuning timeouts

## Technology Stack

[Table of actual deps from package.json: Express, GoLogin, puppeteer-core, node-cron,
nodemailer, bcryptjs, cookie-parser, pidusage, dotenv]

## Architecture

- `server.js` — Express app, routes, campaign orchestration entry points (~1158 lines)
- `src/campaign.js` — campaign loop, parking, watchdog, throttle, state (~1503 lines after 2.8.20)
- `src/gologin-launcher.js` / `src/local-launcher.js` — browser launching
- `src/linkedin/` — outreach actions, navigation, selectors (off-limits per user policy)
- `src/sheets.js` / `src/sheets-writer.js` — Google Sheets read/write
- `src/disk-check.js` / `src/resource-monitor.js` — preflight + runtime resource checks
- `public/index.html` + `public/js/app.js` (~3946 lines) + `public/css/style.css` —
  command-deck UI (monochrome, hairlines, gold only on Start CTA)
- `electron/main.js` — Electron shell

## Conventions

- **Atomic JSON writes** — write tmp + rename for state.json and similar
- **NDJSON for crash-safe append-only logs** — see `appendFatalErrorSync` in server.js
- **Bugatti command-deck design system** — monochrome, hairlines, gold only on Start CTA,
  radii 0 or 9999, no other accent colors
- **Testing pattern** — `node --test tests/*.test.js`, pure-helper unit tests preferred
  over integration tests; manual browser verification for UI changes
- **Off-limits files** — `src/linkedin/outreach.js`, `src/linkedin/actions.js`
  (user has been burned by changes here)

## Workflow

This repo uses the superpowers plugin for Claude Code: brainstorming → writing-plans →
subagent-driven-development. Specs live in `docs/superpowers/specs/`, plans in
`docs/superpowers/plans/`. Each lens (operator UX, reliability, code health, etc.)
ships as a feature branch with cluster checkpoints, then fast-forward merge to main.
```

The actual final content will be filled in during implementation, sourced from `package.json` and a fresh codebase scan — no placeholders shipped.

**Acceptance:**
- `CLAUDE.md` describes Ortus Outreach, not the ElevenLabs project.
- Tech stack table matches `package.json` deps (Express, GoLogin 2.2.8, puppeteer-core 22, etc.).
- Architecture section names files that actually exist with correct line counts (verify before writing).
- "GSD Workflow Enforcement" and "Developer Profile" sections are gone.
- New file ends with no broken references (no `/gsd:*` commands referenced if those don't exist anymore).

**Risk:** Low. CLAUDE.md only affects Claude's session-grounding, not runtime.

---

## P3 — Resolve stale `data/*.json` modifications

**Problem:** `data/schedules.json` and `data/templates.json` have local modifications that have sat uncommitted since `3cc0eed` (the 09-01 schedules feature). Diffstat: `schedules.json` 2 lines, `templates.json` 29 lines added. These are presumably the user's working state from local testing — never reverted, never committed.

**Change:**

Default approach (commit current state as the new baseline):
1. `git diff data/schedules.json data/templates.json` — review the diffs.
2. If the changes look like real templates / schedules the user wants to keep: `git add data/schedules.json data/templates.json && git commit`.
3. If they look like throwaway test data: `git checkout data/schedules.json data/templates.json` to revert to the last committed state.

The single-sweep choice is "commit current state" (per design discussion), but the implementation must show the diff to the user first so they can override before committing.

**Acceptance:**
- `git status` shows no modifications to `data/schedules.json` or `data/templates.json`.
- The committed state matches what the running app sees (no surprise template/schedule appearance/disappearance after merge).

**Risk:** Zero — JSON file change, easily reversible if wrong.

---

## P4 — Sweep dead commented blocks + unused helpers

**Problem:** `src/` and `public/js/app.js` accumulated commented-out code blocks and helper functions that are defined but never called over the project's lifetime. They add reading overhead and confuse newcomers (or future-Claude) about what's current.

**Change:**

Two-pass sweep, both pure deletion (no rewrites):

**Pass A — Multi-line commented blocks:**
1. Grep `src/*.js`, `src/**/*.js`, `public/js/app.js`, `server.js` for runs of 3+ consecutive lines starting with `//` (excluding JSDoc-style `/** */` blocks and single-line section dividers).
2. For each hit, decide case-by-case: is this a useful explanatory comment, or is it commented-out dead code? When in doubt, KEEP.
3. Delete only the obvious dead code (commented-out function bodies, abandoned implementations, "old version of X" blocks).

**Pass B — Defined-but-unused helpers:**
1. For each top-level `function`, `async function`, `const X = (...) =>`, and `class` in `src/*.js` and `public/js/app.js`, grep the entire repo for references.
2. If the only reference is the definition itself: candidate for deletion.
3. **Verify before deleting** — check for dynamic invocation patterns:
   - `window['funcName']`, `window.funcName`
   - Template literal interpolation: `` `${something}('args')` ``
   - String dispatch tables: `{ funcName: () => ... }` lookups
   - Event handler attribute strings: `onclick="funcName()"`
4. Delete only after confirming no dynamic call site.

Each deletion is a separate sub-commit so individual reverts are clean. After each pass, run `npm test` and (for `app.js` deletions) start the server and smoke-test the UI in a browser.

**Acceptance:**
- `npm test` passes (93 existing tests + any added by P5).
- Manual smoke test: server boots, login screen renders, dashboard renders, /api/campaign/status returns expected shape.
- Each deletion is a separate commit with message describing what was removed and why it was dead.

**Risk:** Medium. Wrongly deleting a dynamically-invoked helper would break the app silently. Mitigations:
- Verify-before-delete checklist (above)
- Per-deletion commits for clean revert
- Manual UI smoke test before merging branch
- If anything looks ambiguous, KEEP — this is opportunistic cleanup, not exhaustive.

---

## P5 — Unit tests for pure helpers in `src/campaign.js`

**Problem:** `src/campaign.js` is 1503 lines after the 2.8.20 work. Existing tests cover `withWatchdog`, `appendErrorLog` (via `error-log-helper.test.js`), state pruning (via `state-pruning.test.js`), and pieces of the resource monitor and parking. There's still uncovered pure-logic surface area where a regression would be silent until colleagues hit it.

**Change:**

Three steps:

**Step 1 — Inventory pure helpers in `src/campaign.js`:**
Grep for top-level `function`, `async function`, and `const X = (...) =>` declarations. For each, classify:
- **Pure** — takes values, returns values, no `await fs.*`, no `await page.*`, no `await fetch(...)`, no `import('gologin')`, no `Date.now()` mutation. Just math, string manipulation, object/array transforms, conditional logic.
- **Impure** — touches the world somehow.

Only Pure helpers are candidates. Examples likely to surface:
- weeklyLimited eligibility check (has profile hit weekly cap given today's date + state?)
- Throttle/pacing math (next-action delay given current rate, daily cap, hour-of-day)
- Time-window helpers (is "now" within active hours; days-since-last-action)
- Parking eligibility (given recent skip count and BATCH_SIZE, should this be parked?)

The actual list comes from the inventory — the bullets above are likely candidates, not a binding promise.

**Step 2 — Extract pure helpers (if needed) for testability:**
Some pure helpers may currently live as inline closures inside larger functions. For each one we want to test:
- If it's already a top-level function in `src/campaign.js`: add an export from a sibling `src/campaign-helpers.js` that re-exports it (or extract to that file outright).
- If it's a closure: extract it to `src/campaign-helpers.js` as a named export, replace the inline use with a call.

The pattern matches what `withWatchdog` does today — the test imports it via `src/campaign.js` or a helper module.

No public API of `src/campaign.js` changes (`startCampaign`, `stopCampaign`, `getCampaignStatus`, etc. unchanged).

**Step 3 — Write `node --test` tests:**
For each extracted helper, write a `tests/<helper-name>.test.js` file (matching the `tests/watchdog-helper.test.js` shape):
- Happy path assertion
- 1-2 edge cases (boundary conditions, null/undefined handling, empty arrays)

Aim: ~10-25 new tests across 3-5 helpers. Not exhaustive coverage — just close the obvious gaps.

**Acceptance:**
- All new tests pass via `npm test`.
- The 93 existing tests still pass.
- No public-API change to `src/campaign.js` (verify by grepping consumers in `server.js` for any function call that's now broken).
- Each new test file follows the existing pattern (one helper per file, descriptive test names).

**Risk:** Low. Worst case: extraction introduces a subtle change in closure semantics. Mitigation: extraction happens before tests are written, so the first test run validates the extracted helper still behaves like the inline original.

---

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| P1 | Low | A test or import references a moved file | grep before move; `npm test` after |
| P2 | Low | CLAUDE.md describes something inaccurately | Verify against actual `package.json` and source layout before writing |
| P3 | Zero | Wrong baseline committed | Revert with `git checkout` |
| P4 | Medium | Dynamically-invoked helper deleted | Verify-before-delete checklist; per-deletion commits; UI smoke test |
| P5 | Low | Extraction breaks campaign internals | First test run validates the extracted helper matches inline behavior |

## Branch & version shape

- Branch: `code-health-2.8.21` cut from `main` (currently at `37f2fdd`)
- Patches commit in order P1 → P2 → P3 → P4 → P5
- FINAL commit bumps `package.json` version 2.8.20 → 2.8.21
- Single end-of-branch verification: `npm test` green + manual UI smoke test
- Merge to main as fast-forward (matches 2.8.19 / 2.8.20 pattern)

## Files touched (summary)

| File | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| `elevenlabs-apps-script.js` | DELETE | | | | |
| `.planning/**/*` | DELETE | | | | |
| `CLAUDE.md` | | REWRITE | | | |
| `data/schedules.json` | | | COMMIT | | |
| `data/templates.json` | | | COMMIT | | |
| `src/campaign.js` | | | | maybe | extract |
| `src/campaign-helpers.js` | | | | | NEW (if extraction needed) |
| `public/js/app.js` | | | | maybe | |
| `server.js` | | | | maybe | |
| `tests/<helper-name>.test.js` (×3-5) | | | | | NEW |
| `package.json` | | | | | bump to 2.8.21 (FINAL) |

(P4 "maybe" entries depend on what the dead-code sweep finds; could be zero-touch on a given file.)
