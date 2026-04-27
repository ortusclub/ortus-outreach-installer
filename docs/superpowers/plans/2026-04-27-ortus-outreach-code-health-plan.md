# Ortus Outreach Code-Health 2.8.21 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up cruft from prior projects, fix the wrong-project CLAUDE.md, resolve stale data files, sweep dead commented code, and add unit tests for already-exported pure helpers in `src/campaign.js` — all without changing campaign behavior.

**Architecture:** Single-sweep patch series on branch `code-health-2.8.21`. Five patches commit in order P1 → P2 → P3 → P4 → P5, then FINAL bumps version. All patches are additive or removal-only. Single end-of-branch verification (no mid-wave checkpoints). Each P4 deletion ships as its own sub-commit so individual reverts are clean.

**Tech Stack:** Node ≥22 (currently v25.9.0), vanilla JS + Express 4, Electron 33, GoLogin 2.2.8, puppeteer-core 22, `node --test` for backend tests, no bundler for frontend, manual browser smoke for UI.

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `elevenlabs-apps-script.js` | (root) — wrong-project leftover, 89KB Apps Script | P1 (delete) |
| `.planning/` | (root) — wrong-project planning artifacts (~60 files) | P1 (delete) |
| `CLAUDE.md` | (root) — Claude session-grounding doc | P2 (rewrite) |
| `data/schedules.json` | (data) — runtime schedule persistence | P3 (commit current) |
| `data/templates.json` | (data) — runtime template persistence | P3 (commit current) |
| `src/campaign.js` | (~1503 lines) — campaign loop, parking, throttle | P4 (maybe), P5 (no change to public API) |
| `public/js/app.js` | (~3946 lines) — frontend logic | P4 (maybe) |
| `server.js` | (~1158 lines) — Express routes, orchestration | P4 (maybe) |
| `tests/compute-between-batch-wait.test.js` | NEW — unit tests for pure helper | P5 |
| `tests/should-close-between-batches.test.js` | NEW — unit tests for pure helper | P5 |
| `tests/extract-linkedin-url.test.js` | NEW — unit tests for pure helper | P5 |
| `tests/mode-hint.test.js` | NEW — unit tests for pure helper | P5 |
| `package.json` | version field | FINAL (bump to 2.8.21) |

---

## Task 0: Pre-flight + branch creation

**Files:**
- Read: `package.json`, `.git/HEAD` (via `git status`)
- Modify: none
- Create: branch `code-health-2.8.21`

- [ ] **Step 1: Verify on main, version is 2.8.20, working tree clean enough to branch**

Run:
```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected:
- Branch: `main`
- Version: `2.8.20`
- `git status --short` may show `M data/schedules.json` and `M data/templates.json` — that's fine, P3 will resolve. ANY OTHER modifications: stop and ask the controller.

- [ ] **Step 2: Verify all 93 tests pass on main**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# pass 93` (or more if 2.8.20 added tests we forgot — anything is fine as long as `# fail 0`). If any test fails, stop.

- [ ] **Step 3: Create and switch to branch `code-health-2.8.21`**

Run:
```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b code-health-2.8.21
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `code-health-2.8.21`

- [ ] **Step 4: Confirm branch state**

No commit needed — branch was created from `main` at `d12e98a` (or wherever `main` HEAD is). Subsequent tasks commit on this branch.

---

## Task P1: Move ElevenLabs project out of repo

**Files:**
- Move: `elevenlabs-apps-script.js` → `../ortus-elevenlabs-calling/elevenlabs-apps-script.js`
- Move: `.planning/` → `../ortus-elevenlabs-calling/.planning/`
- Modify: nothing else in this repo

- [ ] **Step 1: Verify nothing in Ortus Outreach source imports the ElevenLabs files**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "elevenlabs-apps-script\|\.planning" src/ public/ server.js electron/ 2>/dev/null | grep -v "^Binary"
```

Expected: zero matches. If any match, stop and report — don't move yet.

- [ ] **Step 2: Verify destination doesn't already exist**

Run:
```bash
ls -la /Users/antoniovarlese/ortus-elevenlabs-calling 2>&1
```

Expected: `No such file or directory`. If the directory exists with content, stop and ask the controller before overwriting.

- [ ] **Step 3: Create destination and move files**

