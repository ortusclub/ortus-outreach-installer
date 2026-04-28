# Ortus Outreach Campaign Hotfix 2.8.24 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two CRITICAL silent-lead-loss bugs and two HIGH reliability bugs in the campaign loop, all via additive surgical changes in `src/campaign.js` only.

**Architecture:** Single-sweep patch series on branch `hotfix-2.8.24`. Three patches: P1 (boot scrubber for stale `_in_progress` markers in `startCampaign`), P2 (LEAD_TIMEOUT_MS 90s → 180s), P3 (local-browser login wait honors `campaign._abort`). FINAL bumps version. NO touches to `src/linkedin/*`, NO control-flow changes in WEEKLY_LIMIT / INMAIL_NO_CREDITS / catch-block branches (boot scrubber covers them).

**Tech Stack:** Node ≥22, vanilla JS + Express 4, `node --test` (no test changes in this hotfix).

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `src/campaign.js` (~1500 lines) | boot scrubber addition + constant edit + abort-check addition | P1, P2, P3 |
| `package.json` | version field | FINAL |

**Off-limits — DO NOT touch in any task:**
- `src/linkedin/outreach.js`, `src/linkedin/actions.js` (off-limits per memory)
- ALL of `public/`, `tests/`, `server.js`, `electron/` (this is a 3-line hotfix in `src/campaign.js` only)

If a task seems to require touching any of these, STOP and escalate.

---

## Task 0: Pre-flight + branch creation

- [ ] **Step 1: Verify on main, version is 2.8.23, working tree clean**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected: branch `main`, version `2.8.23`, working tree clean (or only untracked dev artifacts).

- [ ] **Step 2: Verify all tests pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count 120.

- [ ] **Step 3: Create and switch to branch `hotfix-2.8.24`**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b hotfix-2.8.24
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `hotfix-2.8.24`. No commit on this task.

---

## Task P1: Boot scrubber for stale `_in_progress` markers

**Files:**
- Modify: `src/campaign.js` — add ~6 lines inside `startCampaign`, between `loadState()` and the pre-filter

- [ ] **Step 1: Verify the anchor (`const state = await loadState();`)**

```bash
grep -n "const state = await loadState" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected: line 680 (currently). If the line number has drifted, find the equivalent — the anchor is the line immediately after the sheet fetch + ensureTrackingColumns block, where `state` is assigned from `loadState()`.

- [ ] **Step 2: Read the surrounding context to confirm insertion point**

```bash
sed -n '678,684p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected:
```
    });

    const state = await loadState();

    // Pre-filter targets. Filter rules (new schema):
    //   - check_status: only process rows with CC="Sent" (pending invites).
```

The new block goes between line 680 (`const state = await loadState();`) and line 682 (`// Pre-filter targets.`).

- [ ] **Step 3: Insert the boot scrubber block**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
    const state = await loadState();

    // Pre-filter targets. Filter rules (new schema):
```

Replace with:
```javascript
    const state = await loadState();

    // Hotfix 2.8.24-P1: clear stale _in_progress markers from previous runs.
    // These accumulate from (a) exceptions in the per-lead catch at the bottom
    // of the inner loop, (b) WEEKLY_LIMIT / INMAIL_NO_CREDITS branches that
    // don't clean up, and (c) hard crashes mid-lead. Without this, leads stuck
    // _in_progress are invisible to the pre-filter for STATE_RETENTION_DAYS.
    const stalePending = Object.entries(state.processed).filter(
      ([, v]) => v?.action === '_in_progress'
    );
    if (stalePending.length > 0) {
      log(`Clearing ${stalePending.length} stale _in_progress marker(s) from previous run`);
      for (const [url] of stalePending) delete state.processed[url];
      await saveState(state);
    }

    // Pre-filter targets. Filter rules (new schema):
```

- [ ] **Step 4: Verify the change is in place**

```bash
grep -nA 1 "Hotfix 2.8.24-P1" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected: shows the comment line and the next line.

- [ ] **Step 5: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120.

- [ ] **Step 6: Manual smoke test (optional but recommended)**

If the dev server is running on port 3000 and you can poke at `data/state.json`, you can manually inject a test marker and confirm the scrubber clears it on next campaign start. This is OPTIONAL — the controller will do a real smoke test post-merge.

If you want to do it:
```bash
# Inspect current state.json
cat /Users/antoniovarlese/ortus-gologin-clone/data/state.json | python3 -m json.tool 2>/dev/null | head -20
```

