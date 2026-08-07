# Follower Growth on the VM — handoff for Mickey

**Written:** 28 July 2026
**Repos:** `ortus-gologin-clone` (the Electron app) · `ortus-salesnav-scraper-cloud` (the GKE engine)
**Audience:** Mickey, picking up Follower Growth cloud ownership.

---

## Read this first

Follower Growth is **not** in the same state as the messaging campaigns. It is **already
built, already deployed, and already running on the VM on a schedule.** Every FG run the
team fires today goes through the cloud engine, and an Auto-Pilot CronJob fires it
unattended on the 1st and 15th at 06:00 London.

So this is **not** a "make it work on the VM" job. It's an **ownership + gap-closing** job.
The five gaps in Part 3 are real and verified against the code, and every one of them is
about the **sheet write-back and the de-dupe ledger** — not about the sending itself. The
sending works.

---

# Part 1 — How Follower Growth works

## 1.1 What the campaign actually does

LinkedIn Company Pages have an "Invite to follow" tool. A Page **admin** gets a monthly
allowance of **30 invite credits**. Each credit invites one of that admin's own 1st-degree
connections to follow the Ortus Club page. When the invitee accepts (or the invite is
withdrawn) **the credit comes back** — so the balance is a parking lot, not a monthly spend
counter. This is why the app reads the live number off the modal rather than computing
`30 − sent`. (See `feedback_fg_credit_parking_lot_model` in memory.)

The whole campaign is therefore:

1. Pick **which of our people's networks** to mine (each operator's own connections).
2. Filter those connections by **role keywords** (defaults toward marketers).
3. Drop anyone already invited / already following.
4. For each account: open the Page invite modal, type each person's name, tick the ones
   that match, hit **Invite** once for the whole batch.
5. Write back who got invited, and what the account's live credit balance is.

Note step 4: this is a **batch** mode, not a per-lead mode. One modal session invites up to
30 people with a **single** Invite click. That structural difference is why FG has its own
runtime branch in the engine instead of going through the per-lead worker.

## 1.2 The browser primitive — `src/linkedin/follower-invite.js`

This is the only file that touches LinkedIn. 306 lines, self-contained, imports only
`randomDelay` and `getSenderUrn` from `helpers.js`. It deliberately does **not** touch
`outreach.js` / `actions.js` (both off-limits).

Key exports and the reasoning baked into them:

| Function | What it does | Why it's written that way |
|---|---|---|
| `parseCreditsAvailable(text)` :7 | `"5/30 credits available"` → `5` | The **leading** number is what's available now. |
| `parseCreditsMeta(text)` :16 | → `{available, allowance, refill}` | The refill date is shown to operators so a 0-credit account reads as "comes back on X", not "broken". |
| `pickInviteResult(results, person)` :53 | Chooses which search result to tick | Exactly one invitable name match → take it. Several → the one whose **headline** verifies (company token, or a ≥4-char non-generic title word). 0 or ambiguous → skip. **Never guesses.** |
| `firstLastMatches` :43 | `"Katie Jackson"` ↔ `"Katie Whitty Jackson"` | LinkedIn shows middle names our records omit. Only widens the candidate set; the guards above still disambiguate. |
| `classifySkip` :68 | `'already-follows'` vs `'no-match'` | If a name matched but `canInvite` is false, they already follow or were already invited — **costs no credit** and must be remembered so it never re-fills a slot. This distinction is load-bearing; see gap 4. |
| `waitForModalContent` :94 | Polls for the search box | The modal mounts in two stages — shell first (credits line), interactive body ~1.5s later. Waiting only for the credits text returned too early and the first send crashed. Bails instantly on "No remaining invite credits". |
| `openInviteModal` :134 | goto + login check + wait | Two logged-out detectors: URL redirect (`isLoggedOutUrl`) **and** a Voyager `/me` probe with one retry — LinkedIn sometimes serves a login wall at the *same* URL. Then up to **2 min** for the modal, because a real admin on a slow laptop looks identical to a non-admin. `InviteModalUnavailableError` is an honest "couldn't open it", explicitly **not** a "not an admin" claim. |
| `selectPerson` :207 | Type name → scrape → pick → click | Force-clears the search box via the native value setter + `input` event. Triple-click select-all is unreliable on the **VM's headless browser**; without this every name appended to the last, LinkedIn returned nothing, everyone got skipped. This bug was found on the VM. |
| `runFollowerInvites` :264 | Orchestrator | Reads credits, loops the queue selecting people, stops at `creditsBefore`, then **one** `clickInvite`. If the button never clicked, `sent=false` and **everything** is reported as skipped — nothing went out. |

