# Run Visibility: per-account panel, live polling, complete logs

**Date:** 2026-08-21
**Branch:** `fg-sheet-input-3117` (app), `main` (engine)
**Approved sketch:** `public/sketches/2026-08-21-check-visibility-B.html`
**Research:** `docs/superpowers/research/2026-08-21-logging-inventory.md`

## Problem

The operator pressed "Run check now". The toast said the check had started. The
card then read exactly what it read before: a countdown to the next check. Ten
minutes later there was still no way to tell whether anything was happening,
whether it had finished, or whether it had silently died.

Three separate causes, all of which have to be fixed for the symptom to go away.

1. **The card polls once and stops.** `public/js/app.js:1707` starts continuous
   polling only when `__cockpit.running` is true. A campaign in `monitoring`
   never satisfies that, so the card renders once at page load and then freezes.
   Even a perfectly instrumented backend would look dead behind it.
2. **The card has no per-account surface.** One campaign row covers 3 to 13
   accounts. The operator cannot see which account is working, how far into its
   batch it is, who it reached, or who it skipped and why.
3. **The logs are incomplete on the happy path.** The engine emits 27 event
   lines (`campaign-worker.js`), and they are good lines, but almost all of them
   are exception paths: rate limits, parks, checkpoints, missing notes. A run
   where nothing goes wrong produces near-silence between "turn started" and
   "browser closed", which is exactly the run the operator most wants to watch.

## Goal

At any moment, without opening a terminal, the operator can answer:

- Is anything happening right now, yes or no, from across the room.
- Which account is working, and on which person.
- How far into this turn of 8, and how much of today's allowance is spent.
- Who was reached, who was not, and why not.
- Whether it is running on this Mac or on the VM.

The same answers, in the same shapes, for local and cloud runs.

## Scope

### In

- A per-account panel on the campaign card, in the three states: sending,
  checking, monitoring.
- A loud banner on the card while a sweep or a send is actually in flight.
- Continuous polling for monitoring campaigns.
- Filling the gaps in the operator-facing log, on both sides.
- Promoting existing `console.log` calls in `src/linkedin/outreach.js` and
  `src/linkedin/actions.js` onto the campaign log bus. Logging only. No logic,
  selector, or control-flow change in those two files. This exception is
  explicitly authorised for this work and does not generalise.

### Out

- Any change to how sending, checking, or parking decides what to do. This is a
  visibility feature. If a behaviour looks wrong in the new panel, that is a
  separate bug with its own spec.
- `BATCH_SIZE` stays 8 and stays non-configurable.
- Retention beyond what is specified below.

## Global constraints

- Bugatti command deck: monochrome, hairlines, radii 0 or 9999. Gold is reserved
  for the Start CTA and appears nowhere in this work. State colour reuses what
  the card already has: the existing green for sending, the existing blue for
  monitoring.
- Every operator-facing log line reads out loud in plain English. No counters
  standing alone, no field dumps, no internal names: not `Voyager`, not `Stage`,
  not `pidMatched`, not `HTTP 429`. `appendMonitorLog`'s existing voice in
  `campaign-worker.js` is the house style. Say "nobody has accepted this
  account's 31 invitations yet", not `scanned=31 withUrl=31 pidMatched=29`.
- No em dashes in any operator-facing copy.
- Two different numbers, always both named. `BATCH_SIZE = 8`
  (`src/campaign.js:138`) is the leads one account works per turn.
  `campaign.dailyLimit` is that account's cap for the whole day. A bare "8"
  answers neither question.
- `statusFromItem` in `public/js/vjcard.mjs` is a whitelist. Every new field the
  panel reads must be added there by hand or it silently arrives undefined.
- Vanilla JS, no bundler. `node --test tests/*.test.js` on the app side.
  Standalone `test-*.js` run individually on the engine side.
- Engine changes are not delivered until `./deploy.sh` has run.

## Design

### A. The per-account panel

A new grid row on `.vj-card`, between the hero and the stats row. The card is a
named-area grid (`dashboard-v0.3.css:347`); the panel adds a `panel` area and
`.vj-details` moves down one row. Cards without a panel are untouched.

The panel is a horizontal rail of account columns, three visible at a time.

- The account currently working sits in the centre, the previous one to its
  left, the next one to its right.
- Exception: while the first account is working it sits flush left, because
  there is no previous.
- Scrolling right reveals the rest. `scroll-snap-type: x mandatory` so a column
  always lands centred.
- A `‹ 7 OF 13 ›` counter above the rail names the position.

Each column carries:

- The account email, its state label, and its own status dot.
- **The step list, only on the column that is currently working.** An idle
  column showing a frozen six-row checklist reads as if it were live. This was
  caught in review of the sketch and is a hard requirement, not a nicety.
- The batch counter: `5 of 8` over `this batch`, with a pip bar of 8 marks
  (filled, current, empty).
- The day counter underneath: `21 of 50 sent today`, plus one sub-line of
  context ("request 6 of this batch going out now, 29 left today").