(Don't actually inject a test marker if it could affect a running campaign.)

- [ ] **Step 7: Commit P1**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js
git commit -m "$(cat <<'EOF'
fix(2.8.24): P1 — boot scrubber for stale _in_progress markers

Code review on 2026-04-27 surfaced two CRITICAL bugs around silent
lead loss:
1. The catch block at campaign.js:1396 doesn't clear _in_progress
   on exception
2. WEEKLY_LIMIT (campaign.js:1229) and INMAIL_NO_CREDITS
   (campaign.js:1244) branches don't clear it either

In both cases the pre-filter at lines 712, 725, 731, 736 sees the
stuck marker on next run and excludes the lead until the 60-day
STATE_RETENTION_DAYS prune evicts it. Combined effect: every
campaign that hits a weekly limit silently drops the leads in
flight at limit-trip — and Ortus's whole multi-account architecture
is designed around hitting weekly limits.

Fix: a boot scrubber at the top of startCampaign (right after
loadState) clears all _in_progress markers from previous runs.
One block covers all four ways the marker gets stuck:
- Exception in the inner catch
- WEEKLY_LIMIT branch
- INMAIL_NO_CREDITS branch
- Hard Node crash mid-lead

Pure additive code. Runs once per campaign start. No control-flow
changes anywhere in the loop. delete + await saveState matches the
existing pattern at line 991.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task P2: Watchdog timeout 90s → 180s

**Files:**
- Modify: `src/campaign.js` line 57 — change `90000` to `180000`

- [ ] **Step 1: Verify the anchor**

```bash
grep -n "LEAD_TIMEOUT_MS" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -3
```

Expected (currently):
```
54: *  90s; env-overridable for stress-testing (LEAD_TIMEOUT_MS=2000 will time
57:const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;
```

If line 57 doesn't show `90000`, find the equivalent line.

- [ ] **Step 2: Edit the constant**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;
```

Replace with:
```javascript
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;
```

- [ ] **Step 3: Optionally update the comment above (line 54)**

The comment currently says `90s`. Update to `180s` to keep it accurate.

```bash
sed -n '50,60p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Read the comment block. If it references `90s` literally, use `Edit` to replace `90s` with `180s` in that comment. If the comment is more abstract (e.g. "default timeout"), leave it alone. JUDGE per the actual content.

- [ ] **Step 4: Verify the change**

```bash
grep -n "LEAD_TIMEOUT_MS" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -3
```

Expected: line 57 now shows `180000`.

- [ ] **Step 5: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`. (`tests/watchdog-helper.test.js` uses its own copy of `withWatchdog` with explicit `timeoutMs` per test; it doesn't depend on the constant.)

- [ ] **Step 6: Commit P2**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js
git commit -m "$(cat <<'EOF'
fix(2.8.24): P2 — bump LEAD_TIMEOUT_MS 90s -> 180s

The legitimate Connect-with-verify path on slow GoLogin hosts can
take ~100-115s (deep-read 20-30s + nav 15s + post-Send verify
60-70s). The current 90s watchdog kills these as "lead_timeout_
watchdog", which is in TRANSIENT_SIGNALS so it triggers 3 retries
(45s of wait), all guaranteed to time out the same way. Net: ~6 min
wasted per slow lead, plus the connection MAY have actually sent.

CLAUDE.md notes "colleagues run on slow, overloaded machines" —
this bug is exactly the kind of thing colleagues hit.

180s sits comfortably above the worst legitimate path. Trade-off:
a genuinely hung lead now blocks for 3 min instead of 90s. With
BATCH_SIZE=5 a stuck batch worst-case = 15 min. Acceptable given
the alternative is wasting 6 min on every false positive.

Env-var override (LEAD_TIMEOUT_MS) preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task P3: Local-browser login wait honors abort

**Files:**
- Modify: `src/campaign.js` — add `if (campaign._abort) break;` inside the local-browser login wait loop body

- [ ] **Step 1: Verify the anchor — the local-browser login wait loop at line 550**

```bash
sed -n '548,560p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected:
```
      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for login... (${(wait + 1) * 5}s)`);
      }
      if (!loggedIn) {
```

(Note the LOCAL-browser version of this loop. The GoLogin branch starts around line 580 and ALREADY has the abort check at line 582 — DO NOT modify the GoLogin branch.)

- [ ] **Step 2: Verify the GoLogin branch's existing abort-check pattern**

```bash
sed -n '580,590p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected:
```
      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        ...
```

The local-browser fix mirrors this exactly: insert `if (campaign._abort) break;` BEFORE the `await new Promise(r => setTimeout(r, 5000));` inside the loop body.

- [ ] **Step 3: Apply the edit**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/src/campaign.js`.

Find:
```javascript
      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for login... (${(wait + 1) * 5}s)`);
      }
```

Replace with:
```javascript
      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for login... (${(wait + 1) * 5}s)`);
      }
