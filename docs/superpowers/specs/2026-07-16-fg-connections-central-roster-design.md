# Central Connections Roster Service — Design

**Date:** 2026-07-16
**Repos:** `ortus-gologin-clone` (app, branch `preflight-linter-2135`) — new service + client changes live here. Deploy target: existing GKE cluster `gke_salesnav-scraper-prod_asia-southeast1_salesnav-cluster`, namespace `salesnav-scraper`.

## Problem

The FG Team Launch colleague roster and the Connections Search tab are both built from a **local** ingested connections DB (`data/connections/*.csv` + `data/connections-cache.json`, ~152 MB on Antonio's machine). That DB is gitignored **and** excluded from the DMG (`package.json` `files: ["!data/**/*"]`, `extraResources` ships only `.env`). So every operator except Antonio runs a build with **zero** connections data:

- **FG Team Launch** → empty roster → *"No colleagues match that search."* (Ton's report, 2026-07-16.)
- **Connections Search** → empty results / zero stats (same root cause, same screen family).

Refresh / reopen can't fix it — there is no data on the remote machine to show.

## Goal

Every operator sees the FG roster and Connections Search **exactly as Antonio does (1:1, live)** — including per-role `matched` counts computed live over the full DB for any typed role. Fidelity is non-negotiable; the data is acceptable to host centrally because the FG campaign is password-gated behind the app.

## Approach (chosen)

**B — a thin always-on service that runs the app's *real* roster code**, which the app calls only when its local DB is absent. Rejected: (A) vendoring the roster code into the GKE engine — creates a second copy of the match logic that must stay byte-identical forever, the exact drift that has repeatedly burned this project ("VM must mirror local EXACTLY"). B makes drift structurally impossible because there is one copy of the code.

The roster/search code is a self-contained ESM subtree — `src/connections/search-service.js` → `csv-ingest.js`, `match.js`, Node stdlib only, no browser/puppeteer/app coupling — so it runs unchanged on a server.

## Architecture

```
Remote operator's app                     Antonio's app
  /api/connections/search  ──┐              /api/connections/search
  /api/fg/colleagues  ───────┤                /api/fg/colleagues
        │ dbCall(fn,args)     │                     │ dbCall(fn,args)
        │ local cache absent  │                     │ local cache PRESENT
        ▼                     │                     ▼
  POST https://scraper.ortusclub.com/fg-roster/rpc   listFgColleaguesMatched(...) etc.
        │ {fn,args} + Bearer                          (runs locally, unchanged, fast)
        ▼
  ┌──────────────── GKE: fg-roster Deployment (replicas:1, always-on) ─────────────┐
  │  Express: POST /rpc  → whitelist-dispatch → src/connections/search-service.js   │
  │           GET  /health,  POST /admin/refresh                                    │
  │  DB in an emptyDir, pulled from GCS bucket on boot (memoized in RAM by          │
  │  search-service; auto-reloads on file mtime after /admin/refresh re-pull).     │
  └────────────────────────────────────────────────────────────────────────────────┘
        ▲ gsutil rsync (publish)
  Antonio's machine: scripts/publish-connections-db.sh  →  gs://<bucket>/connections + cache
```

## Components

### 1. Roster service — `services/fg-roster/server.js` (new, ~60 lines)

- Express app, imports the app's **real** `src/connections/search-service.js`. No copy of match logic.
- Routes (all under the `/fg-roster` path prefix so they sit behind the shared ingress — see Deploy):
  - `POST /rpc` — body `{ fn, args }`. `fn` must be in a hard-coded whitelist; call `searchService[fn](...args)`; return `{ result }`. Non-whitelisted `fn` → `400`.
    - **Whitelist (the five pure DB reads):** `listFgColleaguesMatched`, `getConnectionsStats`, `searchConnections`, `exportConnections`, `buildLeadRows`.
  - `GET /health` — `200 {ok:true}` for the k8s liveness/readiness probe. Does **not** touch the DB.
  - `POST /admin/refresh` — re-run the GCS pull into the DB dir, return `{ok:true, pulledAt}`. `search-service` auto-reloads on mtime, so the next `/rpc` sees fresh data with no restart.
- **Auth:** every route except `/health` requires `Authorization: Bearer <token>`. Token from `FG_ROSTER_TOKEN` env; mirrors the engine's shared-token model.
- **Boot:** pull the DB from GCS → local dir (`CONNECTIONS_DIR`), then `listen`. If the pull fails, still listen (so `/health` passes and the pod isn't crash-looped); `/rpc` returns `503 {error:'db not loaded'}` until a successful pull. Log loudly.
- Whitelist dispatch and args are JSON-serializable in and out (verified: criteria objects, `{limit}`, `{urls}`, `{alreadyInvited}` args; results are plain objects/arrays).

### 2. App client fallback — `server.js` + `src/fg-roster-url.js` (new)

- **`src/fg-roster-url.js`** (mirror of `src/scraper-engine-url.js`): hard-code
  `FG_ROSTER_URL = 'https://scraper.ortusclub.com/fg-roster'` and
  `FG_ROSTER_TOKEN = 'ortus2026scraper'`, each overridable by an env var of the same name. Baked in so remote DMGs work with zero `.env` setup.
- **`hasLocalDb()`** — add to `search-service.js` (it owns the paths): `fs.existsSync(DEFAULT_CACHE)`. This is the exact remote-vs-local signal — remote DMGs have no cache file.
- **`dbCall(fn, args)`** — one helper in `server.js`: if `hasLocalDb()` → `searchService[fn](...args)` locally (Antonio, unchanged, fast); else `POST FG_ROSTER_URL + '/rpc'` `{fn, args}` with the Bearer, return `result`. On network/HTTP error → throw (fail-closed).
- **Rewire the five read routes** through `dbCall` (criteria transform stays app-side; the transformed args are passed to `dbCall`):
  - `/api/fg/colleagues` — compute `alreadyInvited` from the FG sheet **as today** (every operator can reach that sheet), then `dbCall('listFgColleaguesMatched', [roles, {alreadyInvited}])`.
  - `/api/connections/stats` — `dbCall('getConnectionsStats', [])` (keep the local-only `sync` state as-is; see below).
  - `/api/connections/search` — `dbCall('searchConnections', [criteria, {limit}])`.
  - `/api/connections/export` — `dbCall('exportConnections', [criteria, {urls}])`.
  - `/api/connections/to-workbook` — `dbCall('buildLeadRows', [criteria, {urls}])` for the rows, then write the Google Sheet **locally** via `createWorkbookTab` exactly as today (sheet write is an app-side Apps Script call, not a DB op).
- **`/api/connections/sync` is untouched.** Sync is the *ingest* (pull CSVs from Drive + refresh HubSpot cache = build the DB). It is Antonio's data-building operation that feeds the publish step — not something remote operators run. Remote operators only consume.
- **`/api/connections/stats` `sync` field:** on remote machines there is no local sync; return the existing `getConnectionsSyncState()` (idle) unchanged. Non-goal to surface central build progress to remote operators.

### 3. DB hosting + publish

- **Bucket:** a GCS bucket in the `salesnav-scraper-prod` project (e.g. `gs://ortus-fg-connections-db`) holding `connections/` (the CSV folder) + `connections-cache.json`.
- **Service access:** Workload Identity — bind the service's KSA to a GSA with `roles/storage.objectViewer` on the bucket (mirror however the engine authenticates to GCP; resolve exact SA at plan time).
- **Boot pull + refresh:** `gsutil -m rsync -r -d gs://…/connections $CONNECTIONS_DIR/connections` + `gsutil cp gs://…/connections-cache.json $CONNECTIONS_DIR/connections-cache.json`, into an `emptyDir`. Re-pulled on boot and on `/admin/refresh`. **ponytail: emptyDir + boot-pull, not a PVC** — the pod is always-on so re-pulls are rare, and a 152 MB in-region GCS pull is seconds; add a PVC only if restart frequency ever makes the re-pull hurt.
- **Publish (Antonio):** `scripts/publish-connections-db.sh` — `gsutil -m rsync -r -d data/connections gs://…/connections`; `gsutil cp data/connections-cache.json gs://…/`; then `curl -X POST -H "Authorization: Bearer …" https://scraper.ortusclub.com/fg-roster/admin/refresh`. Run after each re-ingest. **No auto-sync** — re-ingest is rare (YAGNI).

### 4. Deploy — GKE (app-repo image, shared ingress)

- **Dockerfile** in the app repo (new; app has none — it's an Electron app). `node:22-slim` + `google-cloud-cli` (for `gsutil`) or use the `google/cloud-sdk` base; `npm ci --omit=dev`; `CMD node services/fg-roster/server.js`. Only the ESM `src/connections/*` subtree + `services/fg-roster` are needed at runtime, but copying the repo is simplest.
- **k8s manifests** in the app repo (`k8s/fg-roster/`):
  - `Deployment` `fg-roster`, namespace `salesnav-scraper`, `replicas: 1` (always-on, not KEDA), modest CPU/RAM (annotate: the memoized annotated DB needs enough RAM to hold ~152 MB cache + derived structures — request ~1 GiB, cap higher; tune from live).
  - `Service` `fg-roster` (ClusterIP, port 80 → container).
  - **Ingress:** add a `path: /fg-roster` rule to the **existing** `salesnav-scraper` Ingress (`k8s/05-ingress.yaml` in the engine repo) pointing at the `fg-roster` service, **before** the `/` catch-all. Reuses the domain, cert, and static IP — no new DNS/cert/IP. GCE ingress does not strip the prefix, so the service mounts its routes under `/fg-roster` (matches the baked-in URL).
  - Secret for `FG_ROSTER_TOKEN` (mirror `02-secret.yaml.example`).
- **Deploy = explicit user approval** (prod `kubectl apply`), per standing rule. Image build: `gcloud builds submit` (or reuse the engine's Cloud Build pattern), then `kubectl apply -f k8s/fg-roster/` + patch the shared ingress.

## Data flow (remote operator, FG roster)

1. App `/api/fg/colleagues?roles=marketing,growth` → route computes `alreadyInvited` from the FG sheet.
2. `hasLocalDb()` = false → `dbCall` POSTs `{fn:'listFgColleaguesMatched', args:[['marketing','growth'], {alreadyInvited}]}` to `…/fg-roster/rpc` with the Bearer.
3. Service dispatches to `searchService.listFgColleaguesMatched(...)` over the RAM-memoized DB → `{result: [{email,name,total,matched}, …]}`.
4. App returns `{colleagues: result}` → identical shape to today → picker renders exactly as on Antonio's machine.

## Error handling

- Central unreachable / non-2xx → `dbCall` throws → routes return their existing error shape → the FG picker shows the existing **"Couldn't load the team — try again"**, and Connections Search shows its existing error. **Fail-closed:** never fall back to a silent empty result that masquerades as "nobody matches."
- Service DB-not-loaded → `/rpc` `503`; app surfaces the same retry error.
- `/health` never depends on the DB, so a failed pull doesn't crash-loop the pod (it self-heals on `/admin/refresh` or restart).

## Security

- `/rpc` and `/admin/refresh` require the shared Bearer; `/health` is open.
- Only a hard-coded whitelist of five **read** functions is callable — no arbitrary `fn`, no writes, no `sync`, no filesystem access via the RPC.
- Data exposure is acceptable per the product decision (campaign is password-gated); the Bearer keeps it off the open internet at the team-wall level, consistent with the engine.

## Testing

- **Pure unit test** (`node --test`) for `dbCall`: with `hasLocalDb()` true it calls the local function and does **not** hit the network; with it false it POSTs to the central URL with the Bearer and returns `result`. (Fetch stubbed.)
- **`hasLocalDb()`** unit test: true when the cache file exists, false when absent (temp dir).
- The roster/search **math is already the app's tested code** — no new tests for it; the service just exposes it.
- **Manual integration:** one remote-style smoke test (rename local cache away → app hits central → roster + a search both return non-empty, matching a local run).

## Scope / non-goals

- **In:** FG Team Launch roster **and** Connections Search (stats/search/export/to-workbook rows) working 1:1 for all operators.
- **Out:** central *ingest* (remote-triggered sync/build) — Antonio remains the sole DB builder + publisher. Surfacing central build progress to remote operators. Auto-sync of the DB. A PVC for the DB (emptyDir until proven insufficient). Migrating Antonio himself to central (he stays local for speed; central is fallback only).
- **Extensible:** adding another DB-backed read later = add its name to the whitelist + route it through `dbCall`. No new infra.

## Open items to resolve at plan time

- Exact GSA / Workload Identity binding for the bucket (mirror the engine's GCP auth).
- Final bucket name + RAM request/limit (tune from a first live load).
- Confirm the `google/cloud-sdk` (or slim + gsutil) base keeps the image reasonable; if `gsutil` bloat is unwanted, swap the boot-pull to the GCS Node client — same behavior, no CLI. (ponytail: prefer whichever is fewer moving parts once the base image is chosen.)