Run:
```bash
mkdir -p /Users/antoniovarlese/ortus-elevenlabs-calling
mv /Users/antoniovarlese/ortus-gologin-clone/elevenlabs-apps-script.js /Users/antoniovarlese/ortus-elevenlabs-calling/
mv /Users/antoniovarlese/ortus-gologin-clone/.planning /Users/antoniovarlese/ortus-elevenlabs-calling/
```

Expected: no errors.

- [ ] **Step 4: Verify the move (file present at destination, gone from source)**

Run:
```bash
ls -la /Users/antoniovarlese/ortus-elevenlabs-calling/elevenlabs-apps-script.js
ls -la /Users/antoniovarlese/ortus-elevenlabs-calling/.planning/ | head -5
ls /Users/antoniovarlese/ortus-gologin-clone/elevenlabs-apps-script.js 2>&1
ls -d /Users/antoniovarlese/ortus-gologin-clone/.planning 2>&1
```

Expected:
- First two: file/dir listings showing the moved content.
- Last two: `No such file or directory` (or `cannot access`).

- [ ] **Step 5: Stage removals in this repo**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add -A elevenlabs-apps-script.js .planning
git status --short | head -20
```

Expected: `git status` shows D (deleted) lines for `elevenlabs-apps-script.js` and the `.planning/` files. No `??` (untracked) lines from these paths.

- [ ] **Step 6: Confirm tests still pass and server still boots**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: same pass count as Task 0 Step 2 (`# fail 0`).

