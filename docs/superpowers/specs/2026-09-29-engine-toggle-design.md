# In-app engine toggle — point the app at the dev or prod cloud engine

**Date:** 2026-09-29
**Status:** draft (not approved)
**Repos:** app `ortus-outreach-installer` (+ engine `ortus-salesnav-scraper-cloud` as the dev deploy target)

## Why

As of 2026-09-28 one person owns the whole engine and ships its fixes. The bugs
that actually bite — Orbita's incomplete download, the campaign `Maximum call
stack size exceeded`, KEDA/Cloud SQL/Xvfb behaviour — only reproduce **inside
GKE**, never on a local Mac. So they have to be validated on the **dev engine**
(`salesnav-dev`, a real GKE stack) before they touch prod, which runs **live
outreach for every operator and hundreds of LinkedIn accounts**.

But the app only talks to **prod** (`https://scraper.ortusclub.com`). The only
way to aim it at dev today is to set a `SCRAPER_ENGINE_URL` env var and restart —
no in-app control, and easy to forget you did it. This spec adds a **per-operator
toggle** so a power user can point the app's cloud calls (scraper *and*
campaigns) at dev or prod, safely and visibly.

## What already exists

The plumbing is 80% there — this feature mostly exposes it:

- **URL is already overridable.** `src/scraper-engine-url.js` exports the prod
  default (`https://scraper.ortusclub.com`) and lets `process.env.SCRAPER_ENGINE_URL`
  override it. Both clients resolve through the same shape:
  `engineUrl() = (process.env.SCRAPER_ENGINE_URL || SCRAPER_ENGINE_URL)` —
  `src/scraper-client.js:25` and `src/campaigns-client.js:31`.
- **Dev-vs-prod is already detected.** `server.js:448` computes
  `isProductionEngine` and `server.js:459` reports
  `scraperEngineEnvironment: 'production' | 'development'`. The app already knows
  which environment it is on; it just can't *change* it.
- **A local-settings pattern to copy.** Sam's `src/gologin-credentials.js` stores
  operator input in `dataPath(...)` (atomic tmp+rename, `0600`) and applies it
  **live with no restart** by mutating `process.env` at call time. The engine
  toggle should store and apply itself the same way.
- **`runs_on` already tracks ownership.** A cloud campaign carries
  `runs_on = 'vm'` (vs `'local'`); this is orthogonal to *which* cloud engine and
  is the hook the live-run guard below uses.

Note: this is **not** the "Run in cloud" toggle (that's local-Mac vs cloud). This
picks **which cloud** — dev or prod — when a run does go to the cloud.

## Decisions (to confirm before build)

1. **Per-operator, local, on-machine** — never team-wide/server-stored. One
   person testing against dev must not repoint anyone else.
2. **One source of truth, read by both clients** — scraper and campaigns must
   never split brains (scraper on dev, campaigns on prod).
3. **Default is prod; dev is opt-in** and always explicit.
4. **Gated to power users** — hidden from regular operators, so nobody sends real
   outreach from a dev engine or seeds test data into prod by accident.
5. **Applies to NEW runs only** — switching never re-points a campaign already
   running on an engine. (Moving a *live* run between engines is out of scope —
   that's the VM↔local-handover territory, `2026-08-21-vm-local-handover-design.md`.)
6. **Dev URL + dev token travel together** as a pair.

## Scope

**In:** a stored `{ engine, devUrl, devToken }` setting; both clients resolving
through it; a Settings toggle + a persistent environment badge; a reachability +
token health-check before switching to dev; a guard against switching while cloud
runs are active.

**Out (deferred):** moving a live campaign between dev and prod; more than one
named dev engine; auto-spinning-up a `salesnav-dev` that's been scaled to zero
(the operator brings it up first — see the infra note below).

## Architecture

- **`src/engine-target.js` (new)** — mirrors `scraper-engine-url.js`. Reads
  `dataPath('engine-target.json')` → `{ engine: 'prod' | 'dev', devUrl, devToken }`.
  Exports `resolveEngine() → { url, token, environment }` with precedence:
  **explicit `SCRAPER_ENGINE_URL` env** (unchanged dev override) **> stored
  choice > prod default**. Also `applyEngineTarget()` to mutate the process env
  live, exactly like `applyCredentials()`.
- **`src/scraper-client.js` + `src/campaigns-client.js`** — their `engineUrl()` /
  token accessors delegate to `resolveEngine()`. One small change each; the rest
  of both clients is untouched.
- **`server.js` routes:**
  - `GET /api/engine-target` → current choice + `scraperEngineEnvironment` +
    last health result.
  - `POST /api/engine-target` → set the choice. **Validates a dev target before
    saving**: the dev URL is reachable and the token is accepted (a lightweight
    authed ping). Refuses on down / 401. Prod needs no validation.
- **Storage** — atomic `tmp`+`rename`, mode `0600`, like `gologin-credentials.json`.
- **Live-run guard** — `POST` refuses (or warns + requires an explicit confirm)
  when any campaign has `runs_on === 'vm'` active, so a switch can't strand work
  on the engine that owns it.
- **Health check** — switching to dev pings `devUrl` health with `devToken` and
  refuses if it's down (dev is often scaled to zero to save cost — see infra note).

## UI

- **Settings → a segmented control "Engine: Prod | Dev"**, shown only to power
  users (gate: a devtools/admin flag or email allowlist — decide at build time).
- **Persistent environment badge** (reuse `scraperEngineEnvironment`): a calm
  "PRODUCTION" and a loud amber "DEVELOPMENT" that stays visible everywhere while
  on dev — you must never forget you're pointed at dev.
- **Selecting Dev** prompts for the dev URL + token if unset, runs the health
  check, and on failure says why (unreachable / bad token) instead of silently
  saving a dead target.
- **Confirm dialog** if switching while cloud runs are active (ties to the guard).

## Infra note

`salesnav-dev` is currently idle and a candidate to **scale to zero** to save
cost. If it's parked, the health-check will (correctly) refuse to switch until the
operator brings it back up:
`kubectl -n salesnav-dev scale deploy redis salesnav-scraper --replicas=1`.
Auto-wake is explicitly out of scope for v1.

## Testing

- `resolveEngine()` precedence: env override > stored choice > prod default.
- Both clients honour the stored choice (scraper and campaigns resolve to the
  same base).
- `POST /api/engine-target` validates dev reachability + token; refuses on
  down/401; prod saves without a probe.
- Live-run guard blocks/warns when a `runs_on='vm'` campaign is active.
- Badge + `GET` reflect the resolved environment after a switch.
- Regular (non-power) operator never sees the control.

## Rejected

- **Team-wide / server-stored choice** — one person's dev switch would repoint
  everyone. Per-operator local only.
- **Auto-switching running campaigns** — that's a live handover, a separate
  design; here a switch only affects new runs.
- **A free-text engine URL exposed to all operators** — too easy to misdirect
  real outreach. Gated, with a known dev target and a mandatory health-check.
