# Follower Growth Phase 2 — Invite Automation Design

**Date:** 2026-06-23
**Branch:** `team-connections-mvp`
**Builds on:** Phase 1 (`2026-06-23-follower-growth-campaign-design.md`) — the FG campaign type, Connections-DB target builder, central FG sheet, and `/api/fg/*` routes are all shipped (v2.113.4).
**Status:** Design approved (brainstorm 2026-06-23, artefacts + flow confirmed by Antonio).

## Goal

Automate the manual step in Phase 1: instead of the operator hand-inviting each queued person on LinkedIn, a **dedicated automation module** drives the operator's GoLogin browser to open the page's "Invite to follow" modal, tick the queued (identity-verified) people up to the live credit cap, click Invite, and mark them `Invited` in the FG sheet.

## Architecture (2-3 sentences)

A **new, self-contained module** `src/linkedin/follower-invite.js` — modeled on the structure of `src/linkedin/post-amplification.js` (a page-level LinkedIn UI-action module) but entirely its own file. It reuses **only shared helpers** (`src/linkedin/helpers.js`: `randomDelay`, `clickByText`, `clickByAria`, `resolvePublicIdByName`) and the **shared launcher** (`launchProfile` in `gologin-launcher.js`) — it **never touches the off-limits `outreach.js` / `actions.js`**. It is triggered by new `/api/fg/send/*` routes that mirror the proven `/api/post-amplification/*` run pattern (start → background run → status polling → stop), surfaced as a "Send invites automatically" button in the FG workspace.

## Tech Stack