- `REACHED TODAY`: the people this account actually connected to, by name.
- `NOBODY REACHED AND WHY`: each person it did not reach, with the reason in
  plain English. Reasons come from `normalizeSkipReason()`
  (`src/campaign.js:431-478`, 22 reasons) and `recordProfileEnd()`
  (`src/campaign.js:905`, 15 park reasons).
- A one-line result summary that carries only what the counters cannot: how many
  were missed, and whether anything is wrong. It must not restate the sent count
  the counters already show, and must never contradict them.

The columns render `.miss`, not `.skip`. The app already owns `.skip`
(`dashboard-v0.3.css:55`) for the off-screen skip-to-content link at
`left: -9999px`; reusing it makes rows silently vanish.

### B. The banner

While a sweep or a send is genuinely in flight, the card's existing `.vj-live`
band is promoted to be the loudest thing on screen. It reverts to the normal
quiet band the moment the work ends. This is the "idiot proof" requirement: the
banner appearing is itself the signal.

- 2px border and a breathing background tint in the state colour.
- Headline in display type, uppercase, ~2.1rem: `CHECKING RIGHT NOW` /
  `SENDING RIGHT NOW`.
- A beacon: a solid dot with two expanding rings on staggered delays, so it can
  never read as static.
- Second line names the subject: for sending, the person first, then the
  account, then the machine. `Rina Chandran · Reuters · from
  camillec@ortus.solutions · on this Mac`.
- Right-hand readout: the position and elapsed time. `6 of 8` over `THIS BATCH ·
  00:12 ELAPSED`, or `THIS BATCH · ACCOUNT 7 OF 13`.
- Checking uses the monitoring blue. Sending uses the card's existing green.

**Monitoring gets no banner, by design.** Between checks nothing is running, and
a card that shouts continuously teaches the operator to stop seeing the shout.

### C. Continuous polling for monitoring campaigns

`app.js:1707` currently reads:

```js
pollStatus().then(() => { if (__cockpit.running) startPolling(); })
```

A campaign in `monitoring` is not `running`, so it never polls again. The gate
must also start polling when the campaign is monitoring, and polling must stop
when the campaign reaches a terminal state so an idle tab does not poll forever.

This fix is load bearing. Without it every other change in this spec renders
once and then freezes, which is indistinguishable from the bug we are fixing.

### D. Log completeness

Both sides already have a plain-English feed. The work is filling the holes in
it, not replacing it.

**Local (`src/campaign.js`, via `log()` at line 995, 500-line ring plus
`data/campaign.log`):** the loop knows far more than it says. The lines the panel
needs, and the operator has been missing, are the per-lead outcomes and the
turn boundaries. Most of the underlying detail already exists as `console.log`
in `src/linkedin/outreach.js` and `src/linkedin/actions.js`; those calls get
promoted onto the log bus so they reach the operator instead of only stdout.

**Cloud (`campaign-worker.js` `_evt()` at line 894 → `appendMonitorLog` →
Redis):** 27 event lines exist and read well. What is missing:

- The happy path. There is a turn-end line (`campaign-worker.js:875`) but no
  per-lead "sent to X" on success, so a clean turn is silent for its whole
  duration. The operator watching a five-minute gap cannot tell working from
  hung.
- Turn start: which account is opening, how many leads it intends this turn.
- Sweep progress: which account is being checked, and its result, per account
  rather than only on the tail.
- The next-check line, so the feed itself says when it will speak again.
- Retention. `campaign-store.js:1721` trims to the 50 most recent lines
  (`ltrim(key, 0, 49)`). Fifty lines is under one account's turn once the happy
  path is instrumented, so the feed will truncate before the operator reads it.
  The cap has to rise. The 7-day TTL stays.

Every added line follows the same rules as the existing ones: names the account
by its email, names the person by name, says what happened and what happens
next, and reads as a sentence.

## Verification

- The polling fix is verified by measuring, not by inspection: attach to the
  renderer over CDP (`--remote-debugging-port=9222`) and confirm the poll fires
  repeatedly on a monitoring campaign. An unchanged card after 30 seconds is a
  fail regardless of what the code reads like.
- The panel is verified by rendering the real card in the real app, not the
  sketch, at 3 accounts and at 13, in each of the three states.
- Log lines are verified by reading the actual feed off a live campaign, local
  and cloud, and confirming no line contains a bare counter, a field dump, or an
  internal name.
- Engine work is verified after `./deploy.sh`, against the live feed.

## Risks

- `statusFromItem`'s whitelist will silently swallow new fields. Every field the
  panel consumes gets added there in the same task that introduces it.
- The rail centring maths runs off `scrollWidth / columns`; a column whose
  content changes height must not change its width, or centring drifts.
- Raising the Redis log cap raises memory per campaign. The TTL bounds it, but
  the new cap should be chosen against the real per-turn line count, measured,
  not guessed.