Return shape:
```js
{ invited:[memberId…], skipped:[…], alreadyFollowing:[…],
  creditsBefore, creditsAfter, allowance, refill, sent }
```

## 1.3 Where the targets come from

The connections database (~152 MB SQLite-ish store under `src/connections/`) is **not** on
operator laptops. So target building goes through `dbCall('buildFgTargets', …)`, which runs
locally if the DB is present and otherwise RPCs the central **fg-roster** service, which
runs the app's *real* `search-service.js` against a copy pulled from GCS. Same match code
either way — that was the whole point of the roster service.

`buildFgTargets` is DNC-safe, keyword-filtered, scoped to **one operator's** network, and
deduped against `alreadyInvited`.

**Budget note (`server.js:2374`):** `fgRemaining()` deliberately returns the full 30 every
time and ignores the sheet's "sent" count. Credits refill on accept/withdraw, so
`allowance − sent` is wrong. Build a full pool of candidates; let the **live modal number**
cap the actual sends.

## 1.4 The FG Google Sheet (central, one for everyone)

Written through the FG Apps Script (`postFg`, `src/connections/fg-sync.js`). Tabs:

- **FG Invites** — the historical ledger. `invitedKeysFromState()` :71 reads it: rows with
  `Status === 'Invited'` → their Member ID (or URL). **This is the de-dupe source for
  Generate.** Remember this — gap 1 is entirely about this tab not getting fed.
- **FG Budgets** — per-account credit state. `observeFgCredits()` :149 writes the modal's
  real `available` / `allowance` / `refill` / observed-at. Authoritative over any estimate.
- **FG Funnel** — reporting.
- **`FG <YYYY-MM-DD>` run tabs** — one per run, created by Generate. This is the new model:
  the tab is **both** the editable intent list **and** the ledger the reconcile stamps back
  into. Header (`FG_LIST_HEADER`, `fg-list.js:18`):
  `First Name · Last Name · LinkedIn URL · Job Title · Company · Account Email · Status ·
  Invited At · Note · Member ID`.
  Tab name encodes the run day, so Run ID / Month need no columns.

## 1.5 The two operator flows

Both live in the FG wizard (`public/index.html:2211`, `#nav-follower-growth`).

**Step 1 — Build your invite list.** Two paths into the *same* tab:
- **A · Auto-generate** — role chips + pick whose networks → `POST /api/fg/list/generate`
  (`server.js:2672`) → `buildListRows` → `writeFgList(tab, rows)`.
- **B · Bring your own** — operator supplies a tab with those columns. `parseListRows` is
  tolerant of column order and wording (`HEADER_ALIASES`, `fg-list.js:26`).

The tab is reviewable and hand-editable before it fires — that is the design intent.

**Step 2 — Fire.** `POST /api/fg/team-launch/start` (`server.js:2723`) with
`target: 'local' | 'cloud'` and `source: 'list'` when a tab exists.

### Local path (`target: 'local'`) — `runTeamLaunch`, `fg-team-launch.js:24`

Sequential, one browser at a time (multi-browser crash constraint). Per pair:
`buildTargets` → `launch` (GoLogin or local browser) → `runFollowerInvites` →
`record` → `observeCredits`.

Two write-backs that matter:

```js
// fg-team-launch.js:45-49 — invited AND already-follows into the SAME store so the
// next build dedupes both out; already-follows cost no credit and must never re-fill a slot.
if (invitedIds.length || alreadyFollowingIds.length) {
  await deps.record({ rows, invitedIds, alreadyFollowingIds, account, operator, month });
}
// :55-59 — the modal's REAL post-run available count, even when 0 were sent.
if (deps.observeCredits && Number.isFinite(out.creditsAfter)) { … }
```