Node ≥22, puppeteer-core (via the GoLogin Orbita profile), Express 4, vanilla-JS UI. Reuses `launchProfile()`, `helpers.js`, and the Phase-1 `fg-sync.js` (`markFgInvited`, `getFgState`). New dedup/run state file `data/fg-invite-state.json` (atomic write, like post-amplification's state).

---

## Confirmed facts & decisions (brainstorm 2026-06-23)

- **The invite modal** opens at `https://www.linkedin.com/company/<pageSlug>/?invite=true` (equivalent to Page "…" → "Invite connections"). It is an `artdeco-modal` in `#artdeco-modal-outlet`; body gets class `artdeco-modal-is-open`.
- **Live credit cap:** the modal shows "**X/30 credits available · Credit refill <date>**". The pool is **30/month**, refilling monthly. The automation **reads the live X** and treats it as the authoritative cap (never relies on a hardcoded number).
- **Modal contents:** a "**Search by name**" input, filter chips (Locations / Current company / School — not used), and a scrollable list of the operator's 1st-degree connections, each a row with **name + headline + photo + a checkbox**, and an **Invite** button (disabled until ≥1 selected).
- **Match precision (LOCKED):** search by full name, then among the **invitable** results (`--can-invite`):
  - **exactly one name match → select it directly** (no headline check needed — a unique name is unambiguous);
  - **multiple same-name matches → disambiguate by headline** (the result whose headline contains the FG row's job-title token or company); if none/several still match → **skip** (log `FG Note: ambiguous in modal`);
  - **zero name matches → skip** (`FG Note: not found in modal`).
  Headline verification only kicks in when there's genuine name ambiguity, so we never wrongly skip a uniquely-named person, and never risk the wrong connection on duplicates.
- **Source of who to invite:** that operator's **`Queued`** rows in the FG sheet (Phase-1 output), capped at the live credit count.
- **On send:** the bot **marks the sent people `Invited`** (via `markFgInvited`) + decrements budget — it knows exactly who it ticked.
- **Concurrency:** one operator/session at a time (the app's one-campaign-at-a-time rule).
- **Off-limits:** `src/linkedin/outreach.js` and `src/linkedin/actions.js` are NOT touched.

---

## Components

### `src/linkedin/follower-invite.js` (new)
Exports (mirroring post-amplification's testable-helper + orchestrator split):
- `openInviteModal(page, pageSlug, { log })` → navigates to `?invite=true`, waits for the modal, returns `{ ok }`.
- `readCreditsAvailable(page)` → parses "X/30 credits available" → integer `X` (0 if unreadable).
- `searchAndMatch(page, person, { log })` → types `person.name` in the search box, waits for results, returns the matching row handle or `null`. **Selection rule:** collect the invitable results (`--can-invite`) whose name matches `person.name`; **one** match → that row; **several** → the one whose headline verifies via `headlineMatches`; if still 0 or >1 → `null` (skip, logged). The pure decision is extracted as `pickInviteResult(results, person)` (results = `[{name, headline, canInvite}]`) for unit testing, alongside `headlineMatches(headlineText, { jobTitle, company })`.
- `tickRow(page, rowHandle)` → clicks the row's checkbox; returns success.
- `clickInvite(page)` → clicks the modal's Invite button (via `clickByText(page, 'Invite')` scoped to the modal), confirms it was enabled.
- `runFollowerInvites({ profileId, token, pageSlug, operator, queued, log, shouldAbort })` → the orchestrator: launch is done by the caller (route) which passes the `page`; loops queued people up to live credits, human-paced (`randomDelay`), tick-verified, clicks Invite once, returns `{ invited: [...memberIds], skipped: [...], creditsBefore, creditsAfter }`.

Dedup/run state (`data/fg-invite-state.json`, atomic write): tracks the in-flight run so `status` can report progress and a re-run won't double-process. Memberids already `Invited` in the sheet are never re-ticked (Phase-1 dedup already excludes them from new builds; this is a second guard).

### `helpers.js` — `headlineMatches` candidate
`headlineMatches(headlineText, { jobTitle, company })`: lowercased substring test — true if the headline contains the company token, or a significant word from the job title (e.g. "marketing", "growth"). Conservative: empty/whitespace headline → false. (Lives in follower-invite.js unless it's clearly reusable.)

### Routes (`server.js`) — mirror `/api/post-amplification/*`
- `POST /api/fg/send/start` — body `{ operator, pageSlug? }`. Resolves the operator's GoLogin profile (the account whose network this is), pulls that operator's `Queued` rows from `getFgState()`, launches the profile, runs `runFollowerInvites`, then on each successful batch calls `markFgInvited`. Runs in the background; guarded by a single-run lock (like post-amp + one-campaign-at-a-time). `pageSlug` defaults to the Ortus Club page slug (config constant).
- `GET /api/fg/send/status` — `{ running, phase, invited, skipped, creditsBefore, creditsAfter, error }`.
- `POST /api/fg/send/stop` — cooperative abort (`shouldAbort`), like post-amp stop.

### UI (`index.html` + `app.js` + `style.css`)
- A **"Send invites automatically"** button in the FG workspace step 2 (alongside Queue / Mark all). Disabled unless there are `Queued` rows for the selected operator.
- A small **live status strip** while running (phase + "ticked N of M · credits X→Y"), polling `/api/fg/send/status` (reuse the post-amp polling pattern).
- On completion, refresh the DB view (the sent rows now show `Invited`).

---

## Operator → GoLogin profile mapping

The FG campaign already selects an `operator` (colleague email). The inviting LinkedIn account = the GoLogin profile tied to that operator. **Open item:** confirm how operator email → GoLogin profileId resolves (the app's account picker maps profiles to LinkedIn accounts/emails; reuse that mapping). Until confirmed, `start` accepts an explicit `profileId` (the operator selects their account in the picker, as other campaigns do).

## Safety / pacing

- Jittered human delays between every search/tick/scroll (`randomDelay`), longer pause before the final Invite click.
- Reads + respects the **live** credit count; never exceeds it; stops early if credits hit 0.
- **Skip-on-doubt** matching (no wrong-person ticks).
- Cooperative abort via `shouldAbort` (the Stop button).
- One run at a time (single-run lock + one-campaign-at-a-time).
- First live run is a **calibration run**: the module logs every step (modal opened, credits read, each search's result count + match/skip decision, Invite click) so any LinkedIn-DOM selector that needs tuning surfaces immediately in the log rather than failing silently. LinkedIn's modal DOM is outside our control; defensive selectors (placeholder/aria/text via helpers) + verbose logs are how we converge.

## Out of scope (Phase 2)
- Multi-operator parallel sending (one at a time).
- Follow-conversion tracking (still just "invited", per Phase 1).
- Auto-scheduling/cron of FG sends (manual trigger only for now).

## Open items
- Confirm the **Ortus Club page slug** for the `?invite=true` URL (config constant).
- Confirm operator-email → GoLogin-profileId resolution (else operator picks the account explicitly).
- The exact modal inner-DOM selectors (search input, row checkbox, Invite button) will be confirmed/tuned on the first calibration run; the build uses defensive artdeco-convention selectors via `helpers.clickByText`/`clickByAria` + placeholder matching.
