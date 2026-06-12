# Auto-accept via a chosen GoLogin profile — Design Spec

**Date:** 2026-06-12
**Status:** Draft for review
**Scope:** A focused extension to the CC+IC **auto-accept the connection** feature (shipped in the
[primary-side automation](2026-06-11-primary-side-automation-design.md) subsystem). Lets the auto-accept run
either via the **local browser** (today's only option) or via a **GoLogin profile** that the primary person is
logged into. UI direction is **Variant B** (two source cards → searchable profile grid). Follow-up sender,
the connected-check, and `{primary url}` semantics are unchanged.

---

## Goal

Today the CC+IC "Auto-accept the connection" card offers a single switch — **"Accept via my local browser."**
But the primary person isn't always logged in on the operator's local Chrome; sometimes the primary is one of
the operator's **GoLogin profiles**. There is currently no way to say so, so the auto-accept can't be used for
those primaries.

**Done looks like:** the auto-accept card lets the operator choose **where** the primary accepts —
(1) my local browser, or (2) a GoLogin account — and when GoLogin is chosen, **pick which profile** from a
searchable list of real profiles. The acceptance then runs inside that profile.

---

## Background — how auto-accept works today (verified against current code)

When auto-accept is on and a campaign (GoLogin) account sends a connect request to the primary, an **accept
task** is enqueued and later drained by the primary-side task runner, which accepts that one invitation.

Verified execution path:

1. **Enqueue** — `src/campaign.js:2448–2466`: when `tpl.autoAcceptPrimary` is on and a connect to the primary
   was sent, `buildAcceptTask({…})` is called and `enqueuePrimaryTask(_task)` queues it.
2. **Task shape** — `src/primary-tasks.js:40–52` (`buildAcceptTask`): carries `type:'accept'`, the campaign
   account identity (`campaignProfileId`/`campaignProfileName`), sheet/campaign metadata, `account`, and
   `primaryUrl`. **There is no `sender`/`browser` field.**
3. **Partition** — `src/primary-tasks.js:59–71` (`partitionByBrowser`): line ~64 routes **every**
   `type === 'accept'` task to the `local` bucket unconditionally. Follow-up tasks already split by
   `t.sender` (`'local-browser'` vs a `profileId`).
4. **Run** — `src/primary-task-runner.js:98–130`: the `local` bucket launches `launchLocal()`; the
   `byAccount` buckets launch `launchAccount(profileId)`. The acceptance itself,
   `acceptInvitationFrom(page, account, …)` (`src/linkedin/accept-invitation.js:132–229`), takes a Puppeteer
   `page` and works regardless of where the page came from.

**The proven precedent:** the **follow-up "Sent from"** choice already routes a primary-side action to a chosen
GoLogin profile. `public/index.html:551–555` offers `You (local browser)` / `The campaign account`;
`src/campaign.js` normalizes `followUpSender`; `src/linkedin/auto-intro.js:87–109` resolves it to
`sender = profileId | 'local-browser'`; the runner dispatches per-account via `launchAccount(profileId)`. The
accept task simply doesn't carry a sender yet — so it's always local.

**The gap this spec fills:** give the accept task the same `sender` field the follow-up task already has, surface
a picker in the UI, and let the operator point the acceptance at a specific GoLogin profile.

---

## Design

### 1. UI — Variant B (`public/index.html` + `public/js/app.js`)

Replace the single-toggle `auto-accept-block` (`public/index.html:564–577`) with:

- **Master on/off toggle** — "Auto-accept the primary's invitation." Unchanged behavior; still locked by the
  existing primary-URL gate (`auto-accept-gate`, the 🔒 message). The URL stays required — it identifies the
  primary for the connected-check and the `{primary url}` placeholder, independent of where acceptance runs.
- **Two radio source cards** (mutually exclusive):
  - *Accept via my local browser* — selected by default; identical to today.
  - *Accept via a GoLogin account* — when selected, **expands** a searchable, **single-select** profile grid.
- **Profile grid** reuses the data already loaded for the campaign-account picker (`/api/profiles` + SoO
  enrichment via `/api/soo-status`). Render with the existing visual vocabulary — `.name` (email),
  truncated `.id`, `.soo-user` (`Assigned · <op>`), and the 4-segment `.status-bar` (OP/InM/SN/CC). **Real
  fields only — no invented stats.** Lists **all** profiles, searchable (no preset filter chips).
- **Soft hint** under the picker: *"This profile must be logged into LinkedIn as the primary."*

Reference sketch: `public/sketches/auto-accept-primary-B-cards.html`.

### 2. Data & persistence — mirror `followUpSender`

One new per-campaign template field:

- **`autoAcceptSender`** — `'local-browser'` (default) **or** a `profileId` string.

Wiring (parallel to `followUpSender` everywhere):

- **Read at config + launch** — `public/js/app.js:214` and `:3644` currently read `autoAcceptPrimary`; also read
  the selected source and, if GoLogin, the chosen `profileId`, emitting `autoAcceptSender`.
- **Restore on template load** — `public/js/app.js:7127` restores the `autoAcceptPrimary` checkbox; also restore
  the source cards + selected profile. Resolve the profile's display name from the loaded profiles list (store
  the id, render the name — survives GoLogin name edits).
