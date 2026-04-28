# Ortus Outreach — Distribution / Installer Polish

**Date:** 2026-04-27
**Lens:** E (Distribution / install flow for non-technical colleagues)
**Approach:** Single-sweep, two patches in one branch, one ship
**Target version:** 2.8.23
**Memory anchors:** colleagues run on slow/overloaded machines; never modify core campaign logic; user has been burned by changes there; verify-before-asserting (no guessing); GoLogin token is hardcoded into the app (bundled `.env`) — never ask the operator for it; user does not want to pay the Apple Developer fee, so code signing / notarization is off the table for this lens.

## Scope

Replace the `build/First-Time Setup.command` Bash helper with a hand-rolled native `.app` installer bundle. When colleagues double-click the installer, no Terminal window opens — they see a native macOS dialog instead. The install flow itself (drag main app to /Applications, then run installer) is unchanged in step count.

Two patches in one branch (`distribution-2.8.23`), shipped as a single version bump.

| Patch | Theme | Risk |
|---|---|---|
| **P1** | Build the installer `.app` bundle | Low (additive — new directory tree under `build/`) |
| **P2** | Update `package.json` `dmg.contents` to reference the `.app` instead of the `.command` | Low (one-line config change in already-stable build config) |

**Verification cadence:** Single end-of-branch verification — build the DMG locally (`npm run electron:build:mac`), mount it, double-click the installer .app, confirm: (a) no Terminal opens, (b) the strip-quarantine + launch flow works, (c) the dialogs render natively.

## What this lens does NOT do

- **Code signing / notarization** — out of scope per user direction; the Apple Developer fee is not on the table.
- **Eliminate Gatekeeper friction on first run** — impossible without signing. Colleagues still need to right-click → Open the installer the first time (one click). The new dialog is friendlier ("from an unidentified developer / Open / Cancel") than the .command flow's Terminal-flavored variant, but the click is the same.
- **In-app onboarding screen** — the GoLogin token is bundled in `.env` and ships with the DMG by intent; operators are never asked for it.
- **Auto-update / electron-updater** — separate concern, not in this lens.
- **Per-user config separation** — token stays bundled per user direction.
- **Changes to runtime code** — `src/`, `server.js`, `electron/main.js`, `public/` are NOT touched. This is a build/packaging change only.

## P1 — Build the installer .app bundle

**Problem:** The current `build/First-Time Setup.command` is a Bash script. When colleagues double-click it, macOS opens Terminal.app to run it — colleagues see a black/white window with text and panic, thinking they need to type something. The script doesn't actually take input; it just runs `xattr -cr` and `open` and exits. But the visible Terminal is the friction.

**Change:**

Create a hand-rolled `.app` bundle directory tree under `build/installer-app/`. The bundle does the same work as the current `.command` but as a native macOS app — no Terminal opens, all dialogs are native osascript dialogs.

Final structure (committed to repo):

```
build/installer-app/
  Ortus Outreach Setup.app/
    Contents/
      Info.plist
      MacOS/
        installer       (bash script, 755)
      Resources/
        icon.icns       (copy of build/icon.icns)
```

**`Info.plist`** — XML property list. Required keys verified against `/System/Applications/Calculator.app/Contents/Info.plist`. Validated with `plutil -lint`:

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

Note: `LSUIElement` is intentionally omitted. A brief dock-icon flash during the 1-2s installer run is preferable to risking the osascript dialog losing focus when the bundle is marked as a UI-less helper.

**`Contents/MacOS/installer`** — Bash script equivalent to the current `.command`, but with a confirmation dialog before the launch:

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

The `giving up after 2` clause auto-dismisses the success dialog after 2 seconds so colleagues don't have to click anything.

**`Contents/Resources/icon.icns`** — A copy of `build/icon.icns`. Committed as a binary file (no symlink — git symlinks behave inconsistently across platforms).

**Permissions:**
- `Contents/MacOS/installer` must be 755 (executable). Git tracks the executable bit; commit with the bit set (`git update-index --chmod=+x` if needed).
- All other files are normal 644.