Then start the server and immediately stop:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && timeout 3 node server.js 2>&1 | head -10
```

Expected: server logs its startup messages and is killed by timeout (exit 124). No `Cannot find module` or import errors related to the moved files.

- [ ] **Step 7: Commit P1**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git commit -m "$(cat <<'EOF'
chore(2.8.21): P1 — move ElevenLabs project to sibling folder

The repo accumulated ~60 files from a different project (the ElevenLabs
Apps Script for the calling sidebar). None imported by Ortus Outreach.
Moved to ../ortus-elevenlabs-calling/ as a plain folder (no git init).

Removed:
- elevenlabs-apps-script.js (89KB)
- .planning/ (project planning artifacts: phases, research, seeds, etc.)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds. `git log -1 --stat | head -10` shows the deletions.

---

## Task P2: Rewrite CLAUDE.md for Ortus Outreach

**Files:**
- Modify: `CLAUDE.md` (full rewrite)

- [ ] **Step 1: Read current CLAUDE.md and confirm it describes the wrong project**

Run:
```bash
head -30 /Users/antoniovarlese/ortus-gologin-clone/CLAUDE.md
```

Expected: First non-blank lines mention "ElevenLabs Calling Integration — Sidebar Enhancements" or similar. Confirms this is the wrong-project description.

- [ ] **Step 2: Read package.json to source the deps table accurately**

Run:
```bash
node -e "const p = require('/Users/antoniovarlese/ortus-gologin-clone/package.json'); console.log('NAME:', p.name); console.log('VERSION:', p.version); console.log('DEPS:'); for (const [k,v] of Object.entries(p.dependencies||{})) console.log(' ', k, v); console.log('DEV-DEPS:'); for (const [k,v] of Object.entries(p.devDependencies||{})) console.log(' ', k, v);"
```

Expected: `NAME: ortus-outreach`, version, and the actual dep list.

- [ ] **Step 3: Inventory src/ files for the architecture section**

Run:
```bash
wc -l /Users/antoniovarlese/ortus-gologin-clone/src/*.js /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js /Users/antoniovarlese/ortus-gologin-clone/server.js | sort -rn
ls /Users/antoniovarlese/ortus-gologin-clone/src/linkedin/ 2>/dev/null
```

Expected: line counts for each src file, and listing of `src/linkedin/` (which holds the off-limits files).

- [ ] **Step 4: Write the new CLAUDE.md**

Replace the entire content of `/Users/antoniovarlese/ortus-gologin-clone/CLAUDE.md` with the following. Substitute the `{{...}}` placeholders using the actual values gathered in Steps 2-3 — do NOT leave `{{...}}` literals in the file.

```markdown
## Project

**Ortus Outreach** — LinkedIn outreach automation for The Ortus Club. Electron desktop app
that drives multiple GoLogin browser profiles to send connection requests, follow-ups,
and direct messages from a Google Sheet of leads. Used by ~3 colleagues on macOS laptops.

**Core value:** Reliable, observable, hands-off outreach. The campaign loop must keep
running even when individual accounts hit limits, sessions expire, or laptops are slow.

### Constraints

- **Runtime:** Node ≥22 (currently {{NODE_VERSION e.g. v25.9.0}}), no bundler for frontend, vanilla JS + Express 4
- **Browser automation:** GoLogin SDK {{gologin version from package.json}} + puppeteer-core {{version}}, headed only
- **Test framework:** `node --test` (no Jest, no Vitest)
- **Distribution:** electron-builder DMG for macOS (no auto-update yet)
- **End-user hardware:** colleagues run on slow/overloaded machines; assume CPU/RAM
  starvation when tuning timeouts

## Technology Stack

| Library | Version | Purpose |
|---------|---------|---------|
| express | {{from package.json}} | HTTP server, routes |
| gologin | {{version}} | Browser profile management |
| puppeteer-core | {{version}} | Browser automation |
| node-cron | {{version}} | Scheduled campaign triggers |
| nodemailer | {{version}} | Notification emails (errors/digests) |
| bcryptjs | {{version}} | Password hashing for local auth |
| cookie-parser | {{version}} | Session cookie parsing |
| pidusage | {{version}} | Process resource sampling |
| dotenv | {{version}} | .env loading |
| electron (dev) | {{version}} | Desktop shell |
| electron-builder (dev) | {{version}} | DMG builds |

## Architecture

- `server.js` ({{LINES}} lines) — Express app, all HTTP routes, campaign orchestration entry points
- `src/campaign.js` ({{LINES}} lines) — campaign loop, parking, watchdog, throttle, state, history
- `src/gologin-launcher.js` / `src/local-launcher.js` — browser launching paths
- `src/linkedin/` — outreach actions, navigation, selectors (**off-limits — see Conventions**)
- `src/sheets.js` / `src/sheets-writer.js` — Google Sheets read/write
- `src/disk-check.js` / `src/resource-monitor.js` — preflight + runtime resource checks
- `src/auth.js` — local auth (bcryptjs)
- `src/notifier.js` — email notifications
- `src/caffeinate.js` — keep-awake on macOS during runs
- `public/index.html` + `public/js/app.js` ({{LINES}} lines) + `public/css/style.css` —
  command-deck UI (monochrome, hairlines, gold only on Start CTA)
- `electron/main.js` — Electron shell

## Conventions

- **Atomic JSON writes** — write to `<file>.tmp` then `rename`; see `appendErrorLog` in `src/campaign.js` and `saveState` patterns.
- **NDJSON for crash-safe append-only logs** — see `appendFatalErrorSync` in `server.js` for the fatal-error log written from synchronous error handlers.
- **Bugatti command-deck design system** — monochrome, hairlines, gold only on Start CTA, radii 0 or 9999, no other accent colors. Tokens defined at top of `public/css/style.css`.
- **Testing pattern** — `node --test tests/*.test.js`. Pure-helper unit tests preferred over integration tests; manual browser verification for UI changes.
- **Off-limits files** — `src/linkedin/outreach.js` and `src/linkedin/actions.js`. The user has been burned by changes here. Never modify these without an explicit user request.

## Workflow

This repo uses the superpowers plugin for Claude Code: brainstorming → writing-plans →
subagent-driven-development. Specs live in `docs/superpowers/specs/`, plans in
`docs/superpowers/plans/`. Each lens (operator UX, reliability, code health, etc.)
ships as a feature branch (`<lens>-<version>`) with end-of-branch verification, then
fast-forward merge to `main`.

Recent lenses shipped:
- 2.8.19 — operator UX paper-cuts (lens A)
- 2.8.20 — reliability under stress (lens B)
- 2.8.21 — code health & hygiene (lens C, this branch)
```

After writing, verify no `{{...}}` placeholder remains:

```bash
grep -n "{{" /Users/antoniovarlese/ortus-gologin-clone/CLAUDE.md
```

Expected: zero matches.

- [ ] **Step 5: Verify the new CLAUDE.md does not reference removed content**

Run:
```bash
grep -nE "ElevenLabs|Apps Script|GSD|gsd-|sidebar|Voice" /Users/antoniovarlese/ortus-gologin-clone/CLAUDE.md
```

Expected: zero matches. (If "GSD" matches as part of `Google Sheets Drive` or some legitimate reason, leave it — but the old `/gsd:profile-user`, `gsd:execute-phase` etc. references must be gone.)

- [ ] **Step 6: Commit P2**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
chore(2.8.21): P2 — rewrite CLAUDE.md to describe Ortus Outreach

Previous version described "ElevenLabs Calling Integration — Sidebar
Enhancements" (the wrong project — leftover from prior repo use).
Replaced with accurate Ortus Outreach description: project purpose,
runtime constraints, tech stack, architecture, conventions, workflow.

Removed stale sections: GSD Workflow Enforcement, Developer Profile
placeholder. Project has moved to superpowers brainstorm/plan/execute.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task P3: Resolve stale `data/*.json`

**Files:**
- Modify: stage `data/schedules.json`, `data/templates.json` for commit

- [ ] **Step 1: Show the diffs to the controller for awareness**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git diff data/schedules.json data/templates.json
```

Expected: small diffs (~31 lines total). Inspect for anything obviously wrong (e.g., a half-typed template, a test entry called "DELETEME"). If anything looks like garbage, stop and report to the controller.

- [ ] **Step 2: Stage and commit current state as the new baseline**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add data/schedules.json data/templates.json
git commit -m "$(cat <<'EOF'
chore(2.8.21): P3 — commit stale data/*.json modifications as new baseline

These files held local working-state modifications uncommitted since the
schedules feature shipped at 3cc0eed. Committing current state so
git status is clean — no behavior change, just a new baseline that
matches what the running app sees.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Confirm git status is clean for these files**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git status --short data/schedules.json data/templates.json
```

Expected: zero output (no modifications outstanding).

---

## Task P4: Sweep dead commented blocks + unused helpers

**Files:**
- Modify (delete-only): `src/*.js`, `public/js/app.js`, `server.js` — case-by-case based on findings

This task has two passes (A: commented blocks, B: unused helpers). Each deletion ships as its own sub-commit. **KEEP when in doubt** — opportunistic cleanup, not exhaustive.

### Pass A — Multi-line commented-out code blocks

- [ ] **Step A1: Inventory candidate blocks**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
# Find runs of 3+ consecutive lines starting with //
for f in src/*.js src/**/*.js public/js/app.js server.js; do
  awk '/^[[:space:]]*\/\// { run++; if (run==1) start=NR; next } { if (run>=3) print FILENAME":"start"-"(NR-1)" ("run" lines)"; run=0 }' "$f" 2>/dev/null
