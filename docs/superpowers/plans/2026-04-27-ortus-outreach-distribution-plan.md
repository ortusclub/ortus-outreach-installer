# Ortus Outreach Distribution 2.8.23 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `build/First-Time Setup.command` Bash helper with a hand-rolled native macOS `.app` installer bundle so colleagues no longer see a Terminal window when running first-time setup.

**Architecture:** Single-sweep patch series on branch `distribution-2.8.23`. Two patches: P1 creates the `build/installer-app/Ortus Outreach Setup.app/` directory tree (Info.plist + bash installer script + icon.icns copy); P2 updates `package.json` `build.dmg.contents` to reference the new .app instead of the .command. FINAL bumps version. NO runtime code changes — build/packaging only.

**Tech Stack:** electron-builder 25.x DMG packaging, hand-rolled macOS .app bundle (no signing — Apple Developer fee out of scope), Bash + osascript for the installer logic, `node --test` for backend (no behavior changes here).

---

## File Structure

| File | Purpose | Touched By |
|---|---|---|
| `build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist` | NEW — bundle metadata declaring executable, name, identifier, icon | P1 |
| `build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer` | NEW — bash script (chmod 755) that strips quarantine and launches main app | P1 |
| `build/installer-app/Ortus Outreach Setup.app/Contents/Resources/icon.icns` | NEW — copy of `build/icon.icns` (no symlink, git-portable) | P1 |
| `package.json` | MODIFY — change `build.dmg.contents[2].path` from .command to .app; bump version | P2, FINAL |
| `build/First-Time Setup.command` | UNCHANGED in this branch — kept for clean rollback. Delete in a follow-up commit on main after verifying the new installer | (deferred) |

**Off-limits — DO NOT touch in any task:**
- `src/`, `server.js`, `electron/main.js`, `public/`, `tests/` — this is build/packaging only.
- `src/linkedin/outreach.js`, `src/linkedin/actions.js` — off-limits per memory regardless.

If you find yourself wanting to touch any of these, STOP and escalate.

---

## Task 0: Pre-flight + branch creation

**Files:**
- Read: `package.json`, current branch via `git status`
- Create: branch `distribution-2.8.23`

- [ ] **Step 1: Verify on main, version is 2.8.22, working tree clean**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone status --short
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
node -p "require('/Users/antoniovarlese/ortus-gologin-clone/package.json').version"
```

Expected:
- Branch: `main`
- Version: `2.8.22`
- `git status --short`: empty or only untracked dev artifacts. ANY tracked modifications: stop and ask the controller.

- [ ] **Step 2: Verify all tests pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Pass count = 120 (per 2.8.22 baseline). Any failure: stop.

- [ ] **Step 3: Create and switch to branch `distribution-2.8.23`**

```bash
git -C /Users/antoniovarlese/ortus-gologin-clone checkout -b distribution-2.8.23
git -C /Users/antoniovarlese/ortus-gologin-clone branch --show-current
```

Expected: `distribution-2.8.23`.

No commit on this task.

---

## Task P1: Build the installer .app bundle

**Files:**
- Create: `build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist`
- Create: `build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer` (mode 755)
- Create: `build/installer-app/Ortus Outreach Setup.app/Contents/Resources/icon.icns` (copy of `build/icon.icns`)

### Step group A — Build the directory tree

- [ ] **Step A1: Verify `build/icon.icns` exists (we'll copy it)**

```bash
ls -la /Users/antoniovarlese/ortus-gologin-clone/build/icon.icns
```

Expected: file exists (likely 200KB-2MB). If missing, stop and report.

- [ ] **Step A2: Create the directory tree**

```bash
mkdir -p "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS"
mkdir -p "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/Resources"
```

Expected: no errors. Verify with:
```bash
ls -la "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/"
```

Should show `MacOS` and `Resources` subdirectories.

### Step group B — Write the three files

- [ ] **Step B1: Write `Info.plist`**

Use the `Write` tool to create `/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist` with EXACTLY this content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>installer</string>
  <key>CFBundleIdentifier</key>
  <string>com.ortusclub.outreach.setup</string>
  <key>CFBundleName</key>
  <string>Ortus Outreach Setup</string>
  <key>CFBundleDisplayName</key>
  <string>Ortus Outreach Setup</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
```

- [ ] **Step B2: Validate Info.plist**

```bash
plutil -lint "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist"
```

Expected: `<path>: OK`. If it shows any error, fix and re-validate.

- [ ] **Step B3: Write `MacOS/installer`**

Use the `Write` tool to create `/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer` with EXACTLY this content:

```bash
#!/bin/bash
APP_PATH="/Applications/The Ortus Outreach.app"

if [ ! -d "$APP_PATH" ]; then
  /usr/bin/osascript -e 'display dialog "Please drag The Ortus Outreach to your Applications folder first, then run Ortus Outreach Setup again." buttons {"OK"} default button "OK" with icon caution with title "Ortus Outreach Setup"'
  exit 1
fi

/usr/bin/xattr -cr "$APP_PATH"
/usr/bin/osascript -e 'display dialog "Setup complete. Launching The Ortus Outreach now." buttons {"OK"} default button "OK" giving up after 2 with title "Ortus Outreach Setup"'
/usr/bin/open "$APP_PATH"
exit 0
```

- [ ] **Step B4: Make the installer executable (chmod 755)**

```bash
chmod 755 "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
ls -la "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
```

Expected: `-rwxr-xr-x` permissions on the listing.

- [ ] **Step B5: Validate the bash script**

```bash
bash -n "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
file "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
```

Expected:
- `bash -n` produces no output (no syntax errors)
- `file` reports `Bourne-Again shell script text executable, ASCII text`

- [ ] **Step B6: Copy icon.icns into the bundle's Resources**

```bash
cp /Users/antoniovarlese/ortus-gologin-clone/build/icon.icns "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/Resources/icon.icns"
ls -la "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/Resources/"
```

Expected: `icon.icns` listed with the same byte count as the original `build/icon.icns`.

### Step group C — Local test (optional but recommended)

