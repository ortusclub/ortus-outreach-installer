# Local-Browser Re-Login Recovery — Design

**Date:** 2026-06-15
**Author:** Antonio + Claude
**Status:** Approved (interactive design dialogue) → implementation

## Goal

When a **local-browser** campaign's LinkedIn session expires, recover in place: pop the
Chromium window on-screen and show an in-app popup telling the operator to log in, then
resume the campaign the instant they confirm (or we auto-detect login). Park the account
only if nobody responds within 5 minutes. **GoLogin cloud profiles are unchanged** — they
keep today's hard-park behaviour.

## Root cause being fixed

(Full diagnosis in chat, 2026-06-15.) `checkProfileHealth` flags a `/login` redirect as
`sessionExpired: true` (`campaign.js:907`). `ensureProfileLoggedIn` then takes an early
return at `campaign.js:1018` that **pre-empts** the `profileId === 'local-browser'`
interactive login-wait branch at `campaign.js:1023`. So a local browser whose persistent
session has lapsed gets hard-parked with no chance to log in. Regression introduced
2026-04-27 (`4067f28`, W2-A2) on top of the local login-wait added 2026-04-22 (`83b853c`).
The W2-A2 drop-and-park is correct for GoLogin (no interactive login mid-run) but never
carved out the local-browser exception.

## Scope

- **Only** `profileId === 'local-browser'`. GoLogin path untouched.
- **Only** the session-expired condition. Other health failures (authwall, feed-scroll
  fail) keep their existing local-browser 120s login-wait branch.
- **Both** detection sites:
  - at-open: `ensureProfileLoggedIn` (`campaign.js:1018`)
  - mid-run re-check: batch loop (`campaign.js:3208`)

## Behaviour

1. On local-browser session expiry, bring the Chromium window on-screen and set
   `campaign.awaitingLogin = { profileId, pName, since }`.
2. The UI status poll (2s, `/api/campaign/status`) sees `awaitingLogin` and shows a modal:
   *"Log into LinkedIn in the browser window that just opened, then click Done."*
3. The loop resumes when **either**:
   - operator clicks **Done** → `POST /api/campaign/login-done` → `campaign._loginDone = true`
     → loop does an immediate health recheck; if logged in, resume; if not, keep waiting
     (self-corrects a premature click), **or**
   - the loop **auto-detects** login (URL off `/login`+`/authwall`, on linkedin.com / health
     passes).
4. **5-minute ceiling** (operator walked away) → park the account exactly as today
   (`weeklyLimited.add`, `recordProfileEnd`, `parkedProfiles.push`, `setAccountNeedsLogin`,
   `markSoONeedsLogin`).
5. On any exit, clear `campaign.awaitingLogin = null` so the modal auto-dismisses on the
   next poll. On success, move the window off-screen.

## Components

| File | Change |
|---|---|
| `src/campaign.js` | Add state `_loginDone`, `awaitingLogin`. New `awaitLocalLogin(page, profileId, pName)` (bring on-screen + poll Done-or-detect, 5-min ceiling, returns `{ ok, page }`). New pure `decideLoginWaitAction({ elapsedMs, loggedIn, maxMs })` → `'resume' \| 'wait' \| 'timeout'`. Export `confirmLogin()`. Gate the `sessionExpired` early-return on `profileId !== 'local-browser'`; route local-browser session-expiry (at-open + mid-run) through `awaitLocalLogin`. Surface `awaitingLogin` in `getCampaignStatus()`. |
| `server.js` | `POST /api/campaign/login-done` → `confirmLogin()`. |
| `public/index.html` | `#login-recover-modal`, cloned from `#campaign-done-modal`. |
| `public/js/app.js` | `pollStatus()` → `maybeShowLoginModal(s)` (show when `s.awaitingLogin`, hide when absent). `confirmLoginDone()` POSTs `/api/campaign/login-done` and optimistically hides. |

## Data flow

loop sets `awaitingLogin` → 2s status poll → UI shows modal → operator logs in + clicks
Done → POST → `confirmLogin()` sets `_loginDone` → loop rechecks health → resume → clears
`awaitingLogin` → next poll hides modal.

## Error handling

- `campaign._abort` during the wait → give up → park (ceiling path).
- Done clicked while still on `/login` → recheck fails → stay waiting (modal re-shows).
- CDP / window-bounds failures → swallowed (best-effort); auto-detect still works.
- One active campaign at a time, so a single module-level `awaitingLogin` is unambiguous.

## Testing

- Unit: `decideLoginWaitAction` — logged-in → resume regardless of time; not-logged-in
  before deadline → wait; not-logged-in at/after deadline → timeout.
- Unit: `getCampaignStatus()` surfaces `awaitingLogin`.
- Manual: force a session expiry on a local browser → verify (a) browser pops on-screen +
  popup shows, (b) Done after login resumes, (c) auto-detect resumes if Done not clicked,
  (d) no response for 5 min → parks + Needs Login flagged. GoLogin run → unchanged.

## Out of scope

- No change to GoLogin behaviour.
- No change to `src/linkedin/outreach.js` / `actions.js` (off-limits).
- No change to non-session-expired health-failure handling.