done
```

Expected: a list of file:line-range candidates. Could be zero, could be a dozen. Make a notes file `/tmp/p4-pass-a.txt` with the output.

- [ ] **Step A2: For each candidate, decide KEEP or DELETE**

For each entry in `/tmp/p4-pass-a.txt`:

1. Open the file at the line range and read the comment block.
2. Classify:
   - **KEEP:** Explanatory comment about WHY something works the way it does. Documentation of a non-obvious invariant. License header. Section divider with intent. JSDoc-style block.
   - **DELETE:** Commented-out function body. "Old version of X" block. Abandoned implementation. Dead `console.log` blocks. TODO older than 6 months that's clearly never going to happen.
   - **WHEN IN DOUBT: KEEP.** This is opportunistic.

3. For each DELETE candidate, perform the deletion using `Edit`, then immediately commit:

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add <file>
git commit -m "chore(2.8.21): P4 — remove dead commented block in <file>:<line-range>

<one-line description of what the block was>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If the inventory in Step A1 returned zero candidates, skip Pass A entirely (no commit needed).

- [ ] **Step A3: Run tests after Pass A**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`. Same pass count as before Pass A (deletions of comments shouldn't affect test counts).

### Pass B — Defined-but-unused helpers

- [ ] **Step B1: Inventory candidate helpers in `src/campaign.js`**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
# Extract names of top-level functions and const-arrows
grep -nE "^(export )?(async )?function [A-Za-z_][A-Za-z0-9_]*\(" src/campaign.js | sed -E 's/.*function ([A-Za-z_][A-Za-z0-9_]*)\(.*/\1/' | sort -u > /tmp/p4-campaign-fns.txt
grep -nE "^(export )?const [A-Za-z_][A-Za-z0-9_]* = (async )?\(" src/campaign.js | sed -E 's/.*const ([A-Za-z_][A-Za-z0-9_]*) = .*/\1/' | sort -u >> /tmp/p4-campaign-fns.txt
sort -u /tmp/p4-campaign-fns.txt -o /tmp/p4-campaign-fns.txt
cat /tmp/p4-campaign-fns.txt
```

- [ ] **Step B2: For each helper, count references repo-wide**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
while read fn; do
  count=$(grep -rEho "\b$fn\b" src/ public/ server.js electron/ tests/ 2>/dev/null | wc -l | tr -d ' ')
  echo "$fn: $count"
done < /tmp/p4-campaign-fns.txt | sort -k2 -n -t:
```

Helpers with `count = 1` (only the definition itself) are deletion candidates. Helpers with `count = 2` may also be candidates if both refs are inside the definition (e.g., recursive function never called externally).

- [ ] **Step B3: Repeat inventory for `public/js/app.js` and `server.js`**

Run the same pattern as Step B1+B2 against `public/js/app.js` and `server.js`. Note candidate helpers.

- [ ] **Step B4: Verify-before-delete checklist for each candidate**

For each candidate from B2 / B3, before deleting, run ALL of these grep checks:

```bash
FN="<helper-name>"
cd /Users/antoniovarlese/ortus-gologin-clone

# Check 1: window['fnName'] or window.fnName
grep -rn "window\[['\"]\?$FN['\"]\?\]\|window\.$FN" src/ public/ server.js electron/ 2>/dev/null

# Check 2: Template literal call sites: `${...$FN(...)}` or backtick interpolations
grep -rn "\${[^}]*$FN" src/ public/ server.js electron/ 2>/dev/null

# Check 3: HTML attribute strings (onclick="fnName()", etc.)
grep -rn "['\"]$FN(" public/*.html src/ 2>/dev/null

# Check 4: String dispatch tables: { fnName: ... } where fnName is the key (not just the value)
grep -rn "[{,][[:space:]]*$FN[[:space:]]*:" src/ public/ server.js electron/ 2>/dev/null
```

Only delete if ALL FOUR checks return empty. Any non-empty result → KEEP.

- [ ] **Step B5: For each verified-dead helper, delete and commit individually**

Use `Edit` to remove the helper definition (and only the definition — no rewrites of nearby code). Then:

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add <file>
npm test 2>&1 | tail -3
git commit -m "chore(2.8.21): P4 — remove unused helper <fnName> in <file>

Verified zero references via window[], template literals, HTML attrs,
and dispatch tables. Definition was only call site.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If `npm test` fails after a deletion: revert with `git checkout <file>` and KEEP the helper. The dynamic-call check missed something.

- [ ] **Step B6: Manual UI smoke test after Pass B**

Start the server and click through the main flows in a browser. The dev server should already be running on port 3000 per the controller's environment. If not:

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node server.js &
```

Check (in a browser at `http://localhost:3000`):
- Login screen renders
- Dashboard loads after login
- `/api/campaign/status` returns expected shape (open browser DevTools, check Network tab on a status poll)
- Right-pane sections (Status, Parked, Passover, Throughput, Templates) all render

If anything looks broken, identify which deletion caused it (likely the most recent) and revert that single commit:
```bash
git revert HEAD --no-edit
```

Then re-add the helper to the KEEP list and continue.

- [ ] **Step B7: Final test pass after Pass B**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`.

---

## Task P5: Unit tests for already-exported pure helpers in `src/campaign.js`

**Files:**
- Create: `tests/compute-between-batch-wait.test.js`
- Create: `tests/should-close-between-batches.test.js`
- Create: `tests/extract-linkedin-url.test.js`
- Create: `tests/mode-hint.test.js`
- Modify: `src/campaign.js` — add `export` keyword to `getModeHint` if not already exported (verify in Step 1)

These four helpers are **already exported** from `src/campaign.js` (verified during plan-writing — see lines 91, 102, 174, 199). No extraction needed. `getModeHint` is currently `function getModeHint(...)` (not exported); Step 1 of its task confirms and adds `export` if needed.

The fifth candidate from the spec, `getCloseGapMin`, is too trivial to test (env-derived constant getter with simple fallback). Skipping.

### Helper A: `computeBetweenBatchWaitMs`

- [ ] **Step A1: Read the helper to confirm signature and behavior**

Read `src/campaign.js` lines 91-100 to see:
```javascript
export function computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs = 0 }) {
  // ...actual implementation
}
```

Note exact signature and the math used. The helper should compute "milliseconds to wait between batches given N batches/hour and an estimated batch duration". Confirm by reading.

- [ ] **Step A2: Write `tests/compute-between-batch-wait.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBetweenBatchWaitMs } from '../src/campaign.js';