**Verification (during P1):**
- `plutil -lint <path>/Info.plist` → `OK`
- `bash -n <path>/MacOS/installer` → no syntax errors
- `file <path>/MacOS/installer` → `Bourne-Again shell script text executable` (note `executable`)
- `open -W "<repo>/build/installer-app/Ortus Outreach Setup.app"` → no Terminal opens; the dialog appears (because `/Applications/The Ortus Outreach.app` may or may not exist on the implementer's machine, EITHER dialog branch is acceptable for this verification — what matters is no Terminal)

## P2 — Update DMG layout in package.json

**Problem:** `package.json` currently references the `.command` file as the third entry in `build.dmg.contents`. We need to point it at the new `.app` bundle instead.

**Change:**

Edit `package.json`. In the `build.dmg` block, change the third `contents` entry:

Find:
```json
"contents": [
  { "x": 140, "y": 170, "type": "file" },
  { "x": 420, "y": 170, "type": "link", "path": "/Applications" },
  { "x": 280, "y": 350, "type": "file", "path": "build/First-Time Setup.command" }
]
```

Replace with:
```json
"contents": [
  { "x": 140, "y": 170, "type": "file" },
  { "x": 420, "y": 170, "type": "link", "path": "/Applications" },
  { "x": 280, "y": 350, "type": "file", "path": "build/installer-app/Ortus Outreach Setup.app" }
]
```

Window size (`560×480`) and icon size (`110`) stay the same — they already work for three icons in the layout.

**After P2 verifies** (post-merge): delete `build/First-Time Setup.command` from the repo. Done in a follow-up commit, not in this branch — keeps the rollback simple if the new installer has problems.

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| P1 | Low | Bash script in bundle has wrong permissions after electron-builder packaging | Verification step inspects the built DMG: mount → `ls -la` the executable → confirm `-rwxr-xr-x` |
| P2 | Low | electron-builder rejects the .app path (e.g. requires a glob or different syntax) | Fall back to current .command, file an issue, ship without P2 if needed |
| Both | Medium | DMG built fine on Antonio's machine but breaks on a clean colleague Mac | Antonio runs through the install on his own machine using a fresh `~/Downloads` copy of the DMG before merging; if any step fails, revert |

## Branch & version shape

- Branch: `distribution-2.8.23` cut from `main` (currently at `4175249` after the 2.8.22 merge)
- Patches commit in order P1 → P2
- FINAL commit bumps `package.json` version 2.8.22 → 2.8.23
- Verification: `npm test` (no behavior changes, just sanity) + `npm run electron:build:mac` + manual DMG mount + double-click the installer .app on Antonio's machine
- Merge to main as fast-forward (matches 2.8.19 / 2.8.20 / 2.8.21 / 2.8.22 pattern)

## Files touched (summary)

| File | P1 | P2 | FINAL |
|---|---|---|---|
| `build/installer-app/Ortus Outreach Setup.app/Contents/Info.plist` | NEW | | |
| `build/installer-app/Ortus Outreach Setup.app/Contents/MacOS/installer` | NEW (755) | | |
| `build/installer-app/Ortus Outreach Setup.app/Contents/Resources/icon.icns` | NEW (copy of build/icon.icns) | | |
| `package.json` | | edit `dmg.contents[2].path` | bump version to 2.8.23 |

## Notes for the implementer

- **No runtime code changes.** `src/`, `server.js`, `electron/main.js`, `public/` are off-limits for this lens. If you find yourself wanting to touch them, STOP — wrong scope.
- **Don't delete `build/First-Time Setup.command` in this branch.** Keeps rollback clean. A follow-up commit on main can delete it once the new installer is verified.
- **Test the .app bundle locally before committing**: `plutil -lint Info.plist` + `bash -n installer` + `open -W` (to confirm no Terminal opens). If `open -W` shows the wrong dialog (e.g. drag-to-Applications when the app IS installed), that's a bug — fix before commit.
- **DMG build is slow** (a few minutes) and the implementer may not have time to do the full build. That's fine — controller will run the build at FINAL.
- **Hand-rolled `.app` is a directory** — make sure git tracks all three files (Info.plist, installer, icon.icns) and that the executable bit on `installer` is preserved through commits.
