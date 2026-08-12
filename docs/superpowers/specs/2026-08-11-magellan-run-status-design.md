# Magellan run status — say what is happening and how it ended

**Date:** 2026-08-11
**Scope:** Operation Magellan only. No other campaign type, no shared module.

## Problem

Four things the Magellan card gets wrong, all observed on a real run:

1. It reads `NOT RUNNING · 92% · Idle` while a Check is still in flight.
2. Two percentages disagree on screen — the hero says 92%, the button says 83%.
3. The selection bar says `13 accounts selected`; the run says `11 of 12`.
4. When it finishes, nothing says what happened. The card holds its last live
   numbers, so a finished Check reads `92% · 0 people so far`.

None of these is a wrong computation. Each is two parts of the screen answering
the same question from different data, or the card being asked to describe a
state it has no field for.

## Non-goals

Explicitly out of scope, previously considered and dropped:

- A status contract shared with CC+IC / CC+DM / Follower Growth / bulk check.
- Stamping `currentAction.phase` on local campaigns.
- Adding a `messaging` phase to `LIVE_PHASES`.
- Wiring `campaign-summary.js` `ISSUE_RULES` into the campaign card.

Those are real problems. They are not this spec.

### Merging duplicates is dropped

The Merge button and the duplicate-pair list come **off the card**.

The import does not need them. `lookupByMemberIds` (`hubspot-client.js:141`)
already picks the record with a real email address and writes the connection
there — the record people actually open. Merging buys tidiness in HubSpot, and
costs an irreversible operation that, for a few hundred people, silently decides
which of two real email addresses stays. Alecx Bagatsolon has `alecx@ortusclub.com`
(2021) and `alecx.bagatsolon@ortusclub.com` (2026); nothing on the screen
distinguished that from Sam Adcock's harmless case of one real address and one
synthetic placeholder from a 2024 import.

`mergeDuplicates` and `POST /api/magellan/merge-duplicates` stay in the codebase
with their tests. Nothing in the UI calls them. Duplicates remain a **reported
fact** in the outcome — a number the operator can act on by hand, later, if they
ever care.

Removed from the card: `#mg-dupes`, `renderMagellanDupes`, `mergeMagellanDupes`,
and the `.dp*` / `.dpa*` / `.rec*` style rules that only served them.

---

## 1. The job is not done until its result exists

### Today

`src/connections/magellan-run.js` `buildPreview` wraps the account loop in
`try/finally`. The `finally` (`:282`) sets:

```js
_state.running = false;
_state.phase   = 'done';
```

Everything that produces the answer runs **after** that block:

| what | line |
|---|---|
| duplicate roll-up + its log lines | `:293–303` |
| `_plans = plans` | `:305` |
| `_state.preview = { totals, blocked, duplicates, … }` | `:306` |
| blocked-accounts log line | `:309` |
| `return { totals, plans, blocked, duplicates }` | `:313` |

The 5s poller sees `running: false` the moment the loop ends. The card flips to
`Not running` / `Idle` while the request is still open and `preview` is still
`null` — which is exactly the screenshot.

### Change

Widen the `try` to cover the roll-up and the `preview` write. The `finally`
clears `account` / `current` / `step` and sets `running: false` **only after
`_state.preview` has been assigned**, or after `_state.error` has been set.

Invariant, and the sentence the code comment should carry:

> `running` goes false only once the state carries the run's result — a
> `preview`, or an `error`. There is no instant where the card can truthfully
> say "not running" and have nothing to show.

### Test

`preview is not readable before running clears` — a fake `lookup` resolves, and
the assertion reads `getState()` at the moment `running` flips: `preview` must
be non-null.

---

## 2. One percentage

### Today

`renderMagellanState` in `public/js/app.js` writes `mg-pct` twice:

- `:27211` — `pct = round(done / total * 100)`, whole accounts → **83**
- `:27315` — `blended = round((done + frac) / total * 100)`, includes the
  in-account fraction → **92**, overwriting the first

and the Check button label at `:27263` reads the **first** value:

```js
prevBtn.textContent = s.running ? `Checking… ${pct}%` : 'Check what would happen';
```

So the hero and the button are two different numbers, permanently.

### Change

Compute the blend once, before anything is written:

```js
// The only percentage in this card. The in-account fraction is part of the
// answer, not a later correction to it — computing it twice is what put 92%
// in the hero and 83% on the button at the same moment.
const pct = magellanPct(s);
```

`magellanPct(s)` is a pure function (`done`, `total`, `current.count`,
`current.total`, `current.stage`) exported for tests. Hero, bar and button all
read `pct`. The second write at `:27315` is deleted.

Stage weighting is unchanged from today's `:27313`: `check` counts as the whole
of an account's slice; `ids` is the back half (`0.5 + raw / 2`); the list pass is
the front half (`raw / 2`).