// Pure logic — given N batches/hour and a batch duration, return the wait time
// between batches such that we hit the rate target. Math: hour/N - duration.

test('2 batches/hour with zero duration waits 30 minutes', () => {
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 2, batchDurationMs: 0 });
  assert.equal(ms, 30 * 60 * 1000);
});

test('4 batches/hour with zero duration waits 15 minutes', () => {
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 4, batchDurationMs: 0 });
  assert.equal(ms, 15 * 60 * 1000);
});

test('2 batches/hour with 5-minute duration waits 25 minutes', () => {
  const ms = computeBetweenBatchWaitMs({
    batchesPerHour: 2,
    batchDurationMs: 5 * 60 * 1000,
  });
  assert.equal(ms, 25 * 60 * 1000);
});

test('returns non-negative when batch duration exceeds slot', () => {
  const ms = computeBetweenBatchWaitMs({
    batchesPerHour: 2,
    batchDurationMs: 60 * 60 * 1000, // entire hour spent on one batch
  });
  assert.ok(ms >= 0, `expected non-negative wait, got ${ms}`);
});
```

If reading the helper in Step A1 reveals the math doesn't match the assertions above (e.g., the helper clamps differently, uses a min/max), adjust the assertions to match the **actual** behavior — these tests are characterization tests for the existing helper, not a contract change.

- [ ] **Step A3: Run the test to verify it passes**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --test tests/compute-between-batch-wait.test.js 2>&1 | tail -10
```