`record` (`server.js:2835`) does `queueFgInvites(rows)` then `markFgInvited(ids)` — so
**FG Invites gets the row and the Invited stamp**. On a sheet failure it logs a loud
`⚠ STRANDED` but does **not** abort the account: the invites really went out on LinkedIn,
and mislabelling them as errors would be worse.

Stop is a real stop: `_fgActiveHandle` is force-closed so an in-flight 2-min modal wait
rejects immediately (`server.js:2610`).

### Cloud path (`target: 'cloud'`) — see Part 2.

---

# Part 2 — How Follower Growth runs on the VM

## 2.1 Dispatch

`source: 'list'` (the current path, and the only one Auto-Pilot uses):
`readFgList(tab)` → `dispatchFromRows` (`fg-list-launch.js:64`) → `parseListRows` → engine
leads, each **pinned to its account**:

```js
leads.push({ leadUrl: url, fullName, memberUrn: null,
             routeAccount: profileId,           // ← resolved from Account Email
             row: { memberId, name, company, title, accountEmail, status } });
```

→ `startCloudCampaign({ mode:'follower_growth', name, owner, profileIds, leads,
config:{ inviteUrl, monthlyBudget } })`.

Note the config: **no `sheetUrl`, no `sheetsWebappUrl`.** That is deliberate — the FG sheet
is a different sheet behind a different Apps Script, so the engine's generic sheet writer
is a no-op for FG (`provisionSheet`/`syncSheet` both return early without those two keys,
`campaign-runtime.js:171-186`). **All FG write-back is app-side reconcile.** That fact
drives gaps 3 and 5.

The run is registered in `data/fg-cloud-runs.json` with `kind: 'list'` and the tab name
(`server.js:2750`). Never `git add` that file.

Legacy path (no tab): `startTeamLaunchCloud` (`fg-cloud-launch.js:172`) — builds targets
app-side, dispatches, writes "Queued" proof rows to **FG Invites** at launch, and
`markFgInvited` at reconcile. Still present, no longer the default. **Its write-back is the
one that's correct** — it's the pattern gap 1 needs.

## 2.2 The engine batch branch — `campaign-runtime.js:229-343`

`MODE_PLAN.follower_growth = { kind: "batch" }` :58. The per-lead `CampaignWorker` (locks,
delays, daily caps, turn cooldowns) is **not** used. Instead, for each account in
`profile_ids`:

1. **Bench check** — `store.getFgBench(campaignId, account)`. An account benched earlier in
   this run is skipped **without opening a browser**. Re-checked next run (credits refund).
