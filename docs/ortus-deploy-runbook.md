# Ortus Outreach — Deploy Runbook

How we ship the scraper/campaign **engine** (GKE) and the desktop **app** (DMG).
Written for a Claude Code session so it can follow the process exactly.

---

## Repos & environments

| Thing | Where |
|---|---|
| **Engine** repo | `~/Downloads/salesnav-cloud-scraper-v3` → GitHub `ortusclub/ortus-salesnav-scraper-cloud` |
| **App** repo | `~/ortus-outreach-installer` → GitHub `ortusclub/ortus-outreach-installer` |
| **Cluster** | GKE Autopilot `salesnav-cluster`, project `salesnav-scraper-prod`, region `asia-southeast1` |

**Engine runs in two fully-isolated namespaces:**

| | DEV | PROD |
|---|---|---|
| Namespace | `salesnav-dev` | `salesnav-scraper` |
| URL | `dev-scraper.ortusclub.com` | `scraper.ortusclub.com` |
| Branch it ships from | any (your working branch) | `production` |
| Redis / DB / secrets | its own (`campaigns_dev`, `*-dev` secrets) | prod's (`campaigns`) |
| Version banner | `dev-v<n>` | `v<n>` |

Each namespace has 3 deployments: **`salesnav-scraper`** (API), **`campaign-worker`** (campaign jobs), **`salesnav-worker`** (scrape jobs). Workers scale `0→N` via KEDA on the Redis queue.

The app picks which engine via the sidebar **Engine** toggle (DEVELOPMENT vs PRODUCTION). Dev is completely isolated, so deploying/testing dev never touches what colleagues run on prod.

---

## 1. Deploy the DEV engine

```bash
cd ~/Downloads/salesnav-cloud-scraper-v3
./deploy-dev.sh
```