Expected: 4 passing tests. If any fails, the assertion is wrong (not the helper) — adjust the test to match actual behavior.

### Helper B: `shouldCloseBetweenBatches`

- [ ] **Step B1: Read the helper to confirm signature**

Read `src/campaign.js` lines 102-108 to see:
```javascript
export function shouldCloseBetweenBatches({ waitMs, closeGapMin }) {
  // ...
}
```

Note exact behavior. Likely returns `true` when `waitMs >= closeGapMin * 60 * 1000` or similar threshold.

- [ ] **Step B2: Write `tests/should-close-between-batches.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCloseBetweenBatches } from '../src/campaign.js';

// Decide whether to close browsers between batches based on the gap.
// Closing makes sense when the wait is long enough to recoup the
// re-launch cost.

test('long wait triggers close (10 min wait, 5 min threshold)', () => {
  const result = shouldCloseBetweenBatches({
    waitMs: 10 * 60 * 1000,
    closeGapMin: 5,
  });
  assert.equal(result, true);
});

test('short wait does not trigger close (2 min wait, 5 min threshold)', () => {
  const result = shouldCloseBetweenBatches({
    waitMs: 2 * 60 * 1000,
    closeGapMin: 5,
  });
  assert.equal(result, false);
});

test('exactly-at-threshold case is well-defined', () => {
  // Whatever the actual behavior is at boundary, assert it explicitly.
  // After reading the helper, set this to match.
  const result = shouldCloseBetweenBatches({
    waitMs: 5 * 60 * 1000,
    closeGapMin: 5,
  });
  // Update assertion based on actual implementation — characterize, don't change.
  assert.equal(typeof result, 'boolean');
});
```

After running the boundary case once, update the third test's assertion from `assert.equal(typeof result, 'boolean')` to the concrete `true`/`false` actual behavior. This locks in the current threshold semantics.