### Test

`magellanPct` is asserted directly, and the render test asserts hero text and
button text are the same number.

---

## 3. The selection bar says what will actually run

### Today

- `mg-sel-count` = `mgSelected.size` (`app.js:27054`) — 13.
- The run's `total` = `usable.length` — 12. `buildPreview` (`:233`) splits the
  selection against the `linkedin_1st_connections` options and drops what
  HubSpot cannot accept.
- The blocked account is named in a log line (`:309`) — *after* the run.

### Change

The account list already knows each account's email; the HubSpot option list is
already fetched for the property check. Split the selection at selection time
and say it in the bar:

> **13 selected** · 12 can go into HubSpot · **1 needs adding: jemely.butron@ortus.solutions**

The blocked name is a link that copies the address, since the fix is pasting it
into the HubSpot property. The post-run log line stays — it is the record.

If the option list has not loaded yet, the bar shows the plain count and no
split. It never guesses.

### Test

Pure split helper: given a selection and an option set, returns
`{ usable, blocked }`, case-insensitively (matching `buildPreview`'s existing
`.trim().toLowerCase()`).

---

## 4. A finished run states its outcome

### Today

`renderMagellanState` sets the eyebrow to `Finished` and leaves the hero holding
whatever the live tick last wrote. After a Check that means `92% · 0 people so
far` — the live labels (`people so far`, `accounts to go`) are still in place
because nothing replaces them.

### Change

Add an outcome block to `#mg-card`, rendered when `!s.running` and the state
carries a result. It replaces the live hero labels rather than sitting under
them.

**Shape** — stored on `_state.outcome`, written by the same code that ends the
run, so it cannot exist without the run having ended:

```js
{
  ok: true,                 // false when it errored or was stopped short
  summary: '9,623 new · 15,545 already there',
  problems: [               // one line per distinct cause, already grouped
    '3,727 people are in HubSpot more than once — their connection was recorded '
      + 'on the record with a real email address, so nothing was missed',
    "1 account skipped: jemely.butron@ortus.solutions isn't on the HubSpot list yet",
  ],
}
```

Grouping reuses `summariseProblems` from `src/connections/magellan-problems.js`,
which already collapses raw HubSpot failures into counted, plain-English causes
sorted by count.

**Per phase:**

| phase | summary |
|---|---|
| collect | `24,607 people from 12 accounts · 9,102 with a LinkedIn ID` |
| check | `9,623 new · 15,545 already there` |
| import | `4,102 added · 20,505 updated` |
| stopped | `Stopped after 7 of 12 accounts — the rest weren't asked about` |
| error | the translated error, with `[raw]` appended as `problemLine` already does |

**Rule:** a run that ended early says how far it got *before* it states any
total. A partial number is never presented as a final one.

### Test

Three cases: outcome after a clean check; outcome after a stop; outcome after a
throw. Each asserts `ok` and that `summary` names the phase's real counts.

---

## Error handling

Everything here is read-only against HubSpot, so every failure mode is the card
misreporting state rather than data loss.

- **Check throws mid-sweep** (portal 500, token expired) — `_state.error` is set
  and `phase` becomes `error` *before* `running` clears. The outcome block
  renders the error instead of a frozen percentage.
- **The roll-up throws after the loop** — the widened `try` still ends in the
  `finally`, so the card cannot stick at `Checking` forever. `ok: false`, and the
  outcome says the sweep finished but the summary could not be built.
- **Stop mid-check** — same path as collect's existing `stopped` handling; the
  outcome names the account count reached.

## Testing

`node --test`, pure assertions against `getState()` and the extracted pure
helpers — no browser, matching the 25 existing tests in
`tests/connections/magellan-run.test.js`.

1. `preview` is non-null at the moment `running` clears (§1 regression)
2. after a thrown `lookup`: `running === false`, `error` set, `outcome.ok === false`
3. `magellanPct` returns one value; hero and button render the same number (§2)
4. selection split returns `{ usable: 12, blocked: ['jemely.butron@…'] }` (§3)
5. outcome after clean check / after stop / after throw (§4)

## Files touched

| file | change |
|---|---|
| `src/connections/magellan-run.js` | widen the `try`; write `_state.outcome`; clear `running` last |
| `public/js/app.js` | one `magellanPct`; render the outcome block; selection split in the bar; delete `renderMagellanDupes` + `mergeMagellanDupes` |
| `public/index.html` | `#mg-outcome` block + its `body[data-dashboard='v3']`-scoped rules; delete `#mg-dupes` and the `.dp*` / `.dpa*` / `.rec*` rules |
| `tests/connections/magellan-run.test.js` | the five tests above |

`src/connections/magellan-problems.js` and `hubspot-client.js` are unchanged —
`summariseProblems` is used as it stands.
