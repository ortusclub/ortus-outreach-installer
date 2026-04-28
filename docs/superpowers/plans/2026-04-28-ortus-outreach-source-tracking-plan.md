# Ortus Outreach Source-Tracking 2.8.26 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 12 untracked source files to git so a fresh clone or different machine can start the app and build a DMG with an icon.

**Architecture:** Pure `git add` hotfix. No file content modifications. Secret-scan gate before staging to prevent accidental credential leak. Two patches (P1 commits the files, FINAL bumps version).

**Tech Stack:** Just git. No code, no tests, no behavior changes.

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `src/auth.js` | local auth (bcryptjs); imported by server.js | P1 (added) |
| `src/notifier.js` | email notifications; imported by server.js | P1 (added) |
| `src/paths.js` | path helpers | P1 (added) |
| `src/soo.js` | share-of-outreach data | P1 (added) |
| `electron/preload.js` | Electron IPC bridge | P1 (added) |
| `electron/after-pack.cjs` | electron-builder afterPack hook | P1 (added) |
| `public/login.html` | login page | P1 (added) |
| `public/signup.html` | signup page | P1 (added) |
| `public/electron-login.html` | Electron-specific login flow | P1 (added) |
| `build/icon.icns` | macOS app icon | P1 (added) |
| `build/icon.png` | Windows / fallback app icon | P1 (added) |
| `build/icon-256.png` | small variant | P1 (added) |
| `package.json` | version field | FINAL (bump) |

**Off-limits — DO NOT touch in any task:**
- `src/linkedin/outreach.js`, `src/linkedin/actions.js` (off-limits per memory)
- ALL OTHER untracked items: `vapi-calling/`, `api/`, `vercel.json`, `public/preset-sketches*.html`, `public/sketches/*`, `CLOUD-EXECUTION-PROPOSAL.md`, `DESIGN.md`, `UI.md`, `meeting-prep-marketing-innovations.md`, `.playwright-mcp/`, `dist/`, `data/*` runtime files
- `.gitignore` (deferred for future patch)
- DO NOT use `git add -A` or `git add .` — stage by exact pathspec only

---

## Task 0: Pre-flight + branch creation

- [ ] **Step 1: Verify on main, version is 2.8.25, working tree state**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short | head -3
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected: branch `main`, version `2.8.25`. `git status --short` will show many `??` (untracked) entries — that's expected and is the problem this hotfix addresses. The 12 target files should be among them; verify with:

```bash
git status --porcelain | grep -E "^\?\? (src/(auth|notifier|paths|soo)\.js|electron/(preload\.js|after-pack\.cjs)|public/(login|signup|electron-login)\.html|build/icon(-256)?\.(icns|png))$" | wc -l
```

Expected: `12` (all 12 target files present and untracked).

If fewer than 12, STOP — investigate which files are missing or already tracked.

- [ ] **Step 2: Verify all tests pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count 120.

- [ ] **Step 3: Create and switch to branch `source-tracking-2.8.26`**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b source-tracking-2.8.26
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `source-tracking-2.8.26`. No commit on this task.

---

## Task P1: Secret-scan + commit the 12 files

- [ ] **Step 1: Secret-scan each file before staging anything**

Run this exact command:

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
for f in src/auth.js src/notifier.js src/paths.js src/soo.js electron/preload.js electron/after-pack.cjs public/login.html public/signup.html public/electron-login.html; do
  echo "=== $f ==="
  grep -nE "password\s*[:=]|secret\s*[:=]|token\s*[:=]|apikey\s*[:=]|api_key\s*[:=]|smtp_pass|admin_pass|bearer\s+[A-Za-z0-9]" "$f" 2>/dev/null | grep -vE "process\.env\.|//|/\*" | head -10
done
```

Expected: each `=== filename ===` header followed by NO grep output (zero hits). The grep filters out `process.env.X` references and comments — only flags hardcoded patterns.

If ANY file shows a hit, STOP. Report the file + line + matched text to the controller. Do NOT proceed to staging.

The 3 binary icon files (`build/icon.icns`, `build/icon.png`, `build/icon-256.png`) are binary — text grep doesn't apply. They cannot contain plaintext secrets and don't need scanning.

- [ ] **Step 2: Stage the 12 files by exact pathspec**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add src/auth.js src/notifier.js src/paths.js src/soo.js
git add electron/preload.js electron/after-pack.cjs
git add public/login.html public/signup.html public/electron-login.html
git add build/icon.icns build/icon.png build/icon-256.png
```

