# Handoff prompt — paste this verbatim into a new Claude Code session

You are resuming a frustrated, mid-investigation session. The previous Claude (me) burned the user's trust twice by jumping to fix-mode before understanding the failure. Your job is to **not** do that. **Research deeply, cite evidence with commit SHAs and line numbers, and do not propose a fix until you can predict the failure conditions yourself.** When you do propose a fix, the user must approve it before any code change.

---

## Project

- **Ortus Outreach** — LinkedIn outreach automation. Electron app + Express server + Puppeteer driving GoLogin browser profiles.
- Repo root: `/Users/antoniovarlese/ortus-gologin-clone`. Current branch: `connect-introduce-back-v2.14`.
- Operator: Antonio (ortus@ortusclub.com / antonio@ortus.solutions). About to hand the app to 3-4 colleagues for live testing.
- Mode causing the pain: `connect_and_introduce` (CC+IC). After a connection request is accepted, the bot auto-fires a 3-way intro DM that adds a configured "primary person" (Antonio) as the third recipient.

## The bug

In `connect_and_introduce` mode, the auto-intro DM step (`runAutoIntros` → `sendIntroMessage`) **intermittently fails** with one of two errors:

1. **`MESSAGE_SEND_FAILED: compose textbox did not appear`** — thrown at `src/linkedin/actions.js:1481`. Happens when the compose dialog itself doesn't render within ~15s.
2. **`INTRO_RECIPIENT_NOT_FOUND: recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)`** — thrown at `src/linkedin/actions.js:1818`. Happens when the typeahead returns zero candidates after 10s of polling.

The connection itself sends fine. The acceptance gets detected and stamped fine. The intro DM is the only thing that fails. The campaign continues regardless — `runAutoIntros` catches its own errors.

The bot has **one retry** for `INTRO_RECIPIENT_NOT_FOUND` (auto-intro.js:235-238) with a 2-second delay. No retry for `MESSAGE_SEND_FAILED`. Some leads recover on retry, some don't.

## What the user has explicitly told you

Quotes from the session, verbatim:

- *"the pathway of typing worked always fantastically with everything after we made the change that it was the problem that it was in the background"* — meaning the typeahead-typing approach has been reliable since the background-throttle fixes (commits `0d38a68` + `e898b3c` on May 16).
- *"for six, seven different accounts, this issue yesterday never happened"* — yesterday's campaigns ran clean across 6-7 GoLogin profiles.
- *"THEY ARE ALL MY FIRST CONNECTION THE GOLOGIN ACCOUNTS"* — the people the bot is trying to introduce ARE confirmed 1st-degree connections of the sending accounts. The error message "confirm 1st-degree connection" is misleading.
- The user manually tested `linkedin.com/messaging/compose/?recipient=hannah-gywneth-samson&recipient=antonio-varlese` in a GoLogin browser. **LinkedIn dropped both recipients and rendered the empty Messaging inbox.** This empirically confirms the codebase comment at outreach.js:497-504 that URL-routing for the second recipient does not work on current LinkedIn.

## Constraints (read CLAUDE.md too — these are non-negotiable)

- **Off-limits files** (never edit without explicit user permission): `src/linkedin/outreach.js`, `src/linkedin/actions.js`. They are *readable* for investigation.
- **Ask first.** Before any code touch, respond with two concrete artefact-backed questions. The user's short-circuit phrase is "ask first".
- **Do not guess.** The user will catch you and call it out. If you don't have evidence, say so.
- **Auto-relaunch dev:app** after any commit that touches runtime code. The pattern is at the bottom of CLAUDE.md.
- The user wants the campaign to be working for colleague handoff — every minute of churn is real cost.

## Today's session — 8 commits, none of which touched the suspect files

Run `git log --oneline -10` to see them. The commits, oldest first:

1. `7ee049c` `fix(stop-monitoring): flip state first + batch sheet stamp + correct FIELD_MAP key` — modified `src/campaign.js` (`stopMonitoring` function only) + `src/stop-monitoring.js` + `tests/stop-monitoring.test.js`.
2. `349fd97` `feat(sheet): set column widths in prepareSheet to kill truncation` — `google-apps-script.js` only.
3. `c1737ec` `feat(logs): add ops + campaign log bridges and node-side writer` — new files (`ops-log-bridge.js`, `campaign-log-bridge.js`, `src/log-writer.js`, `tests/log-writer.test.js`). Zero callers in commit 1.
4. `7d4494c` `feat(campaign): wire 6 hook points into the central log writer` — `src/campaign.js`. Added `_ops` helper, `campaign.startedAt` ISO string, and 6 fire-and-forget calls at: campaign start (line ~1183), pushError, pushSoftWarning, transitionToMonitoring, stopMonitoring, campaign-end finally block.
5. `d2af54c` `docs(logs): pin actual sheet names + IDs into bridge headers` — comment-only.
6. `99e7c4a` `fix(ops-log): use numeric sheet getSheetId() for Index HYPERLINK` — `ops-log-bridge.js` only.
7. `e00b30b` `fix(campaign-log): mode-aware template preview + include primaryIntroBody` — `src/campaign.js` only, in the finally block at line ~2872.
8. `162b068` `fix(history): persist CC+IC primary-person fields so Re-run restores them` — `src/campaign.js` only, in the finally block at line ~2842 (added `primaryName`, `primaryIntroBody`, `primaryUrl` to `settings.templates`).

**None** of these commits touch `src/linkedin/actions.js`, `src/linkedin/outreach.js`, `src/linkedin/auto-intro.js`, or `src/gologin-launcher.js`. The user does not want them reverted — they've set up two new Google Sheets ("OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE" and "CAMPAIGN ACTIVITY - ORTUS OUTREACH - DO NOT DELETE") with deployed Apps Scripts and added `OPS_LOG_WEBAPP_URL` + `CAMPAIGN_LOG_WEBAPP_URL` to `.env`.

## What the previous Claude got wrong (so you don't repeat it)

1. **Claimed URL-routing for the second recipient was a working approach.** Theory based on `auto-intro.js:73-86` comment ("`introUrl` is what makes sendIntroMessage use URL-routing for the second pill, sidestepping the unreliable typeahead"). User pushed back; checked `outreach.js:497-504`, which explicitly states URL-routing was reverted because **LinkedIn's compose URL parser is last-wins for repeated `?recipient=` params, so the lead's pill was silently dropped**. The user then confirmed this with a manual browser test. The `auto-intro.js:73-86` comment is stale and contradicted by the active code in `outreach.js`. The `secondRecipientUrl` param to `sendIntroMessage` is dead code.

2. **Implied recent commits today caused the regression.** The 8 commits above do not touch any LinkedIn-interaction code. The user agrees these are not the cause and does not want them reverted.

3. **Proposed a 30s retry delay edit to `auto-intro.js` without permission.** Reverted via `git checkout --` before commit. Do not redo this.

## What's actually known about the failure (evidence-backed)

### The typing/paste path (the real path) — `src/linkedin/actions.js:1429-1980` — `sendIntroMessage`