- **Normalize** — `src/campaign.js` (alongside the `followUpSender` normalization, ~`:1328–1333`):
  `autoAcceptSender: <'local-browser' | profileId>`, defaulting to `'local-browser'`.
- **State history** — persist `autoAcceptSender` next to `followUpSender` (~`src/campaign.js:3770–3774`).

### 3. Backend routing — ~4 small changes, all paralleling `followUpSender`

- **`src/primary-tasks.js`**
  - `buildAcceptTask()` (`:40–52`): add a `sender` field, default `'local-browser'`; include it on the returned
    task.
  - `partitionByBrowser()` (`:59–71`): route accept tasks **by `t.sender`** — `'local-browser'` → `local`
    bucket; a `profileId` → `byAccount[profileId]`. (Removes the unconditional accept→local line.)
- **`src/campaign.js`**
  - Enqueue (`:2448–2466`): pass `sender: tpl.autoAcceptSender` into `buildAcceptTask({…})`. (This is the
    profile to **launch for accepting** — distinct from `campaignProfileId`, which is who *sent* the request and
    whom the invite is *from*.)
- **`src/primary-task-runner.js`** — **no change.** It already launches `launchAccount(profileId)` for
  `byAccount` tasks, and `acceptInvitationFrom(page, …)` runs on that page.
- **Off-limits files** `src/linkedin/outreach.js` / `src/linkedin/actions.js` — **untouched.**
  `src/linkedin/accept-invitation.js` — **no change needed** (takes a `page`).

### 4. Failure mode & guards ("trust + soft hint")

- **Wrong profile is safe.** `acceptInvitationFrom` matches the specific pending invitation **from the campaign
  account**. A profile that isn't the primary's login won't have that invite → **no-op + log line**, never a
  wrong acceptance. No identity validation is performed (operator decision).
- **One necessary launch guard.** If source = GoLogin but **no profile is selected**, block launch the same way
  the missing-URL gate does — there is no profile to launch otherwise. This is a config-completeness check, not
  an identity check.
- **One-campaign-at-a-time** is preserved: the chosen profile is drained through the existing primary-task
  runner, which already serializes browser launches via its semaphore + `guardIdle()` (same path the follow-up
  "campaign account" sender uses today).

### 5. Testing (`node --test`, pure-helper unit tests — matches repo convention)

- `partitionByBrowser`: accept task with `sender=<profileId>` → `byAccount[profileId]`; accept task with
  `sender='local-browser'` (and default/absent) → `local`.
- `buildAcceptTask`: carries `sender`; defaults to `'local-browser'` when omitted.
- `normalizeTemplates`: persists `autoAcceptSender` (extend existing
  `tests/register-schedule-followup-fields.test.js` and `tests/normalize-templates-primary.test.js`).

UI is verified manually (`npm run dev:app`, Cmd+R) per repo convention. Patch-bump `package.json` before the
relaunch so the build is identifiable in the UI.

---

## Out of scope (YAGNI)

- Hard identity validation that the chosen profile is logged in as the primary (chose soft hint).
- Excluding campaign-sender profiles from the picker (chose: show all).
- Any change to the follow-up sender, the connected-check, or `{primary url}` semantics.
- Multi-primary support, or a default/global primary profile across campaigns.

---

## Files touched (summary)

| File | Change |
|---|---|
| `public/index.html` | Replace single toggle with master toggle + two source cards + profile grid |
| `public/js/app.js` | Render single-select picker; read/restore `autoAcceptSender`; launch guard |
| `src/primary-tasks.js` | `buildAcceptTask` gains `sender`; `partitionByBrowser` routes accept by `sender` |
| `src/campaign.js` | Normalize `autoAcceptSender`; pass `sender` to `buildAcceptTask`; persist in history |
| `tests/*.test.js` | Partition + builder + normalize coverage |
| `src/primary-task-runner.js`, `src/linkedin/accept-invitation.js` | **No change** (already generic over `page`) |