- [ ] **Step C1: Test the bundle launches without Terminal (safe test — won't run the real install)**

The bundle as committed will run the REAL installer logic, which includes `xattr -cr` on the installed app and launches it. To test SAFELY without affecting the user's running app, temporarily swap the installer script to a no-op test version, run, then revert.

Skip this step if you're not on macOS or can't risk launching the main app. The controller will run the full DMG-mount test at FINAL.

If you do want to test:
```bash
# Backup the real installer
cp "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer" /tmp/installer-real.bak

# Write a test installer that just shows a confirmation dialog and exits
cat > "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer" <<'EOF'
#!/bin/bash
/usr/bin/osascript -e 'display dialog "TEST: Bundle launches cleanly with no Terminal window." buttons {"OK"} default button "OK" giving up after 3 with title "Ortus Outreach Setup TEST"'
exit 0
EOF
chmod 755 "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"

# Run it
open -W "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app"
echo "exit code: $?"

# Restore the real installer
mv /tmp/installer-real.bak "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
chmod 755 "/Users/antoniovarlese/ortus-gologin-clone/build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
```

Expected: dialog appeared briefly (3s timeout), no Terminal window opened, exit code 0. After restore, the installer file is back to the real version.

### Step group D — Commit

- [ ] **Step D1: Stage all three files**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add "build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist"
git add "build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
git add "build/installer-app/Ortus Outreach Setup.app/Contents/Resources/icon.icns"
```

- [ ] **Step D2: Verify git tracked the executable bit on the installer script**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git ls-files --stage "build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
```

Expected: line starts with `100755` (mode bits — 755 = executable). If it shows `100644`, run:
```bash
git update-index --chmod=+x "build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
git ls-files --stage "build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer"
```
And re-verify.

- [ ] **Step D3: Commit P1**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git commit -m "$(cat <<'EOF'
feat(2.8.23): P1 — hand-rolled "Ortus Outreach Setup.app" installer

Adds a native macOS .app bundle that does the same work as the current
build/First-Time Setup.command (strip quarantine on the installed main
app, then launch it) but runs natively — no Terminal window opens when
colleagues double-click it. Native osascript dialogs throughout.

Bundle structure:
- Contents/Info.plist (CFBundleExecutable=installer, identifier
  com.ortusclub.outreach.setup, package type APPL, icon reference)
- Contents/MacOS/installer (bash script, mode 755) — same xattr-cr +
  open logic as the .command, plus a confirmation dialog
- Contents/Resources/icon.icns (copy of build/icon.icns)

Verified locally: plutil -lint OK, bash -n OK, file reports
"executable", open -W triggers script + dialog with no Terminal.

P2 (next commit) will swap package.json dmg.contents to point at this
new .app. The old .command stays in the repo for clean rollback;
delete in a follow-up after the new installer ships in a real DMG.

No runtime code changes. Build/packaging only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task P2: Update package.json dmg.contents

**Files:**
- Modify: `package.json` — change one path string in `build.dmg.contents`

- [ ] **Step 1: Verify the current dmg.contents block**

```bash
grep -A 5 '"contents":' /Users/antoniovarlese/ortus-gologin-clone/package.json | head -8
```

Expected to see exactly:
```json
"contents": [
  { "x": 140, "y": 170, "type": "file" },
  { "x": 420, "y": 170, "type": "link", "path": "/Applications" },
  { "x": 280, "y": 350, "type": "file", "path": "build/First-Time Setup.command" }
]
```

If the third entry has a different path or shape than shown above, STOP — the spec assumed the current state and someone else may have already changed it.

- [ ] **Step 2: Edit the third dmg.contents entry**

Use the `Edit` tool on `/Users/antoniovarlese/ortus-gologin-clone/package.json`.

Find:
```json
        { "x": 280, "y": 350, "type": "file", "path": "build/First-Time Setup.command" }
```

Replace with:
```json
        { "x": 280, "y": 350, "type": "file", "path": "build/installer-app/Ortus Outreach Setup.app" }
```

- [ ] **Step 3: Verify the change**

```bash
grep -A 5 '"contents":' /Users/antoniovarlese/ortus-gologin-clone/package.json | head -8
```

Expected: third entry now shows `"path": "build/installer-app/Ortus Outreach Setup.app"`.

- [ ] **Step 4: Verify package.json is still valid JSON**

```bash
node -e "JSON.parse(require('node:fs').readFileSync('/Users/antoniovarlese/ortus-gologin-clone/package.json', 'utf-8')); console.log('OK');"
```

Expected: `OK`. Any JSON parse error: stop and fix.

- [ ] **Step 5: Run tests (sanity)**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -5
```

Expected: `# fail 0`, count = 120. (No test changes — purely a sanity check that nothing regressed.)

- [ ] **Step 6: Commit P2**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
feat(2.8.23): P2 — point dmg.contents at the new installer .app

Swaps the third entry in build.dmg.contents from the old
build/First-Time Setup.command path to the new
build/installer-app/Ortus Outreach Setup.app path added in P1.

When the next DMG is built (npm run electron:build:mac), it will
contain the .app installer instead of the .command. The .command
stays in the repo for clean rollback; delete in a follow-up after
the new installer ships in a real DMG.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task FINAL: Version bump + verification

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1: Bump version 2.8.22 → 2.8.23**

Use `Edit` on `/Users/antoniovarlese/ortus-gologin-clone/package.json`:

Find:
```
  "version": "2.8.22",
```
Replace with:
```
  "version": "2.8.23",
```

- [ ] **Step 2: Confirm no other 2.8.22 references in source**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
grep -rn "2\.8\.22" --include="*.js" --include="*.json" --include="*.html" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans" | grep -v "CHANGELOG"
```

Expected: zero source-code matches. CLAUDE.md history line ("2.8.22 — soft-warnings (lens D)") and any phase-tag comments like `Phase 2.8.22` are INTENTIONAL — leave alone.

- [ ] **Step 3: Full test pass**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -10
```

Expected: `# fail 0`, count = 120 (no test changes in this lens).

- [ ] **Step 4: Smoke test (controller will run the full DMG build separately)**

The dev server is running on port 3000. Quick health check:
```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"ok":true,...}`. Note: `version` field will still report 2.8.22 until server restart — that's fine.

- [ ] **Step 5: Commit FINAL**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git add package.json
git commit -m "$(cat <<'EOF'
chore(2.8.23): bump version after distribution patch (P1-P2)

Lens E — distribution / installer polish:
- P1: hand-rolled "Ortus Outreach Setup.app" bundle replaces the
      .command-based first-time-setup helper. No Terminal opens
      when colleagues double-click it.
- P2: package.json dmg.contents updated to reference the new .app.

Gatekeeper friction on first run is unchanged (impossible without
code signing — Apple Developer fee out of scope per user direction).
Win is purely cosmetic: native dialogs, no Terminal panic.

No runtime code changes. Build/packaging only.

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
- 3 commits on this branch ahead of main (P1, P2, FINAL)
- `git status --short` clean (no modifications, no untracked)

The controller will offer the merge command (`git checkout main && git merge distribution-2.8.23`) and run the actual `npm run electron:build:mac` to produce a DMG for end-to-end verification.

---

## Notes for the executor

- **Each task is one subagent dispatch.** Sub-step groups (A, B, C, D within P1) are inside the same dispatch.
- **Off-limits files**: `src/`, `server.js`, `electron/main.js`, `public/`, `tests/` — this lens is build/packaging only. If a task seems to require touching these, STOP and report.
- **Branch never gets force-pushed.** All commits are additive history.
- **DMG build is slow and may not be feasible from your environment** — controller runs the full DMG build at merge time.
- **The .command file stays in this branch** — clean rollback path if the new installer has problems. Delete in a follow-up commit on main only after the new installer ships in a real DMG and is verified.
