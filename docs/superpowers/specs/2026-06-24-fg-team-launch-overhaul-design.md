# Follower Growth — Team Launch board overhaul (variant A)

**Date:** 2026-06-24
**Status:** Design — approved for planning
**Sketch:** `public/sketches/fg-overhaul-A-cart.html` (Browse + Launch cart, chosen)
**Supersedes:** the current Team Launch board built in
`docs/superpowers/specs/2026-06-23-fg-team-launch-design.md` (the two-zone
employee/profile board on branch `fg-team-launch-2116`). The engine, routes, and
write-back from that work are kept; only the panel UI + the colleague endpoint change.

## Problem

The shipped Team Launch board is unusable at the team's real size:

1. You can't see who you've picked — selection is just scattered ticks in a long list.
2. It shows each colleague's **total** connections, not how many **match the role
   keywords** — and the match count is the only number that decides whether a launch
   does anything (most skips were "0 targets" because of this).
3. You can't see how many invites each picked account can actually send (budget).
4. It's overwhelming — two dense columns, a big always-present empty card, and the
   GoLogin profiles panel all at once.
5. The Follower Growth database (Invites/Budgets/Funnel) is shown at all times and
   confuses the launch task.

## What we're building

Replace the `#nav-follower-growth` board with the **Browse + Launch cart** layout:

1. **Role chips** (Step 1) — unchanged behaviour; the keywords that define "matched".
2. **Browse list (left)** — scrollable, searchable list of colleagues. Each row shows
   the colleague, **MATCHED** connections as the headline number, total in DB as
   secondary, whether they auto-pair, and a **+ add** button. Rows with 0 matched are
   disabled ("no match").
3. **Launch cart (right, sticky)** — the people you've added, each showing their paired
   GoLogin account (or a **searchable picker** — search box + scrollable radio list,
   *not* a native dropdown — with **Local Browser** pinned first), and **invites-left**
   = `min(matched, budgetRemaining)`. A running total (people · invites this run) and
   the **Launch all** button (disabled until every picked person has an account).
4. **Live card** — the real `vj-card`, appearing once the cart is non-empty (idle
   "Ready to launch" state), animating per-account on launch. Same chrome as other
   campaigns.
5. **Database** — Invites/Budgets/Funnel collapsed behind a "▸ View database" toggle,
   hidden by default.

## Data — the one new piece

The board needs **matched connections per colleague for the current role keywords**,
recomputed when the chips change.

New service helper `listFgColleaguesMatched(keywords, { dir, cachePath })` in
`search-service.js`:

- One pass over the annotated DB. For each non-DNC contact, if
  `matchesCriteria(contact, { jobTitles: keywords })`, increment a `matched` counter
  for every email in its `warmVia`. Always increment a `total` counter (non-DNC) per
  warmVia email (same as today's `listFgColleagues`).
- Returns `[{ email, name, total, matched }]` sorted by name.
- Empty/absent keywords → `matched === total` (no role filter).
- Performance: the costly step is the memoized annotate (~3s, already paid on first
  load); the pass itself is a few ms. Acceptable to recompute per keyword change.

New route `GET /api/fg/colleagues?roles=marketing,brand,…`:

- Parses `roles` (comma-separated, optional), calls `listFgColleaguesMatched`, returns
  `{ colleagues: [{ email, name, total, matched }] }`.
- **Backward compatible:** with no `roles` param it still returns the roster (matched
  omitted or equal to total). The existing no-arg callers keep working.

Budget remaining per account is already available via FG Budgets (`fgRemaining`,
already loaded into the frontend through `_fgDb.budgets` / `fgAccountCredit`). The cart
computes invites-left client-side: `min(matched, budgetRemaining(pairedAccount))`.

## Frontend

Rebuild the `#nav-follower-growth` panel markup to the variant-A layout (role chips,
browse list, sticky cart, the existing `vj-card`, collapsed DB). Reuse the real
`vj-card` markup/IDs already present from the prior build; reuse `v3RenderLogLine` for
the live log; keep `.chip-tag` for role chips.

`app.js` Team Launch state/functions are reworked for the cart model:

- State: `fgtlPeople` (`[{email,name,total,matched,paired}]`), `fgtlPicked`
  (`email -> {profile, pq, changing}` — the cart), `fgtlChips`, `fgtlBudgets`.
- `initFollowerGrowth()`: load FG DB (budgets) → fetch `/api/fg/colleagues?roles=…`
  with current chips → render browse list + cart.
- Changing role chips re-fetches matched counts (debounced) and re-renders.
- Browse: search filter, **+ add** moves a person into `fgtlPicked`.
- Cart: per-person searchable profile picker (Local Browser pinned), remove, running
  totals, invites-left; Launch disabled until no gaps.
- Auto-pair by email (existing convention: GoLogin profile name === colleague email).
- Launch → existing `POST /api/fg/team-launch/start` with the paired set → poll
  `/status` → drive the `vj-card` (the engine and write-back are unchanged).

## Reused unchanged (from the prior build)

- Engine `src/connections/fg-team-launch.js` (`runTeamLaunch`, sequential, one browser).
- Routes `/api/fg/team-launch/{start,status,stop}`, `_fgTeam` status, the specific
  skip reasons, write-back (`queueFgInvites` + `markFgInvited`), Local-Browser launch.
- `buildFgTargets` and its `matched`/`eligible`/`count` return.

## Out of scope

- Changing the engine, write-back, DNC, budget, or Apps Script schemas.
- True parallel sends (still sequential).
- Persisting cart state across app restart.
- Caching matched-counts beyond the existing annotate memoization.

## Success criteria

- The board shows, per colleague, MATCHED connections (headline) and total; changing
  role chips updates the matched numbers.
- Added people appear in the cart with their account and invites-left
  (`min(matched, budget)`); Antonio shows 0 (budget exhausted).
- The GoLogin picker is a searchable list with Local Browser pinned — no native dropdown.
- The Follower Growth database is hidden until its toggle is opened.
- Launch runs the paired accounts sequentially and drives the live `vj-card`; the prior
  engine/write-back behaviour is unchanged.
- `GET /api/fg/colleagues` with no `roles` param still returns the roster (no regression).

## Risks

- **Matched recompute latency:** first call pays the annotate cost (~3s, memoized). If
  it ever feels slow on chip changes, debounce (already planned) and show a subtle
  "updating…" state — but do not pre-cache per-keyword.
- **Endpoint compatibility:** `/api/fg/colleagues` is already consumed; the `roles`
  param must be additive so existing callers don't break.