What it does:
1. **Refuses** if you're on the `production` branch, or if the tree has **uncommitted changes** (the image must match a real commit). → commit first.
2. Builds a new image from your current `HEAD` via Cloud Build, tagged **`dev-N`** (auto-increments) + a `git-<sha>` tag for traceability.
3. Rolls the 3 dev deployments to that image.
4. Stamps `ENGINE_VERSION=dev-v<n>` (what the app's banner shows for dev).

- Takes a few minutes (Docker build). Run it in the background if you like.
- Free to run anytime — it's isolated.
- **Test:** flip the app's Engine toggle to **DEVELOPMENT**, then run your scrape/campaign; it hits `dev-scraper`.

---

## 2. Promote the ENGINE to PROD

Prod is **not** a rebuild — it re-tags the **exact dev image** as `vN` and rolls prod. So what you tested on dev is byte-for-byte what ships.

> ⚠️ **Never run this without the user's explicit green light.** It's production.

```bash
cd ~/Downloads/salesnav-cloud-scraper-v3
./promote.sh            # promotes the dev engine's CURRENT image
# or: ./promote.sh dev-50   # promote a specific dev tag
```

What it does:
1. **No-rollback guard:** refuses unless the dev image's commit is a descendant of what prod runs (so you can't accidentally roll prod backward). If it refuses, rebase your dev work onto `production` first.
2. **Interactive confirm:** you must type `promote` to proceed.
3. Re-tags the dev image as `vN` (N = prod's current + 1), no rebuild.
4. Rolls **`salesnav-scraper` (API) + `campaign-worker`**, stamps `ENGINE_VERSION=vN` + `ENGINE_ENVIRONMENT=production`.
5. **Scraper idle-gate:** if `salesnav-worker` has running scrapes, it **skips rolling it** (prints *"skipping its roll so live scrapes aren't cut"*). Pass `FORCE_SCRAPER_ROLL=1` to override (will cut live scrapes — avoid).
6. Fast-forwards the `production` branch to the commit and pushes.

**Finishing a skipped scraper:** when `salesnav-worker` is idle (0 running scrapes), roll it to catch up:
```bash
kubectl -n salesnav-scraper get pods -l app.kubernetes.io/name=salesnav-worker \
  --field-selector=status.phase=Running --no-headers | grep -c .   # 0 = safe
kubectl -n salesnav-scraper set image deploy/salesnav-worker \
  app=asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/scraper:vN
```
Until then, scraper-only engine features (e.g. account-failover, sheet-not-shared stop) aren't live even though the API/campaign side is on vN. A mixed version (new API/campaign-worker + old salesnav-worker) is safe as long as changes are additive.

**Pre-flight checks (read-only) before promoting:**
```bash
# current prod version + dev tag
kubectl -n salesnav-scraper get deploy salesnav-scraper -o jsonpath='{..image}'
kubectl -n salesnav-dev     get deploy salesnav-scraper -o jsonpath='{..image}'
# any scrapes running? (if >0, promote will skip the scraper-worker)
kubectl -n salesnav-scraper get pods -l app.kubernetes.io/name=salesnav-worker \
  --field-selector=status.phase=Running --no-headers | grep -c .
```

---

## 3. Release the APP (DMG)

Version lives in `package.json`. Releases are tagged `v<version>` with two DMGs attached (arm64 + Intel). Operators get them via **Check for updates**.

> ⚠️ **Never release without the user's explicit green light.**

**Steps:**
1. Bump `package.json` `version` (e.g. `3.1.66 → 3.1.67`), commit.
2. `main` is a **protected branch** — you can't push to it directly. Open a PR from your branch and merge it (the person merges; a session may be blocked from `gh pr merge` by policy).
3. Build + publish from `main`:
   ```bash
   cd ~/ortus-outreach-installer
   npm run release:mac
   ```
   This runs `electron:build:mac` (build both DMGs → sign → notarize) then `scripts/release-mac.js` (creates/updates the GitHub release `v<version>` with the DMGs; uses `--clobber` if it already exists).

**Signing / notarization (important):**
`npm run release:mac` **signs** using a *Developer ID Application* cert in the login keychain, and **notarizes** using three env vars:
```bash
export APPLE_ID="…"                     # Apple Developer account email
export APPLE_APP_SPECIFIC_PASSWORD="…"  # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="…"                # developer.apple.com/account → Membership (10 chars)
```
If the cert or these vars are **missing**, the build still succeeds but ships **unsigned, un-notarized** DMGs — macOS Gatekeeper then blocks them ("damaged / can't be checked"), and operators must right-click → **Open** on first launch. (As of v3.1.65/66 the published DMGs are unsigned; signing is a one-time setup with the org's Apple Developer account.)

The config baked into the DMG is **`build/release.env`** (it overrides `server.js` defaults — e.g. `ADMIN_EMAILS`). GoLogin workspace tokens and HubSpot access tokens are **not** bundled — they're configured in Settings per installation (stored in the operator's data dir), so they survive an app update.

---

## Key facts & gotchas

- **Dev cold-start 502:** dev pods go idle and GKE Autopilot consolidates the quiet node, evicting them. The first request after a lull can **502 for ~90s** while a pod cold-starts (its `cloud-sql-proxy` init). Normal — just wait/retry. Prod stays warm from constant traffic.
- **Graceful drain:** rolling a worker sends SIGTERM; workers finish the in-flight item and re-queue the rest (≈600s grace). A normal campaign deploy loses nothing. Long scrapes can exceed the grace window, which is why `promote.sh` idle-gates `salesnav-worker`.
- **Image ↔ commit is provable:** every image carries a `git-<sha>` tag; `promote.sh` verifies it.
- **Scripts refuse to foot-gun:** `deploy-dev.sh` won't run on `production` or with a dirty tree; `promote.sh` won't roll prod backward and requires typing `promote`.

## Safety rules (always)

1. **No prod deploy without the user's explicit green light** — that means `promote.sh`, prod `kubectl set image`, merging to `production`, and app releases.
2. **Dev is free** — deploy/iterate on dev as much as needed.
3. **Measure, don't guess** — check the live state (`kubectl get`, the engine's `/api/jobs`, the app with a session cookie) before asserting what's happening.
4. **After app changes:** run the full suite (`node --test tests/*.test.js`) and a runtime smoke check before calling it done — not just the one thing you changed.
