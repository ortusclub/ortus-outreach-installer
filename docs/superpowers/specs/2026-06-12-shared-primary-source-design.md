# Shared Primary Source — Design Spec

**Date:** 2026-06-12
**Status:** Draft for review
**Scope:** Unify "where the primary acts from" into a **single** selector in the Primary Person config, consumed by **both** primary-side automations (auto-accept + automated first follow-up). Retire the confusing follow-up "Sent from" dropdown and the separate `autoAcceptSender` field. Supersedes/evolves the in-progress
[auto-accept GoLogin-primary](2026-06-12-auto-accept-gologin-primary-design.md) work (same branch `auto-accept-gologin-primary`, not yet merged).

---

## Goal

Today the CC+IC wizard has two **inconsistent** controls:

- **Auto-accept** (in progress on the branch) lets you choose the primary's identity — local browser or a chosen GoLogin profile — via a source picker inside the auto-accept card.
- **Automated follow-up** (shipped, v2.91) has a separate "Sent from" dropdown offering **"You (local browser)"** vs **"The campaign account"** — which is confusing and, worse, conceptually wrong: the follow-up is a nudge from the **primary** (who is a participant in every intro thread), not from the campaign sender account.

Both actions are performed **as the primary**. The primary has exactly one identity per campaign: your local browser, or a specific GoLogin profile. **Done looks like:** that identity is chosen **once**, in the Primary Person block ("Logged in via: My local browser / A GoLogin profile → pick one"), and **both** auto-accept and follow-up use it. Each feature keeps its **own independent on/off toggle**. The follow-up's dropdown disappears; both feature cards show a read-only line ("…as your primary — [name]").

---

## Background — verified against current code

### Who can post the follow-up (the load-bearing fact)
The follow-up is posted **into the existing intro group thread** (`src/linkedin/thread-message.js` → `sendInThread` navigates to the captured `threadUrl`). That thread has three participants: the campaign account that ran the intro, the lead, and **the primary**. LinkedIn only lets participants post. So the only valid senders are **the per-lead campaign account** *or* **the primary**. An arbitrary non-participant profile cannot post. The primary is a participant in **every** intro thread, so a single primary identity can post **all** follow-ups across a multi-account campaign — making it the most concurrency-robust choice.

### Message tokens are already decoupled from posting identity
`src/linkedin/auto-intro.js:87-108` (`maybeBuildFollowUp`):
```js
const body = personalizeTemplate(rawBody, introData);                          // line 91 — tokens resolved at BUILD time
const sender = tpl.followUpSender === 'campaign-account' ? profileId : 'local-browser';  // line 92 — posting identity, SEPARATE
```
`introData` carries the **campaign account's** nice name (`senderFirstNames[profileId]`). So `{sender first name}` → the GoLogin account doing the outreach, `{primary name}` → the primary — both baked into `body` before the task is queued. `sendInThread` types the finished text. **Changing the posting identity does NOT change token resolution.** This spec must preserve that: only line 92's `sender` changes; `personalizeTemplate`/`introData` are untouched.

### Current fields (to be unified)
- `followUpSender` (`'local-browser' | 'campaign-account'`) — shipped; normalized in `campaign.js`, persisted in history + `post-campaign-bulk-check.js`, read in `app.js` (two config builders + restore + the `#follow-up-sender` select in `index.html`).
- `autoAcceptSender` (`'local-browser' | profileId`) — on the branch; normalized/persisted/enqueued + the `#auto-accept-source` picker UI.

### Routing already supports it
`src/primary-tasks.js` `partitionByBrowser` already routes **any** task by `t.sender` (`'local-browser'` → local bucket, else `byAccount[profileId]`), and `src/primary-task-runner.js` launches `launchAccount(profileId)` and runs the correct action by `t.type`. **No runner/partition change needed.**

---

## Design

### 1. Data model — one field replaces two
Introduce **`primarySource`** = `'local-browser'` (default) | a `profileId`, a property of the primary person (alongside `primaryName`/`primaryUrl`). It **replaces** both `autoAcceptSender` and `followUpSender`.

Normalization (in `normalizeTemplates`, `campaign.js`): trim; empty/`'local-browser'` → `'local-browser'`; any other non-empty string → passthrough (a profileId).

**Migration:** existing `followUpSender`/`autoAcceptSender` values are ignored in favor of `primarySource`, which defaults to `'local-browser'`. Old `followUpSender='campaign-account'` data therefore becomes "primary sends from local browser" — the corrected behavior. Acceptable: the features are recent and the deployment is single-owner.

### 2. UI

**Primary Person card** (where `primary-person-name` / `primary-person-url` live) gains **"Logged in via"**:
- Two radio source cards: **My local browser** (default) / **A GoLogin profile**.
- Selecting GoLogin reveals the searchable single-select profile picker (the exact `.aa-src-*` / `.aa-acct-*` component built on the branch, **relocated** here). Real fields only (email name, truncated id, SoO badges). Hidden input holds the chosen `profileId`.
- Hint: "This identity is used for both primary-side actions below. It must be logged into LinkedIn as the primary."

**Auto-accept card:** the `#auto-accept-source` picker is **removed**. Keep the master toggle + the primary-URL gate. Add a read-only line: **"Accepts as your primary — [local browser | profile name]"** (reflects `primarySource`).

**Follow-up card:** the `#follow-up-sender` dropdown is **removed**. Keep the toggle + delay. Add a read-only line: **"Sent from your primary — [local browser | profile name]"**.

