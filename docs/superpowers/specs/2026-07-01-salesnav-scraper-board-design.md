# Sales Nav Scraper — Tab + Queue Board Redesign

**Status:** Design approved (visual direction), pending spec review
**Date:** 2026-07-01
**Author:** Antonio + Claude (brainstorming)
**Sketch (reference):** `public/sketches/2026-07-01-salesnav-board-v1-jobs-tabs.html`
(earlier explorations: `2026-07-01-salesnav-phantom-card.html`, `-board-v1-stacked`, `-board-v2-console`, `-board-v3-lanes`)

---

## 1. Goal

Turn the Sales Navigator scraper from a mode buried inside the "New Campaign"
wizard into a **self-contained, self-explanatory experience** — its own tab, a
setup form, and a **queue board** where each scraper campaign is a strip that
explains what it does, where it sits in the queue, who owns it, and what its
jobs/logs are doing. PhantomBuster-style: legible at a glance, honest about the
one-at-a-time queue and the parallel per-URL jobs.

## 2. Why (problem)

Today `sales_nav_scrape` is one of ~12 campaign modes in the wizard
(`public/js/app.js` `MODE_LIST` ~3273–3407; config UI `public/index.html`
1122–1211). It behaves unlike the others — it is a **one-shot dispatch** of N
scrape jobs (one per Sales Nav search URL, each on its own GoLogin account with
a Sales Nav seat) to the GKE cloud engine, writing results to a destination
Google Sheet tab. There is **no recurring loop, no pace/templates/daily-limit**.
Consequences:

- It's confusing to configure alongside modes that DO have those controls.
- After launch there's nowhere good to watch it — no per-campaign job/log view.
- The stop→launch handover is invisible: stopping one and starting another has
  no visual feedback, so operators can't tell what state they're in.

## 3. Scope

**In scope:** a new "Sales Nav" top-level tab; a queue board of scraper
campaigns as strips; per-strip Jobs/Logs tabs; owner-gated On/Off toggle with a
confirm for non-owners; a stop→launch handover visual; "Open" routing to the
setup page.

**Out of scope (this spec):** changing the scrape *engine* itself, changing the
other campaign modes, follower-growth, and any non-Sales-Nav card redesign. The
generic campaigns list is untouched.

## 4. Non-negotiable constraints

- **Do NOT change scrape execution or concurrency logic** (operator decision,
  2026-07-01). This is a **presentation redesign** over the existing GKE scrape
  engine plus the minimal persistence the board needs. The engine already
  queues jobs and reports their state — we surface it, we don't re-implement it.
- **The one-campaign-at-a-time rule does NOT apply to scrapes.** That constraint
  exists because *local* campaigns open browsers/sheets and crash under parallel
  load. Scrapes run on the **cloud engine**, which schedules jobs itself. The
  board reflects the **engine's** queue/positions, not `src/campaign-queue.js`.
- **1:1 with the real skin.** Build in the real app, reusing `/css/style.css` +
  `/css/dashboard-v0.3.css` tokens (`--ink`, `--gray`, `--green`, `--gold`,
  `--hairline`, `--bg-soft`, `--display`, `--mono`), `body[data-dashboard='v3']`
  light theme. No new design system.
- **No invented data.** Strips show only real fields (below). Sample values in
  the sketch are illustrative only.
- **Off-limits files** unchanged: `src/linkedin/outreach.js`, `actions.js`.

## 5. Information architecture

Two states under one new tab:

1. **Setup** — the campaign creation/edit form. Reuse the existing scrape config
   (`index.html` 1122–1211): input (type URLs / from a sheet + row-spec),
   account pairing (one per URL), destination sheet + new tab name, slow-mode.
2. **Board** — the queue view you land on **after saving/launching** a scrape,
   and the tab's default when scrapers exist.

The old `sales_nav_scrape` mode is **removed from the New Campaign wizard** once
the tab ships (see §11 Q1 — transition decision).

## 6. The queue board

A single vertical list of strips, grouped under two rails, **driven by the
engine's real state** (from `scraper-client.js` `getJobs()` — each job reports
`state`, `position`, `accountsAhead`, `etaMs`, `pages`, `profiles`):

