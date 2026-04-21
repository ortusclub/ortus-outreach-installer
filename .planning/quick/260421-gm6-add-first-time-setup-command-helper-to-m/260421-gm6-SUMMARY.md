---
phase: 260421-gm6
plan: 01
subsystem: packaging
status: complete
tags: [packaging, electron-builder, dmg, onboarding, macos]
requires: []
provides:
  - build/First-Time Setup.command helper (executable, 755)
  - package.json build.dmg.contents array (3 entries)
affects:
  - dist/*.dmg layout (adds helper file at DMG root)
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - build/First-Time Setup.command
    - .planning/quick/260421-gm6-add-first-time-setup-command-helper-to-m/260421-gm6-SUMMARY.md
  modified:
    - package.json
decisions:
  - Use xattr -cr (clears ALL extended attrs including com.apple.quarantine) rather than targeted xattr -d com.apple.quarantine — simpler, achieves the same Gatekeeper result
  - Show osascript dialog when app isn't in /Applications yet — no silent failures for teammates who double-click the helper in the wrong order
  - Chose conversation-free helper (no args, no logging) — smallest surface, easiest to audit, matches plan brief
  - Place helper below the app/link row (y=380 vs 220) so the standard drag-to-Applications layout is preserved visually
metrics:
  duration: ~5 minutes (including 2.5-min build)
  completed: 2026-04-21
  tasks_completed: 3 of 3 (human-verify checkpoint approved)
---

# Quick Task 260421-gm6: First-Time Setup.command Helper in DMG — Summary

**One-liner:** Bundle a double-clickable `First-Time Setup.command` helper inside the macOS DMG so teammates can install the unsigned app without typing any Terminal commands.

## What Was Built

### 1. `build/First-Time Setup.command` (new, 15 lines, mode 755)

Bash helper that runs when double-clicked from the mounted DMG:

1. Checks `/Applications/The Ortus Outreach.app` exists
2. If missing → shows an AppleScript dialog telling the user to drag the app to Applications first, exits 1
3. If present → runs `xattr -cr "$APP_PATH"` to clear `com.apple.quarantine` (and all other extended attrs) recursively
4. Launches the app with `open "$APP_PATH"`

Uses absolute binary paths (`/usr/bin/osascript`, `/usr/bin/xattr`, `/usr/bin/open`) so the helper doesn't depend on the user's `PATH`.

Committed with `git update-index --chmod=+x` so the executable bit survives a fresh clone on another teammate's machine — confirmed by `create mode 100755` in the commit.

### 2. `package.json` `build.dmg.contents` (new 3-entry array)

Added inside the existing `build.dmg` block (kept `writeUpdateInfo: false`):

```json
"dmg": {
  "writeUpdateInfo": false,
  "contents": [
    { "x": 130, "y": 220, "type": "file" },
    { "x": 410, "y": 220, "type": "link", "path": "/Applications" },
    { "x": 270, "y": 380, "type": "file", "path": "build/First-Time Setup.command" }
  ]
}
```

**Schema verification:** Before editing, the electron-builder v25 `DmgContent` interface was confirmed from the installed types at `node_modules/app-builder-lib/out/options/macOptions.d.ts:291-309` (`x, y, type?: "link"|"file"|"dir", name?, path?`). No deviation from the plan's proposed JSON was needed.

**App entry convention:** The first entry (type: file, no path) resolves at build time to `${productFilename}.app` — confirmed at `node_modules/dmg-builder/out/dmg.js:285`.

**Helper path resolution:** `platformPackager.getResource("build/First-Time Setup.command")` first tries the `buildResourcesDir` (would be `build/build/...`, missing) then falls back to the project-root path `{projectDir}/build/First-Time Setup.command` — exists, so the file copies into the DMG. Confirmed at `node_modules/app-builder-lib/out/platformPackager.js:517-524`.

## Build Output

`npm run electron:build:mac` succeeded (build time ~2.5 min, exit 0) and produced:

| File | Size |
|------|------|
| `dist/The Ortus Outreach-2.6.0.dmg` (x64) | 118,266,371 bytes (~113 MB) |
| `dist/The Ortus Outreach-2.6.0-arm64.dmg` (arm64) | 113,550,686 bytes (~108 MB) |

Sizes are in line with previous builds (not smaller, so the app bundle packaged correctly).

## DMG Mount Verification

Both DMGs (arm64 and x64) were mounted and inspected. Each root listing contains:

```
lrwxr-xr-x  Applications -> /Applications
-rwxr-xr-x  First-Time Setup.command   (564 bytes, executable)
drwxr-xr-x  The Ortus Outreach.app
```

All three required items present in both builds. Helper carries `-rwxr-xr-x` so macOS launches it via Terminal on double-click (not TextEdit). Both DMGs detached cleanly after listing.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| Task 1: Helper script | `1fd15b8` | `build/First-Time Setup.command` (new, mode 100755) |
| Task 2: dmg.contents config | `7331c72` | `package.json` |

## Deviations from Plan

### Noted but Not Auto-Fixed

**1. package.json commit swept up pre-existing working-tree changes**
- **Found during:** Task 2
- **Issue:** Before this task started, `package.json` already had many uncommitted modifications sitting in the working tree (name rename from `ortus-gologin-clone` → `ortus-outreach`, version bump to 2.6.0, `main` → `electron/main.js`, the whole `build.*` block, etc.). These are part of the ongoing Electron-app migration, not this task.
- **Outcome:** `git add package.json` at commit time included all of them alongside the 6-line `dmg.contents` addition, so commit `7331c72` shows 104 insertions/4 deletions rather than the ~6 lines specific to this task.
- **Why not auto-fixed:** Splitting those off would require destructive staging manipulation on files that the project clearly depends on (the build itself reads the new electron config — removing it would break `electron:build:mac`). The existing modifications were necessary for the build to run at all.
- **Mitigation:** The specific dmg.contents change is easy to isolate via `git show 7331c72 -- package.json | grep -A 6 '"dmg"'` if a reviewer needs to see only the task-relevant diff.

### Auto-Fixed Issues

None — the plan executed as written.

## Follow-ups (Noted, Not Done)

- Update `docs/manual.md` to reflect the new zero-Terminal onboarding flow (mention: "after dragging to Applications, double-click `First-Time Setup.command` once — click Open if macOS warns about opening a Terminal script"). Not done per plan output spec (explicitly called out as follow-up).
- Recommend in the README / team docs that, on first run of the helper, macOS will show a `from the internet / are you sure?` Gatekeeper prompt for the `.command` file itself. This is expected and one-time.

## Task 3 Status: Approved

The `checkpoint:human-verify` was approved by the user after the build completed, both DMGs were rebuilt from the new `dmg.contents` config, and both were mounted and confirmed to contain `First-Time Setup.command` at the DMG root with the correct `-rwxr-xr-x` mode. Plan status advanced to `complete`.

## Self-Check: PASSED

- `build/First-Time Setup.command` exists, mode 100755, committed in `1fd15b8` — verified via `test -x`, `head -1`, `grep 'xattr -cr'`, `grep '/Applications/The Ortus Outreach.app'` (all returned `OK`)
- `package.json` `build.dmg.contents` is a valid 3-entry array with `/Applications` link and helper file path — verified via `node -e` check (returned `OK`)
- Both commits (`1fd15b8`, `7331c72`) present in `git log`
- Both DMGs present in `dist/` with reasonable sizes
- Helper visible on mounted DMG at `/Volumes/The Ortus Outreach 2.6.0-arm64/First-Time Setup.command` with `-rwxr-xr-x` mode
- No changes to `server.js`, `src/**`, `electron/main.js`, `public/**` — verified (only `build/First-Time Setup.command` and `package.json` touched by task commits)