The actual flow for every CC+IC auto-intro today:
1. Build compose URL with ONE `?recipient=<leadPublicId>` (line 1452). The second recipient is never appended in practice because `auto-intro.js:221` passes `''` for `secondRecipientUrl`.
2. Navigate to compose URL with `waitUntil: 'domcontentloaded'`, 30s timeout (line 1461).
3. Wait 1.5s (line 1465).
4. Poll for compose textbox using 3 selectors (line 1468-1472), 5s timeout each = 15s max.
5. If textbox never appears → **MESSAGE_SEND_FAILED: compose textbox did not appear**.
6. Tag the recipient input with a unique data-attribute (line 1495-1524).
7. Check if the intro person is already added (line 1531-1541) — looking for `button[aria-label^="Remove"]` that matches the intro name. This is the no-op short-circuit if URL routing had worked. With URL routing dead, this branch is never taken.
8. **Paste-style insert** (line 1563-1582): native setter sets the value, then dispatches one synthetic `InputEvent({inputType: 'insertFromPaste'})` and one `change` event. Then `await sleep(1000)`.
9. Verify the paste landed; re-paste once if input is empty (line 1585-1599).
10. Poll for typeahead dropdown for up to 10s (line 1733: `for (let i = 0; i < 50; i++) { await sleep(200); ... }`). 30s soft-timeout wrapper around the whole poll (line 1679-1808).
11. 3-tier matcher (exact / token-prefix / single-candidate) at line 1709-1724.
12. If no candidate ever appears → **INTRO_RECIPIENT_NOT_FOUND: dropdown never opened** (line 1816).

### The critical history (run `git show <sha>` to read these in full)

- **`23c54ee`** (May 7) — v2.11.16. **DEDUCED THAT SYNTHETIC INPUTEVENT DOES NOT TRIGGER LINKEDIN'S TYPEAHEAD.** Commit message: *"the previous implementation set the input value via the React-style native-property-setter and dispatched a single InputEvent. That fires React's onChange but LinkedIn's typeahead listens for real key sequences (keydown/keypress/input/keyup) with internal debounce — a one-shot synthetic dispatch isn't a search trigger."* Fix: switched to `page.type()` for real keystrokes.

- **`7293712`** (May 14) — *Tried* URL-routing the second recipient. Documented `dropdown never opened` as a symptom of LinkedIn's anti-bot warming up "immediately after the bulkCheckConnections Voyager sweep that precedes auto-intro." Note: in `outreach.js:497-504` this approach was **reverted** because LinkedIn's URL parser is last-wins for repeated `?recipient=` params.

- **`70d8323`** (May 15) — IC DM fast-path. Replaced `outreach.js → performOutreach → sendIntroMessage` with a direct call from `auto-intro.js`. The call signature passes `''` for `secondRecipientUrl`.

- **`0d38a68`** (May 16, 12:44) — Added Chrome flags to disable background-tab throttling: `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`. In `src/gologin-launcher.js`. Plus a retype-once guard.

- **`e898b3c`** (May 16, 14:03) — **REVERTED `page.type` BACK TO PASTE-STYLE SYNTHETIC EVENTS** because `page.type`'s 960ms typing window gave macOS App Nap a chance to suspend the renderer mid-typing. **This is the suspect.** It re-introduces the exact pattern that `23c54ee` documented as not triggering LinkedIn's typeahead search.

- **`c3845b7`** (May 16, 16:52) — In-memory blacklist to prevent duplicate intros. Latest commit on `auto-intro.js` before today's session.

### The architectural conflict

`e898b3c` and `23c54ee` are in direct conflict:
- `23c54ee` says synthetic input events do not trigger LinkedIn's typeahead search; only real keystrokes do.
- `e898b3c` reverts to synthetic events because real keystrokes get dropped by App Nap.

Both can be true simultaneously, which would mean: **there is no single approach that works reliably** — you have to choose your failure mode. Either keystrokes get dropped by App Nap, or synthetic events don't trigger the typeahead. The current code chose synthetic events + Chrome flags + retype guard; the user has been observing the dropdown-never-opens failure.

The fact that the current code **sometimes works** suggests:
- LinkedIn's React onChange handler **does** fire a search XHR on synthetic events, but it's debounced differently from the keystroke handler — sometimes the XHR fires, sometimes it doesn't.
- OR LinkedIn's anti-bot heuristics for the typeahead are state-dependent (rate-limited per-session, post-Voyager-sweep, etc.) and the synthetic-event path is more sensitive to that state than the keystroke path.

### What hasn't been investigated