- [ ] **Step B3: Run the test**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --test tests/should-close-between-batches.test.js 2>&1 | tail -10
```

Expected: 3 passing tests after the boundary update.

### Helper C: `extractLinkedInUrl`

- [ ] **Step C1: Read the helper to confirm signature and behavior**

Read `src/campaign.js` lines 174-198. The signature is:
```javascript
export function extractLinkedInUrl(row, linkedinColumn) {
  // ...
}
```

Note: takes a sheet row (object/array) and a column hint, returns the LinkedIn URL string (or null/empty/undefined when not found). Note exact return type for missing cases.

- [ ] **Step C2: Write `tests/extract-linkedin-url.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedInUrl } from '../src/campaign.js';

// Pure parsing — find the LinkedIn URL in a sheet row, given an optional
// explicit column hint. Should handle:
// - Explicit column match (when linkedinColumn is set)
// - Auto-detect by scanning row values for "linkedin.com/in/" patterns
// - Missing/blank → null or empty string (characterize after reading helper)

test('finds URL in explicit column when linkedinColumn provided', () => {
  const row = { LinkedIn: 'https://www.linkedin.com/in/jane-doe', Name: 'Jane' };
  const url = extractLinkedInUrl(row, 'LinkedIn');
  assert.equal(url, 'https://www.linkedin.com/in/jane-doe');
});

test('auto-detects URL when linkedinColumn is empty', () => {
  const row = { Name: 'Jane', Profile: 'https://www.linkedin.com/in/jane-doe' };
  const url = extractLinkedInUrl(row, '');
  assert.ok(url && url.includes('linkedin.com/in/jane-doe'),
    `expected linkedin URL, got ${url}`);
});

test('returns falsy when no URL anywhere', () => {
  const row = { Name: 'Jane', Email: 'jane@example.com' };
  const url = extractLinkedInUrl(row, '');
  assert.ok(!url, `expected falsy, got ${url}`);
});

test('handles row with linkedin.com but no /in/ path', () => {
  const row = { Name: 'Jane', Site: 'https://www.linkedin.com/company/foo' };
  const url = extractLinkedInUrl(row, '');
  // Whatever the actual behavior — characterize after reading helper.
  // If helper requires /in/ path, expect falsy. If it accepts any linkedin.com, expect the URL.
  assert.ok(typeof url === 'string' || url == null,
    `expected string or null, got ${typeof url}`);
});
```

The fourth test characterizes a corner case — after running it, replace the loose assertion with the concrete actual behavior to lock semantics in.

- [ ] **Step C3: Run the test**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --test tests/extract-linkedin-url.test.js 2>&1 | tail -10
```

Expected: 4 passing tests (after the corner-case adjustment).

### Helper D: `getModeHint`

- [ ] **Step D1: Verify export status and read behavior**