- **▶ Now running** — scraper campaigns with any job in `running` state.
- **• Up next in the queue** — campaigns whose jobs are `queued`, ordered by the
  engine's reported `position`.

Because concurrency is unchanged and engine-driven, there **may be more than one
running** campaign if the engine is running jobs across accounts — the board
shows all of them; it does not force a single "Now running". "Done" campaigns
(all jobs `done`/`error`) drop below or into a done section.

**Board header:** date kicker + "Sales Nav Queue" title + a meta line derived
from live engine counts (`N running · M queued`).

**A "scrape campaign" = a persisted named group of jobs** (one job per Sales Nav
search URL) with an owner and destination. Strips group the engine's jobs by
their campaign; positions/ETA/progress within a strip come straight from the
engine per job.

### 6.1 Strip — running (expanded)

Fields (all real):
- Queue position badge (`1`, filled/inverted for the running one).
- Type label `Sales Nav Scraper` · owner name.
- Campaign name (display font).
- Status (`Running · X/Y jobs`).
- **Flow line:** `N searches → N jobs (N accounts) → feeds <Destination Sheet> · tab "<Tab>"`.
- Progress bar + running total rows written.
- **In-strip switcher: Jobs (default) / Logs.**
  - **Jobs** — one row per search: search title/label · the paired account
    email · status (`Running · 118 rows` / `Done · 240 rows` / `Waiting · account busy`).
  - **Logs** — that campaign's own log stream as a console (queue events,
    per-job dispatch/progress/done, toggles).
- Footer: **owner toggle** (On/Off) · **Stop** · **Open**.

### 6.2 Strip — queued (collapsed)

