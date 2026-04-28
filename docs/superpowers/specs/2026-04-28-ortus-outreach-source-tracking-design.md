# Ortus Outreach — Source File Tracking Hotfix

**Date:** 2026-04-28
**Lens:** H (repo hygiene) — single-purpose hotfix to add 12 untracked source files to git
**Approach:** Two patches in one branch
**Target version:** 2.8.26
**Memory anchors:** verify-before-asserting (no guessing — secret-scan each file before committing); be careful with working code (no modifications to file contents, only `git add`).

## Background

During Task 0 of the concurrency-cap 2.8.25 work, `git status` revealed several real source files as **untracked**. The dev server and DMG builds only work because the files happen to exist locally. A fresh clone or a different machine would fail to start the app.

This hotfix adds the 12 critical untracked files to git. No file content is modified — pure `git add` + commit.

## Scope

Two patches in one branch (`source-tracking-2.8.26`).

| Patch | Theme | Risk |
|---|---|---|
| **P1** | Secret-scan + `git add` + commit the 12 files | Low (pure additive — no modification to file content) |
| **FINAL** | Bump version 2.8.25 → 2.8.26 | Zero (single-line constant edit) |

**The 12 files:**

```
src/auth.js
src/notifier.js
src/paths.js
src/soo.js
electron/preload.js
electron/after-pack.cjs
public/login.html
public/signup.html
public/electron-login.html
build/icon.icns
build/icon.png
build/icon-256.png
```

**Verification cadence:** Single end-of-branch verification — `npm test` + `git ls-files` confirms all 12 are now tracked.

**Out of scope (explicitly deferred):**
- `.gitignore` expansion (cover `.DS_Store`, `.playwright-mcp/`, `dist/`, runtime data files) — the user picked minimal scope
- Moving `vapi-calling/` to a sibling folder (similar to ElevenLabs from lens C) — deferred
- Tracking `api/index.js` + `vercel.json` (Vercel deployment files) — deferred
- Tracking `public/preset-sketches*.html` and other sketch HTMLs — deferred (not referenced by index.html, dev-only)
- Tracking `CLOUD-EXECUTION-PROPOSAL.md`, `DESIGN.md`, `UI.md`, `meeting-prep-marketing-innovations.md` — project notes, deferred
- Any modification to file content (this hotfix is pure `git add`)
- Any change to `src/linkedin/*` (off-limits anyway)

## P1 — Secret-scan + commit the 12 files

**Problem:** As described above. Six JS files (`src/auth.js`, `src/notifier.js`, `src/paths.js`, `src/soo.js`, `electron/preload.js`, `electron/after-pack.cjs`) are imported / referenced by tracked code. Three HTML files (`public/login.html`, `public/signup.html`, `public/electron-login.html`) are served by tracked routes. Three icon files (`build/icon.icns`, `build/icon.png`, `build/icon-256.png`) are referenced by `package.json` build config.

**Change:**

Three steps, in order:

**Step 1 — Secret scan.** Before staging anything, scan each file for obvious secret patterns. Grep each of the 6 JS files (icons + HTML are unlikely to have secrets but scan them too for completeness):

```bash
for f in src/auth.js src/notifier.js src/paths.js src/soo.js electron/preload.js electron/after-pack.cjs public/login.html public/signup.html public/electron-login.html; do
  echo "=== $f ==="
  grep -nE "password\s*[:=]|secret\s*[:=]|token\s*[:=]|apikey\s*[:=]|api_key\s*[:=]|smtp_pass|admin_pass|bearer\s+[A-Za-z0-9]" "$f" 2>/dev/null | grep -vE "process\.env\.|//|/\*" | head -10
done
```

The grep filters out `process.env.X` references (those are reading from env, not hardcoding). If ANY line in ANY file is a hardcoded credential, STOP — do not commit. Surface the finding to the user.

Expected: zero hits. The codebase pattern is to read all secrets from `.env` (verified: `process.env.DASHBOARD_PASS`, `process.env.GOLOGIN_API_TOKEN`, etc. throughout).

**Step 2 — Stage and verify.**

```bash
git add src/auth.js src/notifier.js src/paths.js src/soo.js
git add electron/preload.js electron/after-pack.cjs
git add public/login.html public/signup.html public/electron-login.html
git add build/icon.icns build/icon.png build/icon-256.png
git status --short | grep -E "^A "
```

Expected: 12 lines starting with `A` (added). Counted to confirm.

**Step 3 — Commit.**

```bash
git commit -m "fix(repo): track 12 untracked source files

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
secret-scanned before staging (zero hits expected; codebase
reads all secrets from .env)."
```

**Acceptance:**
- All 12 files appear in `git ls-files` after commit
- `git status --short` no longer shows them
- `npm test` passes (no behavior change — files were already on disk and being used)
- Dev server boots cleanly (no behavior change)

**Risk:** Low. Pure additive `git add`. Worst case: a file contains a secret — secret-scan gate catches this before commit. Mitigation: if the scan hits, STOP and report to the user, don't commit.

## FINAL — Version bump

**Change:** `package.json` version 2.8.25 → 2.8.26.

**Rationale:** Maintains the per-lens version-bump pattern. No behavior change; this is a packaging hotfix. Consumers (the user installing on their Mac) won't see a difference at runtime, but the version line is the canonical "this commit shipped" marker.

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| P1 | Low | A file contains a hardcoded secret | Secret-scan gate before commit; if hit, stop and surface to user |
| FINAL | Zero | None | — |

## Branch & version shape

- Branch: `source-tracking-2.8.26` cut from `main` (currently at `9af7bf4` after the 2.8.25 merge)
- Patches commit in order P1 → FINAL
- Verification: `npm test` (existing 120 tests must still pass) + `git ls-files` confirms all 12 files
- Merge to main as fast-forward

## Files touched (summary)

| File | P1 | FINAL |
|---|---|---|
| 12 untracked source files | NEW (added to git) | |
| `package.json` | | bump version to 2.8.26 |

## Notes for the implementer

- **DO NOT modify the content of any of the 12 files.** This hotfix is pure `git add`.
- **DO NOT use `git add -A` or `git add .`** — there are ~80 untracked items in the working tree, most of which are NOT in scope. Stage by exact pathspec only.
- **DO run the secret-scan first.** If any file has a hardcoded credential (not a `process.env.X` read), STOP and surface it. Do not commit.
- **DO NOT touch `.gitignore`** — `.gitignore` cleanup is explicitly deferred.
- **DO NOT touch `vapi-calling/`, `api/`, `vercel.json`, or any other untracked items** — explicitly deferred.
- **Off-limits** (these aren't even in the 12, but for clarity): `src/linkedin/outreach.js`, `src/linkedin/actions.js` are off-limits as always.