Run:
```bash
grep -nE "^(export )?function getModeHint" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

If the line shows `export function getModeHint`, proceed to D3.

If it shows just `function getModeHint`, edit `src/campaign.js` to add the `export` keyword:

Find:
```javascript
function getModeHint(mode, prevAction) {
```
Replace with:
```javascript
export function getModeHint(mode, prevAction) {
```

(This is a public-API addition with no risk — adding an export doesn't change any existing call site behavior.)

Then read the function body (lines ~199-214) to understand the mapping logic.

- [ ] **Step D2: Run existing tests after the export change**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: same pass count as before. Adding `export` doesn't break anything.

- [ ] **Step D3: Write `tests/mode-hint.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModeHint } from '../src/campaign.js';

// Pure mapping — given a campaign mode and the previous action, return
// the hint string that drives the next action choice. Characterization
// tests: lock in current mapping so future refactors don't drift.

test('returns a string for known mode "connect_only"', () => {
  const hint = getModeHint('connect_only', null);
  assert.equal(typeof hint, 'string',
    `expected string for connect_only, got ${typeof hint}`);
});

test('returns a string for known mode "follow_up"', () => {
  const hint = getModeHint('follow_up', 'connect');
  assert.equal(typeof hint, 'string');
});

test('different prevAction may yield different hint within same mode', () => {
  // If helper considers prevAction, the two calls below may differ.
  // Test characterizes whatever the helper actually does.
  const hintA = getModeHint('follow_up', 'connect');
  const hintB = getModeHint('follow_up', 'follow_up_1');
  // Both must be strings; if they differ the helper considers prevAction.
  assert.equal(typeof hintA, 'string');
  assert.equal(typeof hintB, 'string');
});

test('handles unknown mode gracefully (no throw)', () => {
  assert.doesNotThrow(() => getModeHint('not_a_real_mode', null));
});
```

After running and seeing actual return values, tighten assertions where possible (e.g., if `getModeHint('connect_only', null)` returns `'connect'`, change `assert.equal(typeof hint, 'string')` to `assert.equal(hint, 'connect')`). Lock in current behavior.

- [ ] **Step D4: Run the test**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --test tests/mode-hint.test.js 2>&1 | tail -10
```

Expected: 4 passing tests.

### P5 finalization

- [ ] **Step P5-fin: Run the full suite**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: previous pass count + ~15 new tests (4+3+4+4), `# fail 0`.

- [ ] **Step P5-commit: Commit P5**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add tests/compute-between-batch-wait.test.js tests/should-close-between-batches.test.js tests/extract-linkedin-url.test.js tests/mode-hint.test.js src/campaign.js
git commit -m "$(cat <<'EOF'
feat(2.8.21): P5 — unit tests for pure helpers in src/campaign.js

Characterization tests (no behavior change) for four already-exported
pure helpers:
- computeBetweenBatchWaitMs (between-batch timing math)
- shouldCloseBetweenBatches (close-browsers threshold decision)
- extractLinkedInUrl (sheet row → URL parsing)
- getModeHint (campaign mode → action hint mapping)

Added export to getModeHint (was module-private). No public API removed
or renamed.

~15 new tests, all node --test pure-logic style matching existing
watchdog-helper / error-log-helper / state-pruning patterns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task FINAL: Version bump + verification

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1: Bump version 2.8.20 → 2.8.21**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```json
  "version": "2.8.20",
```
Replace with:
```json
  "version": "2.8.21",
```

- [ ] **Step 2: Confirm no other version-string references exist that need updating**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.20" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero matches in source code (excluding spec/plan/changelog references to historical versions).

- [ ] **Step 3: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Pass count = (previous 93 from main) + (any new from P5, ~15) − (any tests removed during P4, expect 0) = ~108.

- [ ] **Step 4: Manual UI smoke test (controller-driven)**

The dev server should already be running on port 3000 per the controller's environment. If not, start it:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node server.js &
```

In a browser at `http://localhost:3000`:
- Login screen renders cleanly
- Dashboard loads after login
- All right-pane sections visible (Status, Parked, Passover, Throughput, Templates)
- Disk warning banner area renders (may be empty if disk is fine — that's correct)
- Console (DevTools) shows no JS errors on initial load

If anything looks broken, identify which P4 commit likely caused it and revert just that commit. Re-test.

- [ ] **Step 5: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
chore(2.8.21): bump version after code-health patch (P1-P5)

Lens C — code health & hygiene:
- P1: ElevenLabs project moved to ../ortus-elevenlabs-calling/
- P2: CLAUDE.md rewritten to describe Ortus Outreach (was wrong project)
- P3: data/schedules.json + data/templates.json baseline committed
- P4: dead commented blocks + unused helpers swept (per-deletion commits)
- P5: unit tests added for 4 pure helpers in src/campaign.js

No runtime behavior changes to campaign loop, parking, watchdog,
throttle, or UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm branch state ready for merge**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git log --oneline main..HEAD
git status --short
```

Expected:
- Several commits on this branch ahead of main (one per patch + sub-commits from P4 + FINAL)
- `git status --short` is clean (no modifications, no untracked)

The controller will offer the merge command (`git checkout main && git merge code-health-2.8.21`) to the user.

---

## Notes for the executor

- **Each task is one subagent dispatch.** Tasks P4-PassA-DELETE-N and P5-Helper-X within a task are sub-steps inside the same dispatch.
- **P4 is the highest-risk task.** If a deletion breaks tests, immediately revert that single commit and KEEP the helper.
- **No P5 extraction needed.** Plan-writing verified all four target helpers are already exported (or only need an `export` keyword added, in `getModeHint`'s case).
- **Manual UI smoke is mandatory at FINAL Step 4.** Tests don't cover the frontend.
- **Branch never gets force-pushed.** All commits are additive history.
