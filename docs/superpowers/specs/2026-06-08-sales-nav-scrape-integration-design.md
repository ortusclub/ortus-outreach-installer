# Sales Nav Scrape — integration design

**Captured:** 2026-06-08
**Branch:** `steven/scraper-integration`
**Status:** In progress — app-side foundation landing first; live wiring blocked on artefacts (see end).

## Goal

Add a **"Sales Nav Scrape"** campaign type to the Ortus Outreach app. The app is the
**control panel**; the actual Sales Navigator scraping runs on the existing **GKE engine**
(the `salesnav-cloud-scraper` service). The app never launches a scraper browser locally —
it dispatches jobs to GKE over HTTP and surfaces live progress.

## Architecture (agreed with operator)

```
Ortus app (each Mac, Electron)            GKE (cloud)
─────────────────────────────             ─────────────────────────
"Sales Nav Scrape" campaign type   HTTPS  scraper engine
 • paste Sales Nav search URL(s)  ──────▶  • GoLogin profile via SDK (Orbita/Xvfb)
 • pick GoLogin profile + sheet            • job queue, pagination, interceptor
 • live progress / pause / stop  ◀──────   • writes results to Google Sheet
        CONTROL PLANE                              DATA PLANE
```

Decisions locked in earlier:
1. **Browser layer:** scraper runs on GKE (kept), not GoLogin Cloud (capped at 2 concurrent
   on the Business plan — see memory `project_gologin_cloud`). App is a thin client.
2. **Identity:** the GKE engine drives the team's **existing GoLogin profiles** via the SDK
   (local SDK launch on the pod, NOT cloud-run, so it is not subject to the 2-concurrent
   cloud cap). This **replaces noVNC interactive login** and unifies identity with outreach.
   This also unblocks **horizontal autoscaling** on GKE (sessions live in GoLogin cloud, so
   pods become stateless re: LinkedIn sessions — removes the ReadWriteOnce-PVC blocker that
   currently forces single-replica; see scraper repo `k8s/07-hpa.yaml`).
3. **UI:** appears as a new **campaign type/mode**, reusing the dashboard.
4. **Sheets:** engine writes results to the sheet directly (its own service account) — no
   Apps Script / Antonio dependency for the scrape output.

## Constraints carried forward

- **One browser per GoLogin profile** — a profile cannot run in two places at once. The
  engine/queue must hold a per-profile lock; concurrency scales with *distinct profiles
  with work*, not raw pod count.
- **Profile must have a Sales Navigator seat.**
- **Off-limits files** unchanged: scrape executes via the GKE client and bypasses the local
  `performOutreach` path, so `src/linkedin/outreach.js` / `actions.js` are NOT touched.

## App-side scope (this repo)

| Component | File | Status |
|---|---|---|
| GKE engine client (start/pause/resume/stop/jobs/health) | `src/scraper-client.js` | ✅ landing now |
| Engine config (URL + token) | `.env.example` | ✅ landing now |
| Client unit test | `tests/scraper-client.test.js` | ✅ landing now |
| Mode registration (card) | `public/js/app.js` `MODE_LIST` (~2137) + `public/index.html` (~490) | ⬜ phase 2 |
| Per-mode UI (show URL/profile/sheet; hide daily limit/templates) | `public/js/app.js` `onModeChange()` (~1543) | ⬜ phase 2 |
| Dispatch `sales_nav_scrape` → `scraper-client` instead of local `startCampaign` | `server.js` `/api/campaign/start` (~890) | ⬜ phase 2 |
| Live progress surfaced in dashboard | reuse `/api/campaign/status` rail | ⬜ phase 2 |

## GKE-side scope (separate repo: `salesnav-cloud-scraper-v3`, branch `steven/gologin-engine`)

Code written + syntax-checked; NOT runtime-verified (needs a build + deploy + the
GoLogin token/profile). `node --check` passes on all four JS files.

| Change | File | Status |
|---|---|---|
| Swap `chromium.launchPersistentContext` → GoLogin SDK `GL.start({profileId})` + Playwright `connectOverCDP(wsUrl)`, keyed by profileId, with a per-profile launch lock | `browser.js` (rewritten) | ✅ code |
| Thread `profileId` as the browser identity | `scraper.js` | ✅ code |
| Per-profile concurrency lock (`isProfileRunning`, `_tick` by profile) + `pause/resume/stopForProfile` | `queue.js` | ✅ code |
| `GL.stopAndCommit()` cookie-commit on close | `browser.js` | ✅ code |
| Accept `profileId` + `searchUrls` on `/api/scrape/*`; `/api/jobs` returns all when unfiltered; control by profile | `server.js` | ✅ code |
| Add `gologin` dependency + `GOLOGIN_API_TOKEN` config | `package.json`, `.env.example` | ✅ code |
| Drop noVNC/x11vnc/websockify; Xvfb-only; Orbita home | `Dockerfile`, `k8s/entrypoint.sh` | ✅ code |
| Add `GOLOGIN_API_TOKEN` (secret) + drop 6080 | `k8s/03-deployment.yaml` | ✅ code |
| `startLogin()` neutered to a guard (noVNC removed) | `browser.js` | ✅ code |
| Enable HPA now that pods are stateless re: LinkedIn sessions | `k8s/07-hpa.yaml` | ⬜ optional, not enabled |

### Deploy steps (when ready — by you, with cluster/registry access)
1. `npm install` in the scraper repo (pulls `gologin`).
2. Add `GOLOGIN_API_TOKEN` to the `salesnav-secrets` Secret (`k8s/02-secret.yaml`).
3. Build + push the image; `kubectl apply` the k8s manifests.
4. Point the Ortus app's `SCRAPER_ENGINE_URL` at the engine, set `SCRAPER_ENGINE_TOKEN` if the engine requires one.
5. Live test with one GoLogin profile that has a Sales Nav seat; confirm a local SDK launch does NOT consume a cloud-launch slot.

### Known follow-ups / notes
- `login.js`, `setup-vnc.sh`, and the noVNC login endpoints in the scraper's
  `server.js` are now dead code (harmless — `startLogin()` throws if hit). Can be
  deleted in a cleanup pass.
- `k8s` `04-service.yaml` / `05-ingress.yaml` still reference the old setup
  loosely (port 80→http is fine; the `08-backendconfig.yaml` 3600s timeout was
  for noVNC websockets — harmless to leave, can be trimmed).
- The `sessions` PVC (ReadWriteOnce) is no longer used for LinkedIn sessions
  (they live in GoLogin's cloud). Removing it is what unblocks HPA.

## Blocked-on (needed before live wiring + verification)

1. **Engine endpoint + auth** — confirm `scraper.ortusclub.com` is reachable from laptops and
   the credential model (shared token vs per-user). Feeds `SCRAPER_ENGINE_URL` /
   `SCRAPER_ENGINE_TOKEN`.
2. **One GoLogin profile ID with a Sales Nav seat** — to verify a GoLogin profile launches on
   GKE/Linux via the SDK (and confirm a local SDK launch does NOT consume a cloud-launch slot).

## Test note

`tests/scraper-client.test.js` runs under `node --test`, mocks `fetch`, and verifies request
shaping + error handling with NO live engine — so the foundation is verifiable today.