- Same summary header (position badge, type · owner, name, flow line, "Queued
  · starts when #1 finishes").
- **No Jobs/Logs panel** (nothing running yet).
- Footer: **owner toggle** (On/Off) · **Open — owner-only** (non-owners see it
  disabled/locked; the owner sees a normal Open).

There is **no Edit button** anywhere — "Open" routes to the setup/config page,
which is where editing happens.

## 7. Owner-gated On/Off toggle

- Every strip has an On/Off toggle. **Owner = whoever created the campaign**
  (per-machine operator identity / `createdBy`).
- **If it's yours:** the toggle flips immediately.
- **If it's not yours:** a confirm modal appears first —
  *"Are you sure? This isn't your campaign — it belongs to <Owner>. Turning it
  <ON/OFF> affects their scrape and its place in the queue. Continue?"* —
  **Cancel** leaves it, **Yes, toggle it** flips it. (Namespaced modal; the
  sketch proved generic class names collide with app CSS — real impl must scope
  its styles.)
- **Admin override:** `antonio@ortusclub.com` is treated as admin and **bypasses
  the confirm** — the toggle flips immediately on any campaign, as if owned. The
  action is still logged (`toggled OFF by antonio@ortusclub.com (admin)`).
  Everyone else gets the confirm on campaigns they don't own.
- **Semantics (option A — arm/disarm), implemented via the engine's existing
  pause/resume/stop** (`scraper-client.js` `pauseScrape`/`resumeScrape` per
  job): **Off** pauses the campaign's jobs on the engine; **On** resumes them.
  No new queue-execution logic is added — we drive the controls the engine
  already exposes.
- **Every toggle is logged** to that campaign's own log, including who did it
  (e.g. `toggled OFF by Alecx Bagatsolon`), so owners can see cross-owner
  actions.

## 8. "Open" behaviour

**Open → the setup/config page** for that campaign (the same screen it was built
on). It is the single primary action; there is no separate detail "cockpit".
Queued strips gate Open to the owner; running strips expose Open next to Stop.

## 9. Stop → launch handover visual

When one campaign stops and the next launches, the transition must be
**visible**, never a dead moment. A board-level **handover banner** narrates it,
and the affected strips animate:

1. **Stopping** — banner (red accent) + spinner: *"Stopping <A> — finishing the
   current job and closing accounts…"*; strip A pulses red.
2. **Handover** — strip A greys to `Stopped by <who>` (✓ badge); banner flips to
   green: *"Launching <B> — dispatching jobs to the engine…"*; strip B pulses
   green.
3. **Running** — strip B becomes `#1 · Running` (un-collapses to Jobs/Logs);
   banner confirms *"✓ Now running <B>"* then fades.

Exact copy/timing per the sketch; the principle is a continuous narrated state,
not instant silent swaps.

## 10. Data & fields (real, from the scrape config)

Per campaign: name; owner (createdBy / operator identity); mode
`sales_nav_scrape`; list of Sales Nav search URLs (→ jobs, one per URL); paired
GoLogin account per URL; destination sheet URL + new tab name; slow-mode flag;
queue position; per-job status + row counts; per-campaign log lines; running
total rows.

## 11. Decisions (resolved 2026-07-01)

1. **Transition of the old mode — DECIDED:** remove `sales_nav_scrape` from the
   New Campaign wizard the moment the new tab ships (no side-by-side period).
2. **Admin override — DECIDED:** `antonio@ortusclub.com` bypasses the owner
   confirm (flips immediately, still logged as admin). Everyone else gets the
   "not your campaign" confirm. See §7.
3. **Queue model — DECIDED:** the board reflects the **engine's** real queue
   (live `position`/`etaMs`/`state` from `getJobs()`), not the app FIFO. See §6.
4. **Concurrency — DECIDED:** no change to current scrape execution/concurrency
   logic. Whatever the engine does today stays; the board only presents it.

## 12. Architecture (verified 2026-07-01)

Investigation confirmed the scrape engine is a remote GKE service and the app is
a thin HTTP control panel (`src/scraper-client.js`, `/api/scrape/*` in
server.js). This reshapes the work from "build a queue" to "present the engine's
state + persist a campaign wrapper".

**Already exists (reuse, don't rebuild):**
- **Per-job state/position/ETA** — `getJobs()` returns `state`, `pages`,
  `profiles`, `position`, `accountsAhead`, `etaMs`, `tabName`, `searchUrl`, `id`.
- **Pause / resume / stop per job** — `pauseScrape`/`resumeScrape`/`stopScrape`
  (→ engine `/api/scrape/*`). Drives the On/Off toggle and Stop.
- **Live activity logs** — `getLogs(since)` → `{ts, tabName, message}` lines
  (currently held only in an ephemeral in-memory ring, `app.js` ~2589–2604).
- **Owner + operator identity** — queue/history carry `owner`; the current
  operator email is available via `/api/operator-identity`
  (`src/operator-identity.js`). Enough to owner-gate and to detect the admin.

**Must be built:**
- **B1 — Persisted "scrape campaign" record.** Today scrapes fire jobs with no
  saved name/owner/grouping. Persist each launched scrape as a campaign
  (id, name, owner, destination sheet+tab, its job IDs, createdAt) so strips can
  group jobs and gate by owner. New small data file + server routes.
- **B2 — Per-campaign scrape log persistence** for history. Engine logs are
  live-only and operator-scoped; persist them per campaign (NDJSON per campaign
  id, or a scoped scrape log + reader like `readCampaignLog`) so a done/queued
  campaign's Logs tab has content. Live tab still polls the engine.
- **B3 — The board UI itself** (tab, strips, Jobs/Logs tabs, owner toggle +
  confirm + admin bypass, handover visual, Open→setup routing) — the bulk of the
  work, all frontend over the above.
- **B4 — Toggle/action logging** — write toggle + stop actions (with actor) into
  the campaign's persisted log (B2), including the admin tag.

**Explicitly NOT built (per §11.4):** any new scrape queue, drain trigger, or
concurrency control. Scrape scheduling stays entirely on the engine.

## 13. Success criteria

- Sales Nav is reachable as its own tab; setup saves and lands on the board.
- The board shows one running + N queued scrapers in FIFO order with correct
  positions.
- Running strips show Jobs (default) and Logs; queued strips are collapsed to
  summary + toggle with owner-only Open.
- The On/Off toggle arms/disarms; non-owner toggles trigger the confirm and are
  logged with the actor.
- Open routes to the setup page; no Edit button remains.
- Stopping one and launching the next shows the handover banner + strip
  animations end-to-end.
- Everything renders 1:1 with the app skin, no invented fields.