2. **Credit bench** — if a stored reading says 0 for this campaign, bench + skip.
3. `acquireAccount` (cross-pod lock) → `openSession` → register with the live registry
   (streams the browser to the app's campaign card).
4. `runFollowerGrowth(…)` — the batch.
5. Persist the credit reading (`store.setCredits`), narrate to the app-visible log
   (`💳 … 3 invite credits available`, `✅ … 12 invites sent · credits 30→18`).
6. Bench anything that did nothing useful, with the reason: `logged out — needs re-login`,
   `no invite credits · refills <date>`, or the runtime's own reason.
7. Unregister, close session, release the account lock.

After the loop: if no leads pending → `done`. If leads remain but the **whole pass sent
zero** (every account benched) → log `⏹ No invites could be sent this run…` and stop, rather
than looping browsers forever.

## 2.3 `campaign-followergrowth.js` — the engine's FG orchestration

142 lines. Two budgets, in this order:

**Budget 1 — monthly engine budget.** `store.invitedCountForMonth(account, month)`
(`campaign-store.js:454`) counts `stage='Invited'` **across all campaigns** from the leads
table, restart-proof:

```sql
SELECT count(*) FROM leads
 WHERE assigned_profile=$1 AND stage='Invited'
   AND sent_at >= to_date($2,'YYYY-MM')
   AND sent_at <  to_date($2,'YYYY-MM') + interval '1 month'
```

**Budget 2 — LinkedIn's live credits**, enforced inside `runFollowerInvites`
(`if (invited.length >= creditsBefore) break`).

Then: claim up to `remaining` pending leads via `claimNextLead` (which enforces the routing
gate — `route_account = '' OR route_account = $2`, `campaign-store.js:239`), skipping any
with a campaign-scoped `wasActionSent(…, 'invite')` marker; map them to the modal's queued
shape with `memberId = lead.id` so the primitive's echo maps back unambiguously; run the
batch; stamp outcomes.

Outcome contract:

| Primitive result | Engine action |
|---|---|
| invited | `markLead('sent', {stage:'Invited'})` + `markActionSent(…,'invite')` |
| skipped, already-follows | `markLead('skipped', {error:'already follows the page'})` + `markActionSent` |
| skipped, no match | `markLead('skipped', {error:'no unambiguous match in invite modal'})` |
| `sent === false` | **every** claimed lead `releaseLeadToPending` — nothing went out |
| thrown (logged out / modal error) | release all claimed, flag `loggedOut` |

## 2.4 Write-back — app-side reconcile

`reconcileFgCloudRuns()` (`server.js:2566`) runs at app startup and on a 30-second timer,
guarded against overlap. Per record:

- `kind: 'list'` → `reconcileListRun` → `getCloudCampaignLeads` → `ledgerUpdatesFromLeads`
  (`fg-list.js:94`) → `updateFgListLedger(tab, updates)`. Idempotent, delta-only; pending
  leads produce no update. Stamps `Status` / `Invited At` / `Note` / `Member ID` into the
  run's own tab. Retired once the campaign is terminal.
- legacy → `reconcileCloudRun` (`fg-cloud-launch.js:113`) → `markFgInvited` per account +
  `markFgFailed` for whatever stayed Queued, with per-lead reasons (`fgFailureReasons`
  :149 deliberately refuses to guess logged-out-vs-out-of-credits — reconcile only sees
  leads, not per-account FG results, so a specific claim there would be fabrication).

It also **adopts Auto-Pilot runs** dispatched cloud-side while the app was closed:
`GET {FG_ROSTER_URL}/admin/autopilot` → `pickUnreconciled(runs, localIds)` → added to the
local reconcile pipeline (`server.js:2591-2603`).

## 2.5 Auto-Pilot — the unattended path

**The service source lives in the APP repo**, not the engine repo:
`ortus-gologin-clone/services/fg-roster/`. It deploys to the **same GKE cluster** as the
engine, behind `scraper.ortusclub.com/fg-roster` (`k8s/05-ingress.yaml:24`).

| File | Role |
|---|---|
| `server.js` | Pulls the connections DB from GCS, points `search-service.js` at it, wires everything |
| `app.js` | HTTP surface: `/fg-roster/health`, `/rpc`, `/admin/refresh`, `/admin/autopilot-config`, `GET+POST /admin/autopilot` |
| `autopilot.js` | `shouldFire(now, config, ranKeys, tz)` → read the run's tab → `dispatchFromRows` → record + email alert |
| `config-store.js` / `mailer.js` / `pull-db.js` | Config persisted to GCS · alert email · DB pull |

k8s (in the **app** repo, `k8s/fg-roster/`): `deployment.yaml` (image `fg-roster:v4`,
Workload-Identity SA with `storage.objectViewer`), `service.yaml`, `secret.example.yaml`,
and `cronjob.yaml` — a daily 06:00 Europe/London POST to
`http://fg-roster.salesnav-scraper.svc.cluster.local/fg-roster/admin/autopilot`. The cron
runs **daily**; `shouldFire` is what gates it to days `[1, 15]`.

The fire **reads a pre-generated tab**. It does not build the list itself. No tab → email
alert "no invite list for FG YYYY-MM-DD", no dispatch. That's a design decision (the list
must be reviewable), but it means **someone has to press Generate before each cycle.**

