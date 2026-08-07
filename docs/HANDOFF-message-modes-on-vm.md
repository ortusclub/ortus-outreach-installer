# Handoff — running the message-sending campaign types on the VM

**Author:** Antonio's session, 2026-07-28
**For:** Steven
**Repos:** `ortus-gologin-clone` (the desktop app) + `ortus-salesnav-scraper-cloud` (the GKE engine, aka "the VM")

There are three campaign types that send a message instead of a connection request. The
brief said "message-only", but the three share almost all their plumbing, so this
document covers all of them and flags where they differ:

| Wizard name | Internal mode | What it sends |
|---|---|---|
| **Direct Messages** | `message_only` | A plain 1:1 DM to leads the account is **already connected to** |
| **Message Campaign** | `open_profile_only` | An Open-Profile message (subject + body, reads like an email) to people you are **not** connected to — free, no connection needed |
| **InMail Only** | `inmail_only` | A Sales Navigator InMail (subject + body) — spends an InMail credit |

`introduce_back` (Introduction Campaign) is a fourth sibling — same machinery, but it
composes a 3-way intro thread. Everything below applies to it too.

---

## Part 1 — How the local (desktop) message campaign works, end to end

### 1.1 The wizard

- Mode dropdown: `public/index.html:813-816`.
- Templates:
  - DM body → `#tpl-followup` (`public/index.html:2456`), stored in the payload as
    `templates.followUp1`.
  - InMail → `#tpl-inmail-subject` / `#tpl-inmail-body`.
  - Open Profile → `#tpl-op-subject` / `#tpl-op-body`, plus a **sending channel**
    (`sn_first` / `sn_only` / `ln_first` / `ln_only`) and a *"spend an InMail credit if
    the lead is not an Open Profile member"* checkbox.
  - All of them are collected in `public/js/app.js:1030-1042` and `:6020-6034`.
- **Direct Messages hides the GoLogin account picker.** Instead it shows a "2b. Message —
  Coverage" panel (`public/index.html:1761`) that reads the sheet and shows how many
  connected leads each account owns. It also offers a *"Run Check Status first"* toggle
  (`#preflight-check-toggle-mo`), ON by default.
- `Message Campaign` and `InMail Only` keep the normal account picker (they target cold
  leads, so any account can send).

### 1.2 Which rows get targeted

`src/campaign.js`, inside `_isTarget` (~`:2360-2530`):

- **`message_only`** — single-column predicate: process the row iff **`DM Status` is
  blank**. Any value at all (`DM Sent`, `Failed — …`, an operator note) is terminal.
  There is a bypass (`dmAllConnectedBypass`, `:2377`) for sheets with no `Stage` column
  when the operator ticks "all leads already connected".
- **`introduce_back`** — same, but on `Intro Status`.
- **`open_profile_only` / `inmail_only`** — cold-lead rule: process iff `Stage` is blank.
- The same predicate is **re-checked in the loop right before each send**
  (`src/campaign.js:3517`) so a concurrent operator edit or a sibling worker can't cause
  a double-send.
- `isDmIbEligible()` (`src/campaign.js:540`) is the exported, tested version of the
  "is this row safe to DM" question.

### 1.3 Account routing — the part that matters most

`src/campaign.js:2618-2700`.

`message_only`, `introduce_back` and `check_status` are **auto-routed**: the UI-selected
profile list is *thrown away* and rebuilt from the sheet's sender column
(`Sender` / `Account Used`), because **only the account that connected the lead can DM
it**. Concretely:

1. Fetch every GoLogin profile, build `name → profileId`.
2. For each target row, read the sender name and map it to a profile id.
3. Rows whose sender matches nothing are skipped and reported
   (`⚠ Skipping N row(s) whose Sender is unknown`).
4. `profileIds` becomes the derived list, and `_checkStatusTargetsByProfile` gives every
   profile its **own slice** of rows plus its own cursor — without this, the shared
   round-robin cursor would burn each profile's batch on rows belonging to someone else.

`open_profile_only` / `inmail_only` are **not** auto-routed — the picker is used.

### 1.4 Pacing, caps and batching

This is where the message modes differ hardest from Connect campaigns:

- `NO_DAILY_LIMIT = {check_status, message_only, introduce_back, inmail_only,
  open_profile_only}` (`src/campaign.js:3128`) — **the daily limit does not apply.**
- Inner batch limit is `Infinity` for these modes (`src/campaign.js:3341`) — one browser
  open drains *all* of that account's leads back to back.
- Inter-lead delay is **1–3 seconds**, not 15–45 (`src/campaign.js:4653-4670`,
  `isFastMode`), logged as `⏳ 2s (message — no rate limits apply)`.
