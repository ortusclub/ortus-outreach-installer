# Ortus Outreach Concurrency Cap 2.8.25 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hard cap on the number of simultaneously-open browser profiles via env var `MAX_CONCURRENT_PROFILES` (default 3), with queue-and-rotate behavior so all selected accounts still get processed.

**Architecture:** Two patches in `src/campaign.js`. P1 adds the env-derived constant + a launch gate inside the existing `ensureOpen` function (which already returns `null` for "can't open right now" — caller already handles that with `continue`). P2 extends the existing close-vs-park decision at the end of each profile's batch with an additional condition: also close if other profiles are waiting for a slot. FINAL bumps version + documents the env var. NO touches to `src/linkedin/*`, no behavior changes for campaigns where `cap >= profileIds.length`.

**Tech Stack:** Node ≥22, vanilla JS + Express 4, `node --test` (no test changes in this lens — manual smoke is the verification).

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `src/campaign.js` (~1500 lines) | new constant + launch gate + close-decision extension | P1, P2 |
| `.env.example` | document the new env var | FINAL |
| `package.json` | version field bump | FINAL |

**Off-limits — DO NOT touch in any task:**
- `src/linkedin/outreach.js`, `src/linkedin/actions.js` (off-limits per memory)
- ALL of `public/`, `tests/`, `server.js`, `electron/`

If a task seems to require touching any of these, STOP and escalate.

---

## Task 0: Pre-flight + branch creation

- [ ] **Step 1: Verify on main, version is 2.8.24, working tree clean**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected: branch `main`, version `2.8.24`, working tree clean (or only untracked dev artifacts).

- [ ] **Step 2: Verify all tests pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count 120.

- [ ] **Step 3: Create and switch to branch `concurrency-cap-2.8.25`**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b concurrency-cap-2.8.25
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `concurrency-cap-2.8.25`. No commit on this task.

---

## Task P1: Launch gate

**Files:**
- Modify: `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js` — add constant near top + add gate inside `ensureOpen`

### Step group A — Add the constant

- [ ] **Step A1: Locate the existing `LEAD_TIMEOUT_MS` constant**

```bash
grep -n "LEAD_TIMEOUT_MS" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -3
```

Expected (after the 2.8.24 hotfix):
```
57:const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;
```

- [ ] **Step A2: Add `MAX_CONCURRENT_PROFILES` constant directly after `LEAD_TIMEOUT_MS`**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;
```

Replace with:
```javascript
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;

// Concurrency cap (2.8.25): max simultaneously-open browser profiles. With queue-
// and-rotate: if user selects more than this, the extras wait for a slot to free.
// Default 3 fits ~1.5 GB on 8 GB machines. Override via .env if you have more RAM.
const MAX_CONCURRENT_PROFILES = Number(process.env.MAX_CONCURRENT_PROFILES) || 3;
```

- [ ] **Step A3: Verify the constant was added**

```bash
grep -n "MAX_CONCURRENT_PROFILES" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -3
```

Expected: at least one match showing the constant declaration.

### Step group B — Add the launch gate inside `ensureOpen`

- [ ] **Step B1: Read the `ensureOpen` function**

```bash
sed -n '789,810p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected:
```javascript
    async function ensureOpen(profileId) {
      // Phase 2.8.10: refuse to launch new browsers after stop has been
      // requested. Closes the launch-race that was leaving orphan windows
      // requiring a second Stop click to clean up.
      if (campaign._abort) return null;

      const cached = sessions.get(profileId);
      if (cached) return cached;

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;
      ...
```