`/api/fg/autopilot` in the app proxies the service read-through so `FG_ROSTER_TOKEN` never
reaches the browser, and degrades gracefully (computes a next-run date locally, sets
`degraded: true` so the client won't publish a guessed config over the real one).

---

# Part 3 — State of play, and the gaps

## 3.1 Already done — do NOT rebuild these

1. **Engine implements FG as a first-class batch mode.** `MODE_PLAN` :58 +
   `campaign-followergrowth.js`. Complete, with its own tests
   (`test-campaign-followergrowth.js`).
2. **The browser primitive is byte-identical app ↔ engine.** Verified 28 July 2026:
   `diff src/linkedin/follower-invite.js campaign-lib/linkedin/follower-invite.js` → clean.
   It had drifted once and was re-synced; **always diff before assuming.**
3. **`helpers.js` drift does not affect FG.** The two files differ (~280 lines), but the
   drift is `normalizeSalesNavThreads` / `getSalesNavThreadsPage` only. The two functions FG
   uses — `randomDelay` and `getSenderUrn` — are byte-identical. Verified. **Don't chase
   this.**
4. **Per-account routing works end to end.** Account Email → profileId → `routeAccount` →
   `claimNextLead`'s `route_account` gate. An account can only ever invite its own people —
   which is a hard LinkedIn requirement, not a nicety.
5. **The monthly budget is durable and cross-campaign.** `invitedCountForMonth` reads the
   leads table, so a pod restart or a second campaign can't forget spend.
6. **Benching + narration are good.** Zero-credit, logged-out and did-nothing accounts are
   benched for the run with an operator-readable reason, and a fully-benched pass ends the
   run instead of reopening browsers in a loop.
7. **Live per-person ticks** stream to the campaign card (`onProgress` → `liveRegistry`).
8. **Ledger write-back into the run's own tab** is idempotent and delta-only.
9. **Auto-Pilot is deployed and firing** — service + CronJob + config in GCS + email alerts.

## 3.2 The gaps

Every one of these is about **the ledger**, not the sending. Verified against the code.

---

### Gap 1 — list runs never feed the de-dupe source *(highest impact)*

`/api/fg/list/generate` dedupes with
`alreadyInvited = invitedKeysFromState(snap.invites)` (`server.js:2680`), which reads **FG
Invites** rows with `Status === 'Invited'` (`fg-sync.js:71`).

The list path never writes that tab. `reconcileListRun` only calls `updateFgListLedger`
(the run's own tab). `queueFgInvites` / `markFgInvited` are never called. In
`services/fg-roster/autopilot.js:11-20`, `queueInvites` and `getFgState` are **passed in by
`server.js:40` but never destructured or used** — the comment says the de-dupe "now happens
at Generate time", which is true, but Generate reads a tab nothing populates any more.

**Consequence:** every Generate re-lists people invited in previous cycles. It does **not**
double-send — LinkedIn returns `canInvite: false` for them, so they classify as
`already-follows` and cost no credit. But the list fills with unusable rows, real new
targets get crowded out under the 30/account cap, and the run reads as "skipped almost
everything".

**Fix pattern already exists:** `startTeamLaunchCloud` does exactly the right thing —
`queueInvites` at launch (proof), `markFgInvited` at reconcile. Port that into
`reconcileListRun`, or make Generate additionally dedupe against previous `FG <date>` tabs.

---

### Gap 2 — re-firing a tab re-dispatches rows already marked Invited

`parseListRows` reads the `Status` column into `row.status` and **never filters on it**
(`fg-list.js:227`). Fire the same tab twice — a manual "Run it now" after the scheduled
run, or two clicks — and every already-Invited row is dispatched again.

Bounded by two things: the engine's `invitedCountForMonth` (30/account/month, across all
campaigns) and LinkedIn's own `canInvite` guard. So it's waste, not spam. But the engine's
per-campaign `wasActionSent` anti-dupe gives **no** protection here — it's scoped to one
campaign id, and a re-fire is a new campaign.

**Fix:** skip rows whose Status is already `Invited` (and probably `Skipped`
already-follows) in `parseListRows`, behind an explicit `includeActioned` opt-out for a
deliberate retry.

---

### Gap 3 — cloud runs never update FG Budgets

The local path calls `observeFgCredits` (`fg-team-launch.js:55-59`) and the FG Budgets tab
gets the modal's real `available` / `allowance` / `refill`. The cloud path reads the exact
same numbers — `runFollowerGrowth` returns them, `campaign-runtime.js:291-298` persists
them via `store.setCredits` and logs them — and then **nothing writes the sheet.**

Since every run is a cloud run now, **FG Budgets is stale.** Anyone reading it to answer
"who has credits left" is reading fiction.

**Fix:** the engine already exposes per-account credits (that's what `deploy-fg-credits.sh`
shipped). Have `reconcileListRun` pull `/api/campaign/:id/accounts` and call
`observeFgCredits` per account. Sheet-side write stays app-side, consistent with everything
else in FG.

---

### Gap 4 — already-follows aren't remembered across runs

Local persists already-follows into the same store as invited, precisely so the next build
drops them: *"already-follows cost no credit and must never re-fill a slot"*
(`fg-team-launch.js:45`).

Cloud marks them `skipped` + a `markActionSent` marker **scoped to that campaign id**, and
the ledger stamps `Skipped` in the run tab. New campaign next cycle → new id → they're back
in the list. This is a sibling of gap 1 and may well be fixed by the same change; check
whether `updateFgListLedger`'s `Skipped` rows can be read back at Generate time.

---

### Gap 5 — write-back only happens while somebody's app is open

`reconcileFgCloudRuns` is an app-side 30-second timer plus a startup pass. `fg-roster` has
**no** reconcile route — `app.js` exposes only `/health`, `/rpc`, `/admin/refresh`,
`/admin/autopilot-config` and `GET|POST /admin/autopilot`.

Auto-Pilot fires at 06:00 London on the 1st and 15th. If nobody opens Ortus Outreach that
day, the tab still says `Queued` — while the invites really did go out. The adoption logic
(`pickUnreconciled`) means **one** operator opening the app is enough to reconcile
everyone's runs — but that's a person, not a system.

**Fix options, cheapest first:** (a) accept it and make the FG board show "N runs awaiting
reconcile" loudly; (b) add a reconcile pass to the fg-roster CronJob — it already has the
Apps Script URL and the engine client, so it can do exactly what the app does; (c) both.

---

## 3.3 Suggested order

1. **Gap 1** — it silently degrades every future run, and it's the one an operator would
   describe as "FG stopped finding anyone".
2. **Gap 4** — likely the same change; do them together.
3. **Gap 3** — FG Budgets is actively misleading right now.
4. **Gap 2** — cheap guard, prevents a foot-gun.
5. **Gap 5** — decide (a) vs (b) with Antonio before building.

---

# Part 4 — Prompt for Mickey

Paste everything between the fences into Claude Code, from the `ortus-gologin-clone`
directory.

```
I'm taking over Follower Growth (FG) for Ortus. Two repos:

  ~/ortus-gologin-clone                          — the Electron app (also holds the
                                                   fg-roster cloud service + its k8s)
  ~/Desktop/Projects/ortus-salesnav-scraper-cloud — the GKE engine ("the VM")

Read docs/HANDOFF-follower-growth-on-vm.md in the app repo first. It's a full walkthrough
of how FG works locally, how the engine runs it, and five verified gaps. Everything in it
has file:line references — check them, don't take them on faith.

CONTEXT YOU NEED UP FRONT:
FG is already built, deployed and running on the VM. An Auto-Pilot CronJob fires it at
06:00 Europe/London on the 1st and 15th. So this is NOT "port FG to the cloud" — it's
"close the write-back gaps and own it". The sending works; the ledger doesn't.

THE FIVE GAPS, in the order I want them looked at:

1. List-driven cloud runs never write to the FG Invites tab, which is the exact tab
   /api/fg/list/generate reads to skip already-invited people (invitedKeysFromState,
   src/connections/fg-sync.js:71). So every Generate re-lists people we already invited.
   LinkedIn blocks the actual re-invite (canInvite=false → costs no credit), so this is
   waste, not spam — but real new targets get crowded out under the 30/account cap and the
   run looks like it skipped everything. The correct pattern already exists in
   startTeamLaunchCloud (src/connections/fg-cloud-launch.js) — queueInvites at launch,
   markFgInvited at reconcile. Note services/fg-roster/autopilot.js is passed queueInvites
   and getFgState but uses neither.

2. Already-follows aren't remembered across runs on cloud. Local persists them alongside
   invited so the next build drops them (src/connections/fg-team-launch.js:45). Cloud marks
   them skipped with a campaign-scoped anti-dupe marker, so a new run brings them back.
   Probably the same fix as gap 1 — do them together.

3. Cloud runs never update the FG Budgets tab. Local calls observeFgCredits with the
   modal's real available/allowance/refill. The engine reads the same numbers
   (campaign-runtime.js:291-298, store.setCredits) and nothing writes the sheet. Since
   every run is a cloud run now, FG Budgets is stale — anyone using it to decide who has
   credits left is reading fiction.

4. Re-firing the same run tab re-dispatches rows already marked Invited. parseListRows
   (src/connections/fg-list.js:227) reads the Status column and never filters on it. The
   engine's wasActionSent anti-dupe is scoped to one campaign id, so a re-fire gets no
   protection. Bounded by the 30/account/month engine budget and LinkedIn's own guard, but
   still a foot-gun.

5. Write-back only happens while somebody's Ortus Outreach app is open — reconcileFgCloudRuns
   is a 30s app-side timer (server.js:2566). fg-roster has no reconcile route. Auto-Pilot
   fires unattended, so a tab can sit on "Queued" for days while the invites really went
   out. Don't build a fix for this one without checking with me first — I want to decide
   between "make it loudly visible in the app" and "add a reconcile pass to the CronJob".

THINGS THAT ARE ALREADY DONE — don't rebuild, don't "improve":
- The engine's FG batch mode (campaign-followergrowth.js + the batch branch at
  campaign-runtime.js:229-343). It has tests: node test-campaign-followergrowth.js
- Per-account routing (Account Email → profileId → routeAccount → claimNextLead's
  route_account gate). This is a hard LinkedIn constraint, not a preference.
- The durable monthly budget (invitedCountForMonth reads the leads table, cross-campaign,
  restart-proof).
- Benching, run narration, live per-person progress ticks.
- Auto-Pilot: service, CronJob, GCS config, email alerts.

DON'T CHASE THIS: src/linkedin/helpers.js and campaign-lib/linkedin/helpers.js differ by
~280 lines, but the drift is only normalizeSalesNavThreads / getSalesNavThreadsPage. The
two functions FG uses (randomDelay, getSenderUrn) are byte-identical. I verified this on
28 July 2026.

WORKING RULES:
- Use systematic-debugging. Get evidence before you change code. Guessing on this codebase
  has cost us real time.
- OFF LIMITS: src/linkedin/outreach.js and src/linkedin/actions.js. Never touch them.
- follower-invite.js is VENDORED IN TWO PLACES:
  app:    src/linkedin/follower-invite.js
  engine: campaign-lib/linkedin/follower-invite.js
  They are byte-identical today. If you change one you MUST change both identically, and
  diff them before and after. It has drifted before and it broke FG on the VM.
- Tests: app → node --test tests/*.test.js (relevant: fg-cloud-launch, fg-list-launch,
  fg-roster-autopilot, fg-roster-autopilot-routes, fg-autopilot-publish).
  Engine → node test-campaign-followergrowth.js and the other test-*.js scripts.
- App changes: bump the patch version in package.json AND both ?v= query strings in
  public/index.html before you relaunch.
- Engine changes: an engine change is NOT delivered until ./deploy.sh has run in
  ortus-salesnav-scraper-cloud. It refuses a dirty or unpushed tree, tags vNN, and rolls
  both the salesnav-scraper and campaign-worker deployments. Commit + push + deploy is part
  of the task, not a follow-up.
- fg-roster changes live in the APP repo but deploy to the SAME cluster:
    gcloud builds submit --config services/fg-roster/cloudbuild.yaml .
  Bump the :vN tag in BOTH services/fg-roster/cloudbuild.yaml and
  k8s/fg-roster/deployment.yaml, then roll it.
- Ortus runs ONE campaign at a time. Parallel campaigns crash the app.
- data/fg-cloud-runs.json is local state — never git add it.

START HERE: confirm or refute each of the five gaps against the actual code, tell me which
ones are real and what you found, and give me your plan. Don't change anything until I've
seen the plan.
```