The read-only lines update live when the shared selector changes, and show the resolved name (the profile's email, or "your local browser").

### 3. Backend
- `normalizeTemplates`: emit `primarySource`; drop `autoAcceptSender` and `followUpSender` (or keep them only as ignored legacy inputs — do not emit them).
- Auto-accept enqueue (`campaign.js`): `buildAcceptTask({ … sender: tpl.primarySource })`.
- Follow-up (`auto-intro.js:92`): `const sender = tpl.primarySource;` (replaces the `followUpSender` ternary). **Leave line 91 `personalizeTemplate` untouched** — `{sender first name}` stays the campaign account, `{primary name}` stays the primary.
- History snapshot (`campaign.js`): persist `primarySource` (replace the two old lines).
- Schedule + post-campaign (`post-campaign-bulk-check.js`): `registerSchedule` param + entry persist + read-back into `runAutoIntros` templates use `primarySource` (replace the two old fields).
- `partitionByBrowser` / `primary-task-runner.js` / `accept-invitation.js` / `thread-message.js`: **no change**.

### 4. UI JS (`app.js`)
- Relocate the picker helpers (`renderAutoAcceptPicker`/`toggleAutoAcceptSource`/`filterAutoAcceptPicker`) to drive the shared `#primary-source` control; rename to primary-source names. Read selection from the shared hidden input.
- `readPrimarySource()` replaces `readAutoAcceptSender()`: returns `'local-browser'` or the chosen `profileId` (or `''` if GoLogin selected but none picked).
- Both config builders emit `primarySource: _isIntroFlow ? readPrimarySource() : 'local-browser'` (drop the `autoAcceptSender` and `followUpSender` emits).
- Restore (`applyPresetConfig`): restore the source radios + picked profile from `t.primarySource` (replace the `autoAcceptSender` + `follow-up-sender` restores).
- Live read-only labels: a small `refreshPrimarySourceLabels()` updates the auto-accept + follow-up "…as your primary — [name]" lines whenever the selector changes.
- The auto-accept URL gate (`refreshAutoAcceptGate`) stays for the auto-accept toggle; the shared selector itself is not URL-gated (it's a primary attribute).

### 5. Validation / launch guard
Generalize the existing guard: if **either** auto-accept **or** follow-up is on **and** `primarySource` resolves to `''` (GoLogin selected, no profile picked) → block launch with a toast ("Pick which GoLogin profile your primary uses, or switch to your local browser."). `normalizeTemplates` also degrades `''` → `'local-browser'` as a backstop.

### 6. Concurrency robustness (the evaluated question)
One primary identity covers all leads — the primary participates in every thread — so follow-ups are posted by one launched profile regardless of which of N campaign accounts ran each intro. No per-lead account juggling, no risk of a non-participant sender. This is strictly more robust than either a single arbitrary profile picker or per-lead campaign-account posting for the follow-up.

### 7. Relationship to the unmerged branch
Evolve `auto-accept-gologin-primary`: keep the picker component + the `sender` routing (both reused); **move** the picker to Primary config, **rename** `autoAcceptSender → primarySource`, **fold** the follow-up onto it, **retire** `followUpSender`. No work is discarded.

---

## Testing (`node --test`, pure-helper unit tests)
- `normalizeTemplates`: `primarySource` defaults to `'local-browser'`, passes a profileId through, degrades empty → `'local-browser'`; confirm `autoAcceptSender`/`followUpSender` are no longer emitted.
- `partitionByBrowser`: unchanged behavior re-confirmed (accept + follow-up tasks route by `sender`).
- `maybeBuildFollowUp`: built task's `sender === tpl.primarySource`; `body` still personalized (token resolution unchanged — assert a `{sender first name}`/`{primary name}` render still works off `introData`).
- `registerSchedule`: persists `primarySource`; read-back present.
- UI: manual (`npm run dev:app`, Cmd+R) — pick local vs a profile in Primary config; confirm both cards' read-only lines update; confirm launch guard.

## Out of scope (YAGNI)
- A distinct `{primary first name}` token (can add later if wanted).
- Per-feature divergent sources (explicitly rejected: one primary, one source).
- Any change to token semantics, the connected-check, or `{primary url}`.

---

## Files touched (summary)

| File | Change |
|---|---|
| `public/index.html` | Add "Logged in via" (cards+picker) to Primary Person; strip `#auto-accept-source` picker → read-only line; strip `#follow-up-sender` dropdown → read-only line |
| `public/js/app.js` | Relocate/rename picker helpers to `#primary-source`; `readPrimarySource`; emit `primarySource` in 2 builders; restore; live label refresh; generalized launch guard |
| `public/css/style.css` | Reuse `.aa-src-*`/`.aa-acct-*` (rename optional); add read-only "uses-primary" line style |
| `src/campaign.js` | normalize `primarySource`; enqueue `sender: tpl.primarySource`; history persists `primarySource` |
| `src/linkedin/auto-intro.js` | `maybeBuildFollowUp` sender = `tpl.primarySource` (line 92 only) |
| `src/post-campaign-bulk-check.js` | `registerSchedule` param + persist + read-back use `primarySource` |
| `tests/*` | normalize, follow-up-sender, schedule coverage updated to `primarySource` |
| `src/primary-tasks.js`, `src/primary-task-runner.js`, `src/linkedin/thread-message.js`, `accept-invitation.js` | **No change** |