```

(The diff is exactly one new line: `if (campaign._abort) break;`.)

IMPORTANT: This `Edit` will match BOTH login-wait loops because they share most lines. To uniquely target the LOCAL-BROWSER one, the `find` block above includes `Still waiting for login...` (without profile name) — the GoLogin variant says `Still waiting for ${pName} login...` (with profile name). That difference makes the two blocks distinct. Verify the matched block is the local-browser one before saving.

If the `Edit` tool reports the find-string isn't unique, READ both loop blocks side-by-side, identify a unique anchor, and refine. Do NOT use `replace_all`.

- [ ] **Step 4: Verify both loops have abort checks**

```bash
grep -nB 1 -A 1 "if (campaign._abort) break;" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -15
```

Expected: at least two matches — one in the local-browser loop (around line 551 after the edit) and the existing one in the GoLogin loop (around line 582).

- [ ] **Step 5: Run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120.

- [ ] **Step 6: Commit P3**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/campaign.js
git commit -m "$(cat <<'EOF'
fix(2.8.24): P3 — local-browser login wait honors campaign._abort

The local-browser login wait loop at campaign.js:549-559 didn't
check campaign._abort, so when the operator clicked Stop during
this 120s wait, the loop ran the full 120s before honoring the
stop.

Fix: add `if (campaign._abort) break;` at the top of the loop body,
mirroring the existing pattern in the GoLogin branch at line 582.
Single-line additive change. If _abort is never set, behavior is
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task FINAL: Version bump + verification

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1: Bump version 2.8.23 → 2.8.24**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```
  "version": "2.8.23",
```
Replace with:
```
  "version": "2.8.24",
```

- [ ] **Step 2: Confirm no other 2.8.23 references in source**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.23" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero source-code matches. CLAUDE.md history line ("2.8.23 — distribution (lens E)") is INTENTIONAL — leave alone.

- [ ] **Step 3: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count = 120.

- [ ] **Step 4: Smoke test**

```bash
curl -s http://localhost:3000/api/health
```

Expected: JSON with `"ok":true`. version field will still report 2.8.23 until server restart — that's fine.

- [ ] **Step 5: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
chore(2.8.24): bump version after campaign hotfix (P1-P3)

Hotfix from 2026-04-27 code review:
- P1: boot scrubber for stale _in_progress markers (fixes both
      CRITICAL silent-lead-loss bugs in one place)
- P2: LEAD_TIMEOUT_MS 90s -> 180s (false-positive timeouts on
      slow GoLogin hosts)
- P3: local-browser login wait honors campaign._abort (Stop
      responsiveness)

All three patches additive. All in src/campaign.js. No touches
to src/linkedin/* or any other off-limits files. No control-flow
changes in WEEKLY_LIMIT / INMAIL_NO_CREDITS / catch-block branches
(boot scrubber covers them).

All MEDIUM/LOW review findings (consecutiveSkips conflation,
processedToday tautology, parked-profile RAM at high BPH, etc.)
explicitly deferred for a separate brainstorm.

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
- 4 commits on this branch ahead of main (P1, P2, P3, FINAL)
- `git status --short` clean

---

## Notes for the executor

- **Each task is one subagent dispatch.** Tasks are small enough that a single dispatch handles each one without sub-step grouping.
- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`, ALL of `public/`, `tests/`, `server.js`, `electron/`. This hotfix touches ONLY `src/campaign.js` + `package.json`. If a task seems to require touching anything else, STOP and report.
- **No new tests in this hotfix.** The fixes are additive and verifiable by inspection.
- **The local-browser fix in P3 is a single-line addition** that mirrors the existing GoLogin pattern. The diff is precisely 1 line.
- **Verify line numbers before editing.** The plan quotes line numbers from the 2.8.23 codebase; if they've drifted, find the equivalent anchor and use that.