The gate goes immediately AFTER the `if (cached) return cached;` line (the cached-path doesn't need the gate — that profile already has its slot).

- [ ] **Step B2: Insert the launch gate**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
      const cached = sessions.get(profileId);
      if (cached) return cached;

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;
```

Replace with:
```javascript
      const cached = sessions.get(profileId);
      if (cached) return cached;

      // Concurrency cap (2.8.25-P1): if we're already at MAX_CONCURRENT_PROFILES
      // open browsers, this profile waits for a slot. Returning null here flows to
      // the existing `if (!session) continue;` in the round-robin (line ~943).
      // P2 forces a close at batch end if others are waiting, so the slot rotates.
      if (sessions.size >= MAX_CONCURRENT_PROFILES) {
        const waitingName = profileNameCache[profileId] || profileId;
        log(`  ⏸ ${waitingName}: waiting for a slot (${sessions.size}/${MAX_CONCURRENT_PROFILES} open)`);
        return null;
      }

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;
```

- [ ] **Step B3: Verify the gate is in place**

```bash
grep -nA 1 "Concurrency cap (2.8.25-P1)" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected: shows the comment line and the next line.

- [ ] **Step B4: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120.

- [ ] **Step B5: Commit P1**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js
git commit -m "$(cat <<'EOF'
feat(2.8.25): P1 — launch gate for MAX_CONCURRENT_PROFILES

Adds the launch-side half of the concurrency cap. New env var
MAX_CONCURRENT_PROFILES (default 3) declared near LEAD_TIMEOUT_MS.
A gate inside ensureOpen() returns null when sessions.size has hit
the cap — the caller's existing `if (!session) continue;` handles
the null by skipping the profile this round.

Without P2 (next commit), the first N profiles to launch would hold
their slots forever. P2 adds the forced close at batch end so the
slot rotates.

For campaigns where MAX_CONCURRENT_PROFILES >= profileIds.length
(the common case), behavior is identical to today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task P2: Forced close at batch boundary

**Files:**
- Modify: `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js` — extend the close decision at line ~1426

- [ ] **Step 1: Locate the close-vs-park decision**

```bash
grep -n "shouldCloseBetweenBatches" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -5
```

Expected:
```
102:export function shouldCloseBetweenBatches({ waitMs, closeGapMin }) {
1426:        if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })) {
```

The consumer site is line ~1426 (lines may have drifted slightly after P1).

- [ ] **Step 2: Read the surrounding context**

```bash
sed -n '1420,1440p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected:
```
        const batchDurationMs = Date.now() - batchStart;
        // Per-profile close-vs-park decision — cheaper to close if we won't
        // be back to this profile for a while. The round sleep below keeps
        // the global cadence; this only decides whether the profile sits idle
        // on about:blank or gets closed entirely between rounds.
        const perProfileWaitMs = computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs });
        if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })) {
          log(`  ⊗ ${pName}: gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min — closing browser.`);
          await closeSession(profileId);
        } else {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked until next round.`);
        }
```

- [ ] **Step 3: Extend the close decision**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
        const perProfileWaitMs = computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs });
        if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })) {
          log(`  ⊗ ${pName}: gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min — closing browser.`);
          await closeSession(profileId);
        } else {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked until next round.`);
        }
```

Replace with:
```javascript
        const perProfileWaitMs = computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs });

        // Concurrency cap (2.8.25-P2): also close if others are waiting for a
        // slot. Without this, the first N profiles hold their slots forever and
        // profiles N+1, N+2, ... never get to run.
        const othersWaiting = sessions.size >= MAX_CONCURRENT_PROFILES &&
          profileIds.some(id =>
            id !== profileId && !sessions.has(id) && !weeklyLimited.has(id)
          );

        if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs }) || othersWaiting) {
          const reason = othersWaiting && !shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })
            ? `slot rotation (${sessions.size - 1}/${MAX_CONCURRENT_PROFILES} after close)`
            : `gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min`;
          log(`  ⊗ ${pName}: ${reason} — closing browser.`);
          await closeSession(profileId);
        } else {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked until next round.`);
        }
```

- [ ] **Step 4: Verify the change**

```bash
grep -nA 1 "Concurrency cap (2.8.25-P2)" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected: shows the comment line and the next line.

- [ ] **Step 5: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120.

- [ ] **Step 6: Commit P2**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js
git commit -m "$(cat <<'EOF'
feat(2.8.25): P2 — forced close at batch boundary when others are waiting

Completes the queue-and-rotate behavior of the concurrency cap. When
sessions.size has hit MAX_CONCURRENT_PROFILES AND any other selected
profile (not weekly-limited) doesn't yet have a session, the current
profile MUST close at batch end regardless of the time-based
shouldCloseBetweenBatches heuristic.

Without this commit, P1's launch gate would starve profiles N+1, N+2,
... — they'd queue forever because the first N never close.

The log line distinguishes the two close reasons:
- "gap X min > Y min" — existing time-based decision
- "slot rotation (N-1/N after close)" — new rotation decision

For campaigns where cap >= profileIds.length, no profile is ever
"waiting", so the new condition never fires and behavior is identical
to today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task FINAL: Document env var + version bump