- The browser **stays open** between batches (`stayOpen`, `:4724`).

Rationale in the code: messaging existing 1st-degree connections (and free OP messages)
is far lower risk than firing new connection requests, which LinkedIn rate-limits hard.

### 1.5 The optional pre-flight Check Status

`src/campaign.js:2834`. When the toggle is on and the mode is `message_only` or
`introduce_back`, each account runs `bulkCheckConnections()` (one Voyager call listing
that account's recent connections) *before* the send loop. Newly-accepted leads get
stamped `Connected` in the sheet and become eligible for a DM **in the same run** — so
the operator doesn't need a separate Check Status campaign first.

### 1.6 The actual send

`performOutreach(page, url, templates, state, modeHint)` in
`src/linkedin/outreach.js` — **off-limits file, do not edit**.

- `message_only` → `modeHint: 'force_message'`. There's a **fast path**
  (`src/linkedin/outreach.js:304`): because the operator has vouched that the lead is
  already connected, it skips the profile visit, the DOM settle and the degree check
  entirely and goes straight to `/messaging/compose/?recipient=<publicId>` via
  `sendMessage()` (`src/linkedin/actions.js:1395`). Result: `message_sent`.
- Sales Nav URLs (`/sales/lead/AC…`) are rewritten to `/in/AC…` first
  (`outreach.js:254`); legacy `/sales/profile/<numeric>` URLs are skipped with a clear
  reason.
- `inmail_only` → `force_inmail`: rewrites `/in/` → `/sales/lead/` and uses the Sales Nav
  composer. Free if the lead is an Open Profile member, otherwise one InMail credit;
  0 credits → skipped.
- `open_profile_only` → `force_open_profile`: channel-aware landing URL, then
  `sendViaSalesNav`. If the lead is not an Open Profile member it only spends an InMail
  when the operator ticked the box.

### 1.7 Write-back

Per lead, on success: `Stage` = `DM Sent` / `OP Sent` / `InM Sent`, the mode column
(`DM Status` / `OP Status` / `InMail Status`), `Sender` + `Account Used`, and the
date/time. Skips and errors are stamped too, with the reason. SoO credit flip fires for
`inmail_only` / `open_profile_only` (they consume credits); `message_only` flips nothing.

### 1.8 Reply tracking

`_REPLY_MODES = {introduce_back, message_only, connect_and_introduce,
connect_and_message}` (`src/campaign.js:5327`). After sending, the app can sweep inboxes
for replies. `open_profile_only` is deliberately excluded — an OP message isn't a
repliable thread.

---

## Part 2 — How the VM (cloud engine) runs a campaign

Repo: `~/Desktop/Projects/ortus-salesnav-scraper-cloud`. GKE, project
`salesnav-scraper-prod`, region `asia-southeast1`. Currently `scraper:v103`.

- **`campaign-api.js`** — HTTP. `POST /api/campaign/start` creates the campaign row,
  imports the leads, queues it.
- **`campaign-store.js`** — Postgres + Redis. Leads are claimed atomically
  (`claimNextLead`, `:235`, `FOR UPDATE SKIP LOCKED`), so N pods never collide.
- **`campaign-worker.js`** — takes a Redis account lock, opens that GoLogin profile on
  the VM, processes `batchSize` (8) leads, releases, rotates.
- **`campaign-action.js`** — maps mode → `modeHint` + template shape, then calls the
  **vendored copy of the app's own `performOutreach`** in `campaign-lib/linkedin/`.
- **`campaign-runtime.js`** — the glue: `MODE_PLAN` (`:49`) decides per-lead vs batch and
  whether acceptance monitoring is armed; `CampaignScheduler` drives the durable
  `monitor` / `reply` / `follow_up` timers.
- **`campaign-sheet-writer.js`** — pushes each lead's stamp back to the *same* Apps
  Script web app the desktop app uses, translating the engine's terse stage codes into
  the app's exact English wording (`:70-95`).
- **`deploy.sh`** — the only sanctioned way to ship. Refuses a dirty or unpushed tree,
  tags the image `vNN` + `git-<sha>`, commits the k8s manifest bump, rolls both
  deployments.

**Routing hook that already exists:** a lead can carry `route_account` — a pinned
GoLogin profile id. `claimNextLead` will only hand a routed lead to its own account
(`campaign-store.js:236-246`). This is exactly the mechanism the auto-routed modes need,
and it is already used and tested (`test-campaign-routing.js`).

---

## Part 3 — What already exists, and the six real gaps

### Already done (do not rebuild)

1. `CLOUD_MODES` in the app (`src/campaigns-client.js:40`) and the run-target toggle
   (`public/js/app.js:6296`) already list `message_only`, `open_profile_only`,
   `inmail_only`. **The cloud tab is already selectable for all three.**
2. `handleStartCloud` (`server.js:1134`) already treats `message_only` / `introduce_back`
   / `check_status` as auto-routed (`:1149`), resolves each row's sender to a GoLogin
   profile id, sets `routeAccount` per lead, and derives the account pool from them.
3. The template→engine key mapping is there: `message: t.message || t.followUp1`
   (`server.js:1313`), and the OP/InMail keys pass through untouched via `{...t}`.
4. The engine implements every one of these modes in `campaign-action.js` — `message_only`,
   `introduce_back`, `inmail_only`, `open_profile_only` all have specs with the right
   `modeHint`, template shape and outcome sets.
5. Sheet write-back understands the modes' columns and stage wording
   (`campaign-sheet-writer.js:70-113`), and `prepareSheet(mode)` provisions them.
6. `_REPLY_MODES` on the engine matches the app's.

So this is **not** a build-from-scratch job. It is a **verification + parity** job.

### The six gaps found by reading the code

**Gap 1 — no re-send guard (highest risk).**
`campaign-api.js:117` only runs the "already actioned in the sheet, don't touch it" skip
for modes matching `/^connect/`. The app's cloud dispatch applies **no mode eligibility
filter at all** — it builds leads from every sheet row that has a LinkedIn URL, minus the
blocklist. So a `message_only` cloud campaign on a sheet where 200 rows already say
`DM Sent` will **re-DM all 200**. The engine's anti-dupe (`wasActionSent`) is scoped to
one campaign id, so it does not save you across launches. Local does not have this
problem, because `_isTarget` filters on blank `DM Status` before the run.

**Gap 2 — daily cap applied where local exempts it.**
`campaign-worker.js:118` gates every `countsAsSend` mode on `campaign.daily_limit`, and
the app dispatches `dailyLimit: dailyLimit || 50`. Local puts all four message modes in
`NO_DAILY_LIMIT`. A 400-lead DM campaign will stall at 50 per account per day on the VM.

**Gap 3 — pacing is ~15× slower than local.**
`campaign-runtime.js:349` treats only `check_status` as "fast". Message modes get 15–35s
between sends, a batch size of 8, and a 180s cooldown between an account's turns. Local
gives them 1–3s, an unlimited batch, and keeps the browser open. Local drains 400 DMs in
well under an hour; the VM as configured would take days.

**Gap 4 — no pre-flight Check Status.**
The `preflightCheckStatus` toggle is never sent to or honoured by the engine. Leads that
were accepted since the sheet was last updated will be skipped (their sender cell is
blank, or their status is stale). The engine already has `runBulkCheck` in
`campaign-monitor.js`, so this is a wiring job, not new capability.

**Gap 5 — the vendored `helpers.js` has drifted, and it breaks reply tracking.**
`diff campaign-lib/linkedin/helpers.js ../../ortus-gologin-clone/src/linkedin/helpers.js`
→ the engine's copy of `getConversationsPage` is the **old** implementation: it sets
`count`/`start` on a URL whose current LinkedIn query encodes paging inside the
`variables=(mailboxUrn:…)` tuple, which returns **HTTP 400** (verified live 2026-06-29),
and it parses the pre-`normalized+json+2.1` envelope. `campaign-reply-check.js:180` calls
it. So cloud reply tracking for DM campaigns is almost certainly returning zero replies.
`outreach.js` and `actions.js` are byte-identical — only `helpers.js` drifted.

**Gap 6 — nobody has run any of this end to end.** There is no evidence in the logs or
git history of a `message_only`, `open_profile_only` or `inmail_only` cloud campaign
having actually been launched.

### Suggested order

Gap 1 first (it is a correctness bug that will spam real leads), then 5, then 2+3
together, then 4. Gap 6 is the whole point — verify with a small real campaign after each.

---

## Part 4 — Prompt to paste into Claude Code

Copy everything inside the block below into Claude Code, from the repo
`ortus-gologin-clone`, with the engine repo also cloned locally.

```
I'm working on Ortus Outreach. Two repos:
  - the desktop app: ortus-gologin-clone (Electron + Express 4 + vanilla JS, node --test)
  - the cloud engine ("the VM"): ortus-salesnav-scraper-cloud (GKE, Postgres, Redis)

GOAL
Make the three message-sending campaign types work correctly and at a sane speed when
launched on the VM instead of on the operator's Mac:
  - message_only        (wizard: "Direct Messages")
  - open_profile_only   (wizard: "Message Campaign")
  - inmail_only         (wizard: "InMail Only")
introduce_back shares the same machinery — keep it working, fix it where it's affected.

READ THIS FIRST
docs/HANDOFF-message-modes-on-vm.md in the app repo. It documents exactly how these
modes work locally, how the engine runs a campaign, and the six gaps below. Don't
re-derive it; verify it.

WHAT IS ALREADY DONE — DO NOT REBUILD
  - The cloud toggle already accepts all three modes (src/campaigns-client.js:40,
    public/js/app.js:6296).
  - server.js:1134 handleStartCloud already auto-routes message_only / introduce_back /
    check_status: it resolves each sheet row's sender to a GoLogin profile id and pins
    the lead with routeAccount. The engine honours that pin in
    campaign-store.js claimNextLead.
  - The engine already implements all four modes in campaign-action.js, and
    campaign-sheet-writer.js already writes their columns and stage wording.
This is a PARITY + VERIFICATION job, not a from-scratch build.

THE SIX GAPS TO FIX (in this order)

1. No re-send guard. campaign-api.js:117 runs the "already actioned in the sheet" skip
   only for /^connect/ modes, and handleStartCloud applies no mode eligibility filter at
   all. A message_only cloud launch on a sheet where rows already say "DM Sent" will
   re-DM every one of them. Local never does this — src/campaign.js _isTarget requires a
   blank DM Status (blank Intro Status for introduce_back, blank Stage for OP/InMail).
   Fix it so re-sends are impossible. Prefer fixing it ONCE, engine-side, where all
   callers route through, rather than only in the app's dispatch.

2. Vendored primitive drift. Run:
     diff ortus-salesnav-scraper-cloud/campaign-lib/linkedin/helpers.js \
          ortus-gologin-clone/src/linkedin/helpers.js
   The engine's getConversationsPage is the old implementation — it adds count/start
   params that make LinkedIn return HTTP 400, and parses the pre-normalized+json+2.1
   envelope. campaign-reply-check.js:180 depends on it, so cloud reply tracking for DM
   campaigns is broken. Re-sync the file byte-identical to the app's. HARD RULE for this
   repo: campaign-lib/* must mirror the app's src/linkedin/* exactly — every cloud bug
   we've had has been a divergence. Never "simplify" the port.

3. Daily cap. campaign-worker.js:118 gates on campaign.daily_limit for every
   countsAsSend mode, and the app sends dailyLimit || 50. Local exempts all four message
   modes (src/campaign.js:3128 NO_DAILY_LIMIT). Match local.

4. Pacing. campaign-runtime.js:349 treats only check_status as "fast", so message modes
   get 15–35s between sends, batchSize 8, and a 180s between-turn cooldown. Local gives
   them 1–3s and an unlimited inner batch (src/campaign.js:3341, :4653). As configured,
   a 400-lead DM campaign takes days on the VM and under an hour locally. Match local.

5. Pre-flight Check Status. The wizard's "Run Check Status first" toggle
   (#preflight-check-toggle-mo, honoured at src/campaign.js:2834) is never sent to or
   honoured by the engine, so leads accepted since the sheet was last written get
   skipped. The engine already has runBulkCheck in campaign-monitor.js — wire the flag
   through the dispatch payload and run the sweep per account before the send loop.

6. Nothing here has ever been run end to end. After the fixes, launch a real cloud
   campaign on a small test sheet (3–5 leads) for each of the three modes and confirm:
   the right account sends (auto-routing), the message actually arrives, the sheet gets
   Stage + the mode column + Sender/Account Used stamped, already-stamped rows are NOT
   re-sent on a second launch, and for message_only that replies are detected.

HOW TO WORK
  - Use the systematic-debugging skill. Investigate and gather evidence before changing
    code — no guessing, no "try this and see".
  - src/linkedin/outreach.js and src/linkedin/actions.js in the app are OFF-LIMITS.
    Don't touch them. src/linkedin/helpers.js is fine.
  - Tests are node --test in the app; plain node test-*.js scripts in the engine (they
    need PG_URL + REDIS_URL against the local docker Postgres/Redis). Add a test for
    each fix; the engine's existing test-campaign-message.js and test-campaign-routing.js
    are the patterns to copy.
  - App: bump the patch version in package.json AND the ?v= query string in
    public/index.html before relaunching, every time.
  - Engine: a change is NOT delivered until it's deployed. Commit, push, then run
    ./deploy.sh from the engine repo — it refuses a dirty/unpushed tree, tags the image
    vNN + git-<sha>, commits the k8s bump, and rolls both deployments. Do that as part
    of the task; don't finish by telling me it still needs deploying. You'll need
    `gcloud auth login` once.
  - Ortus runs ONE campaign at a time — don't design anything that assumes parallel
    campaigns.

Start by confirming or refuting each of the six gaps against the actual code, then tell
me your plan before you change anything.
```
