# Self-serve GoLogin token update (app + engine), validated

Status: spec / agreed direction 2026-09-21

## Problem

The GoLogin API token lives in two disconnected places, each read only at start-up:
- **Engine:** `process.env.GOLOGIN_API_TOKEN` from a K8s secret (feeds cloud scrapes + campaigns).
- **App:** `tokenForAccount()` reads `process.env.GOLOGIN_API_TOKEN` from the DMG's baked `.env` (feeds the "Browse accounts" roster).

GoLogin tokens don't expire but *do* die the instant someone deletes/regenerates them in GoLogin. This has now broken prod twice (2026-09-16, 2026-09-21 — Sam deleting the token). Each time: the engine needs a manual `kubectl` secret patch + restart, and **every operator on the same app build** sees "GoLogin refused the app's key" (they all share one baked token) with no self-serve fix short of a reinstall. Antonio's `ortus-basics` app can set its *own* token in-app but can't touch the engine.

## Goal

Any operator can paste a fresh GoLogin token in the app and have it update **both** the engine and their app **safely, with no restart and no kubectl** — turning a fleet-wide fire-drill into a self-serve 30-second action.

## Decisions (agreed)

- **Approach B — DB-backed engine token, not K8s-secret patching.** The engine reads the token from its own Postgres (a tiny config table), cached briefly; the app updates it via an authenticated endpoint that writes one row. No pod restart, no K8s RBAC. On boot the DB is seeded from the K8s secret as a fallback, then the DB value wins.
- **Open to every (authenticated) operator** — not admin-gated. Safe because of the validation below.
- **Validation is mandatory before anything is written** (this is what makes open access safe).

## Validation (runs before any write, engine or app)

1. **Works** — POST the token to GoLogin `GET /browser/v2` and require **HTTP 200**. Reject 401/anything else with a clear "this token is dead — get a fresh one from GoLogin."
2. **Right account** — decode the token's `sub` and require it to match the expected Ortus account (`686551f4d0038727dda145a6`). A token from a *different* GoLogin account returns 200 but lists the wrong profiles, so "works" alone isn't enough. (The expected sub is config, not hard-coded, so it survives an account change.)
3. **Already-matches → no-op** — compare the pasted token to the currently-deployed engine token. If it's the **same** token already in use, do nothing and report "already up to date." (Avoids needless writes; also means re-pasting the current token is harmless.)
4. **Replacing a *working* token → confirm.** If the token is valid + right-account + *different*, check the health of the token the engine is currently using:
   - Current token **dead (401)** → write immediately, no prompt (it's broken; just fix it).
   - Current token **live (200)** → ask **"the engine already has a working token — replace it?"** before writing. Prevents a colleague needlessly swapping a healthy token (both would work, but a live-token swap is a fleet-wide change nobody asked for).

Only a token that is **valid + right account + different**, and (when the current one is live) **confirmed**, actually gets written.

## Design

### Engine
- **Config table** (Postgres): `gologin_tokens(workspace TEXT PRIMARY KEY, token TEXT, updated_at, updated_by)`. Workspaces: `ortus` (default), `linkedvelocity`, `marketing`.
- **Token read path** — `tokenForAccount()` / `server.js` read from the DB (cached ~30s in-process), falling back to `process.env.<VAR>` when the DB has no row (first boot). No restart needed to pick up a change; the cache TTL bounds staleness.
- **`POST /api/gologin-token`** (behind the existing `authMiddleware`): body `{ workspace?='ortus', token, confirmReplaceLive?=false }`. Runs the validations, writes the row on success, busts the cache. Returns a typed result: `{ ok:true, changed:true }` / `{ ok:true, changed:false, reason:'already up to date' }` / `{ ok:false, reason:'needs_confirm', currentLive:true }` (valid+different but current token is live and `confirmReplaceLive` was false — the app shows the confirm and re-posts with the flag) / `{ ok:false, reason:'dead token'|'wrong account' }`.
- **`GET /api/gologin-token/status`**: per-workspace `{ present, sub, live:200|401, updatedAt, updatedBy }` for the app to show current health without exposing the token itself.

### App
- **Settings UI** — a "GoLogin token" field per workspace (default Ortus) with the current status (live/dead, who updated it, when) from the status endpoint. Paste + Save runs the same 3 validations client-side for instant feedback, then calls the engine endpoint.
- **App-side persistence** — the operator's token is stored in `ORTUS_DATA_DIR` (survives reinstall, overrides the baked `.env`); `tokenForAccount()` reads the override first, then env. So Save fixes **their** roster immediately AND the engine centrally.
- **Multi-workspace** — the field states which workspace it targets; default and most-used is Ortus.

## Durable extension (optional, recommended follow-up — not required for v1)

Once the engine holds the authoritative token in the DB, point the **app roster at the engine** (fetch the profile list from the engine instead of calling GoLogin directly with a baked/override token). Then a single validated update fixes **every** operator's roster at once and no app carries a token — a token deletion becomes one DB row to fix, fleet-wide. v1 already lets each operator self-fix their own app; this makes it truly central.

## Open questions

- ~~Auth granularity / overwrite~~ — DECIDED 2026-09-21: any authenticated operator can update (no admin gate); the "replace a *live* token?" confirm (validation #4) is the guard against a needless fleet-wide swap.
- **Audit** — keep `updated_by` + a short history so a bad swap is traceable. Worth an ops-log event too.
- **Seed/migration** — on first deploy, seed the DB rows from the current K8s secret so nothing changes until someone updates it.

## Testing (`node --test`)

- Validation unit tests (mock the GoLogin fetch): dead token → rejected; wrong-`sub` → rejected; matching token → `changed:false`; valid+different → written + cache busted.
- Engine token-read prefers DB over env, falls back to env when absent, respects the cache TTL.
- App override read: `ORTUS_DATA_DIR` token wins over baked `.env`.

## Files (implementation, on a NEW branch — this is not Magellan)

- Engine: `campaign-store.js` (config table + read/write), `gologin-accounts.js` / `server.js` (read from store), new route in `server.js`.
- App: `src/gologin-accounts.js` (override read), a settings route in `server.js`, the Settings UI in `public/js/app.js` + `index.html`.