**Files:**
- Modify: `/Users/antoniovarlese/ortus-gologin-clone/.env.example` — document `MAX_CONCURRENT_PROFILES`
- Modify: `/Users/antoniovarlese/ortus-gologin-clone/package.json` — version field

- [ ] **Step 1: Read current `.env.example` to find a good insertion point**

```bash
cat /Users/antoniovarlese/ortus-gologin-clone/.env.example
```

The file documents the existing 11.1 RAM/CPU env knobs (`RAM_THROTTLE_PCT`, `CPU_THROTTLE_LOAD_FACTOR`, etc.) and 11.2 batch knobs (`PROFILE_CLOSE_GAP_MIN`). The new `MAX_CONCURRENT_PROFILES` belongs alongside those.

- [ ] **Step 2: Append `MAX_CONCURRENT_PROFILES` documentation**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/.env.example`. Append the following block at the end of the file (after the last existing knob — verify the exact last line via the read in Step 1, then add after it):

If the existing file ends with a `PROFILE_CLOSE_GAP_MIN=15` block, find:
```
# PROFILE_CLOSE_GAP_MIN=15
```
and replace with:
```
# PROFILE_CLOSE_GAP_MIN=15

# Concurrency cap (2.8.25)
# Maximum number of GoLogin browser profiles that can be open simultaneously.
# If you select more accounts than this, the extras queue and rotate in as
# slots free up (a profile closes at batch end when others are waiting).
# Default 3 — keeps RAM use under ~1.5 GB on 8 GB machines.
# Lower for weak hosts; raise for 16 GB+.
# MAX_CONCURRENT_PROFILES=3
```

If the file's actual last line is different, follow the same pattern: append the new block after the last existing knob, mirroring the comment-style of the surrounding entries.

- [ ] **Step 3: Bump version 2.8.24 → 2.8.25**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```
  "version": "2.8.24",
```
Replace with:
```
  "version": "2.8.25",
```

- [ ] **Step 4: Confirm no other 2.8.24 references in source**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.24" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero source-code matches. CLAUDE.md history line and any "Phase 2.8.24" comments are intentional and stay.

- [ ] **Step 5: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count = 120.

- [ ] **Step 6: Smoke test the dev server**

```bash
curl -s http://localhost:3000/api/health
```

Expected: JSON with `"ok":true`. (`version` field will still report 2.8.24 until the dev server is restarted — that's fine.)

- [ ] **Step 7: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add .env.example package.json
git commit -m "$(cat <<'EOF'
chore(2.8.25): bump version after concurrency cap (P1-P2)

Lens G — RAM/CPU reduction (concurrency cap):
- P1: launch gate inside ensureOpen — gates new browser launch on
      sessions.size < MAX_CONCURRENT_PROFILES (env, default 3)
- P2: forced close at batch boundary when others are waiting —
      extends shouldCloseBetweenBatches decision so the slot rotates
- FINAL: documents MAX_CONCURRENT_PROFILES in .env.example + bump

For campaigns where cap >= profileIds.length (common case), behavior
is identical to today. For larger account counts, the queue-and-
rotate behavior keeps RAM under control.

All other RAM/CPU levers from the brainstorm (more aggressive
Chromium flags, critical-close, periodic page reload, JS purge via
CDP, dashboard polling backoff) explicitly deferred for future lenses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Confirm branch state ready for merge**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git log --oneline main..HEAD
git status --short
```

Expected:
- 3 commits on this branch ahead of main (P1, P2, FINAL)
- `git status --short` clean

---

## Notes for the executor

- **Each task is one subagent dispatch.** Sub-step groups within P1 are inside the same dispatch.
- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`, ALL of `public/`, `tests/`, `server.js`, `electron/`. This lens touches ONLY `src/campaign.js`, `.env.example`, and `package.json`.
- **No new tests in this lens.** Manual smoke is the verification (controller will run it post-merge).
- **Verify line numbers before editing.** Plan quotes line numbers from the 2.8.24 codebase; if they've drifted slightly, find the equivalent anchor (the function name `ensureOpen` and the `shouldCloseBetweenBatches` consumer are reliable text anchors).
- **The launch gate's log line** must use `profileNameCache[profileId] || profileId` to show the human-readable name, matching the surrounding logging style.
- **Branch never gets force-pushed.** All commits are additive history.