DO NOT use `git add -A`, `git add .`, or `git add src/`. Stage by exact pathspec only.

- [ ] **Step 3: Verify exactly 12 files are staged**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git status --short | grep -E "^A " | wc -l
git status --short | grep -E "^A " | head -15
```

Expected: count is `12`. The list shows all 12 paths, no others.

If count is not 12, STOP. Either staging missed something or pulled in more than intended.

- [ ] **Step 4: Run tests to confirm no regression**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count 120 (unchanged — no behavior change, files were already on disk).

- [ ] **Step 5: Commit P1**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git commit -m "$(cat <<'EOF'
fix(repo): track 12 untracked source files

These files are imported / referenced by tracked code but were never
added to the repo:
- src/auth.js — local auth (bcryptjs); imported by server.js
- src/notifier.js — email notifications; imported by server.js
- src/paths.js — path helpers; imported by server.js + others
- src/soo.js — share-of-outreach data; imported by server.js
- electron/preload.js — Electron IPC bridge
- electron/after-pack.cjs — electron-builder afterPack hook
- public/login.html, signup.html, electron-login.html — auth pages
- build/icon.icns, icon.png, icon-256.png — app icons referenced
  by package.json build config

Without these in git, a fresh clone would fail to start (missing
imports) or build a DMG without an icon. The dev server and DMG
build have only been working because the files happen to exist
locally on the maintainer's machine.

No file content modified — pure git add + commit. Each file
secret-scanned before staging (zero hits; codebase reads all
secrets from .env).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Verify all 12 are now tracked**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git ls-files | grep -E "^(src/(auth|notifier|paths|soo)\.js|electron/(preload\.js|after-pack\.cjs)|public/(login|signup|electron-login)\.html|build/icon(-256)?\.(icns|png))$" | wc -l
```

Expected: `12`.

---

## Task FINAL: Version bump 2.8.25 → 2.8.26

- [ ] **Step 1: Bump version**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```
  "version": "2.8.25",
```
Replace with:
```
  "version": "2.8.26",
```

- [ ] **Step 2: Confirm no other 2.8.25 references in source**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.25" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero source-code matches. CLAUDE.md history line and any "2.8.25-P1" / "2.8.25-P2" / "Concurrency cap (2.8.25)" comments are intentional and stay.

- [ ] **Step 3: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count 120.

- [ ] **Step 4: Smoke test the dev server**

```bash
curl -s http://localhost:3000/api/health
```

Expected: JSON with `"ok":true`. (`version` field will still report 2.8.25 until restart — fine.)

- [ ] **Step 5: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
chore(2.8.26): bump version after source-tracking hotfix (P1)

Lens H — repo hygiene: add 12 untracked source files to git so a
fresh clone or different machine can start the app and build a DMG.

P1 (148e189-style additive): secret-scanned and committed
src/auth.js, src/notifier.js, src/paths.js, src/soo.js,
electron/preload.js, electron/after-pack.cjs, public/login.html,
public/signup.html, public/electron-login.html, build/icon.icns,
build/icon.png, build/icon-256.png.

No file content modified. No behavior change. .gitignore expansion,
vapi-calling/ relocation, Vercel files, sketch HTMLs, and project-
notes markdown files all explicitly deferred for future patches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm branch state ready for merge**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git log --oneline main..HEAD
git status --short | grep -E "^[AM]" || echo "no staged or modified files"
```

Expected:
- 2 commits on this branch ahead of main (P1, FINAL)
- No staged or modified files (the many `??` untracked items remain — those are explicitly deferred)

---

## Notes for the executor

- **Each task is one subagent dispatch.**
- **Pure additive operation.** No file content modified anywhere.
- **DO NOT use `git add -A`** under any circumstances. Stage by exact pathspec only.
- **Off-limits paths**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`, AND every untracked path NOT in the 12-file list. The remaining ~70 untracked items stay untracked.
- **Branch never gets force-pushed.** All commits are additive history.