1. **What does LinkedIn's typeahead listener actually listen for?** Need to confirm by reading LinkedIn's compose JS in browser devtools — open compose dialog, search for `msg-connections-typeahead`, find the event listeners, check whether they handle `inputType: 'insertFromPaste'`. The codebase comments are inconsistent so the truth has to come from LinkedIn's runtime.

2. **`event.isTrusted`** — both synthetic events and Puppeteer's `page.type` produce `isTrusted: false`. Could LinkedIn be checking this? Possible, but if so the keystroke path would never work either, which contradicts the user's experience.

3. **The actual XHR fired (or not).** Open Chrome devtools' Network tab on a GoLogin browser during a manual auto-intro reproduction and check whether the typeahead search XHR fires after the paste. If it doesn't, the synthetic events aren't reaching LinkedIn's listener. If it does and returns empty, the anti-bot is rejecting the search.

4. **The `MESSAGE_SEND_FAILED: compose textbox did not appear` mode separately.** This happens BEFORE the typeahead step. Could be a different root cause: LinkedIn refusing to render the compose dialog for fresh-acceptance recipients (the lead just accepted), OR a stale selector for the textbox, OR a slow render that exceeds the 15s polling budget. Worth a separate investigation thread.

5. **Whether the bulk-check Voyager sweep itself is the trigger** — `7293712`'s commit message claimed yes. But yesterday it worked fine across 6-7 accounts, today it's failing. So either LinkedIn's anti-bot pattern changed, or there's environmental drift (laptop state, network, time of day).

## Action plan for the next session

In order:

1. **Get fresh evidence, not theory.** Ask the user to run a tiny 2-3 lead CC+IC campaign while you watch the dev:app log AND manually open the LinkedIn compose dialog in the same GoLogin browser. The user should:
   - Open Chrome devtools' Network tab on the bot's browser window
   - Filter for `typeahead`
   - Watch whether an XHR fires when the bot pastes Antonio's name
   - If yes — what does it return? (Empty `connections` array? 404? Rate-limit?)
   - If no — the paste-style synthetic event isn't reaching LinkedIn's listener at all

2. **Investigate `MESSAGE_SEND_FAILED: compose textbox did not appear` separately.** Have the user manually navigate to `linkedin.com/messaging/compose/?recipient=<a real lead's publicId>` for someone who JUST accepted. Watch whether the compose dialog opens. If it doesn't, the failure is upstream of any bot logic.

3. **Read more git history.** Specifically look for commits where the user reports the typeahead reliably working across many accounts. Compare those commits' state of `actions.js` to today's. The diff will tell you what regressed (if anything in code).

4. **Only after evidence is in, discuss with the user whether the right move is:**
   - Revert `e898b3c` back to `page.type` (and accept some App Nap fragility)
   - Add a longer wait between the paste and the dropdown poll
   - Try `CDP Input.dispatchKeyEvent` (lower-level than `page.type`)
   - Something else informed by the actual XHR evidence
   
   Do not propose any of these without permission. Ask first.

## Hard rules for the next Claude

- **Do not edit `src/linkedin/actions.js`, `src/linkedin/outreach.js`, or `src/linkedin/auto-intro.js` without explicit user permission.** They are readable for investigation. Edit permission is per-file and per-edit.
- **Do not propose a fix based on stale comments alone.** Comments in this codebase contradict each other (case in point: `auto-intro.js:73-86` vs `outreach.js:497-504`). When you see a comment, find the most recent commit that touched that line and read its message.
- **Do not auto-restart dev:app for a non-runtime commit.** This is in CLAUDE.md but bears repeating because of how long this session ran.
- **Ask the user for evidence before forming hypotheses.** Network XHRs, screenshots, console errors, manual repro results. Don't theorize from the codebase alone — the failure is in LinkedIn's runtime behaviour, not in static code.

## How to start your reply

The user expects you to begin by acknowledging this prompt and stating your first concrete investigation step. Do not summarise the prompt back to them. Do not propose fixes. Ask **one** clarifying question if you genuinely need one to start; otherwise dive into the first investigation step.

End of handoff.
