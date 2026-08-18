# Magellan account picker — readiness states + HubSpot list fix button

**Date:** 2026-08-18
**Sketch:** `public/sketches/2026-08-18-magellan-picker-states.html` (variant B, chosen)

## Problem

The Magellan account picker shows one status word per tile — `DONE` or `TO DO` —
which answers "have we collected this account's connections?". At selection time
the operator's actual question is different: "will this account import into
HubSpot?". Those are independent, and the tile collapses them into one word.

Contacts can only be written to HubSpot if the operator's address is an allowed
option on the `linkedin_1st_connections` property. Measured 2026-08-18 against
the live portal and `/api/magellan/accounts`:

| | count |
|---|---|
| accounts total | 568 |
| `importable: true` | 301 |
| `importable: false` | 267 |
| `importable: null` (HubSpot did not answer) | 0 |
| no SoO email at all | 103 |
| already collected | 287 |
| **collected but not importable — work already spent** | **2** |
| **has an email AND blocked only by the option list — the fixable set** | **170** |

So 267 of 568 accounts silently cannot be imported, and the picker renders them
identically to the 301 that can. This surfaced when an operator selected
`somnath.mandal@ortus.solutions`, saw a green `DONE` tile, and only learned at
the footer that it could not go into HubSpot.

The property itself, measured the same day:

- `linkedin_1st_connections` — `type: enumeration`, `fieldType: checkbox`
- 1029 options, one per Ortus account address
- option shape `{label, value, displayOrder, hidden: false}`, with `label == value == <email>`
- `displayOrder` sequential, 0…1028
- `modificationMetadata: {archivable: true, readOnlyDefinition: false, readOnlyValue: false}` — editable
- `somnath.mandal@ortus.solutions` MISSING · `antoniovarlese@ortus.solutions` MISSING · `pat.yanguas@ortus.solutions` ALLOWED

Portal id 2748825.

The two "blocked" figures are not complements of each other: of the 267 that
cannot be imported, 170 have a resolved SoO email and 97 do not. The remaining
6 of the 103 no-SoO accounts *are* importable — `importable` is computed from
the account address on the option list, while `resolved` comes from the SoO
lookup, and the two can disagree. Both are shown because they call for
different colours and different actions.

## Goal

Make readiness visible on the tile, and make the blocked state fixable from the
app instead of by hand in HubSpot settings.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who can press the fix button? | Any operator |
| 2 | What does one press fix? | The current selection, as one batch |
| 3 | How is the blocked state shown? | Readiness takes the status zone (sketch variant B), plus a filter chip |
| 4 | Can a blocked account still be collected? | Yes — amber warns, it does not block |
| 5 | What if the write can't work? | Hide the button when we know it can't, report inline when it fails |

## Architecture

### Where the state comes from

No new data source. `server.js:2848` already asks HubSpot for the option list
and stamps `importable: true | false | null` on every account;
`/api/magellan/accounts` already ships it; `selectionSummary` in
`public/js/magellan-view.mjs` already consumes it for the footer sentence.

The tile renderer (`renderMagellanAccounts` in `public/js/app.js`) is the only
place that discards it. The visual half of this work is therefore a change to
one function plus CSS — no new endpoint, no extra fetch, no added latency.

`importable` is `null` when the 5-second HubSpot call times out. Zero accounts
are in that state today, but the path is live and the UI currently says nothing,
which reads identically to "fine".

### Tile states

Four states, three colours, no overlap in meaning:

| condition | status zone | colour | meaning |
|---|---|---|---|
| `resolved && importable === true` | `DONE` / `TO DO` | green / grey | unchanged from today |
| `resolved && importable === false` | `NEEDS HS LIST` | amber (`--gold`) | blocked, one click fixes it |
| `!resolved` | `NO SoO` | red (`--red`) | dead end — no email exists to add |
| `importable === null` | `HS UNKNOWN` | blue (`--blue`) | HubSpot did not answer; not guessing |

The colour split is load-bearing: **red means there is nothing you can do**
(no SoO email exists, so there is no value to add to the list), **amber means
there is a button**. Reusing red for both was the first draft and was rejected
for exactly this reason.

New CSS band `s-fixable` / `is-fixable`, mirroring the shipped `s-nosoo` rules
(amber dot, amber two-line word at `0.82rem`, amber email). `s-assigned` gains
the same small-word wrap treatment for the two-word `HS UNKNOWN`.

For amber and red tiles the collected/not-collected fact moves into the sub
line, where it still reads clearly:

> `Not on the HubSpot "Linkedin 1st Connections" list yet — one click below fixes it. 873 collected on 9 Aug. Tick to collect again.`

Amber accounts stay tickable and stay collectable. The Google Sheet write-back
is real value on its own — the connections land in the operator's tab either
way, and only the `HubSpot Link` column stays blank for those rows. Blocking
selection would punish the operator for a HubSpot configuration problem.

A `Needs HubSpot list 170` filter chip joins the existing All / To do / Done
chips, so the fixable set is reachable in one click rather than by scrolling
568 tiles.

### The fix button

Lives in the selection footer beside the existing
`N can go into HubSpot · M need adding` sentence. Label names the count and the
batch: `Add 2 to the HubSpot list`. Amber outline, hairline, radius 9999 —
consistent with the design system and distinct from the gold Start CTA by
weight and placement.

It acts on the current selection only. It is visible to every operator.

### The write

New endpoint, `POST /api/magellan/hubspot-options/add`, body `{accounts: [...]}`.

`PATCH /crm/v3/properties/contacts/linkedin_1st_connections` **replaces the
entire options array**. Adding one option means sending all 1030 back. A
mistake here does not corrupt one contact — it detaches a property's values
across a 12.2M-contact portal. The sequence exists to make that impossible
rather than unlikely:

1. `GET` the property fresh, immediately before writing. Never from cache.
2. Append only the missing values as `{label, value, displayOrder: n, hidden: false}`,
   continuing the existing sequence (1029, 1030, …).
3. **Refuse to send if the assembled array is shorter than what was just read,
   or if any previously-present value is absent from it.** Never remove,
   never reorder, never rewrite an existing option.
4. `PATCH`.
5. `GET` again and verify: every requested value is present, and the total
   count equals before + added.
6. Only then report success. A `200` that fails the read-back is reported as
   a failure.

Step 5 also resolves concurrent presses: whoever writes second read first, so
neither operator's addition is lost. If verification fails, retry the whole
read-modify-write once, then report failure.

### When it cannot work

The card already holds the option list at load time. The same request reports
whether the token can write schema. Without `crm.schemas.contacts.write` the
button never renders — the amber tile simply states that the account needs
adding, and the operator knows to ask.

Verified 2026-08-18 via `POST https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info`
(the `oauth/v1/access-tokens/<token>` and `oauth/v1/private-apps/v3/...` endpoints
do not work for private-app tokens and were the reason this looked unverifiable):

```
hub 2748825 | user 82586453
oauth
crm.objects.contacts.read
crm.objects.contacts.write
crm.schemas.contacts.write
```

The write scope is present, so this branch will not fire for the current token.
It stays in the design because tokens get rotated and scopes get edited, and a
button that 403s with no explanation is worse than a button that is absent.

Note `crm.schemas.contacts.read` is *not* in the list, yet reading the property
succeeds today — the read is covered by the other scopes. The design depends on
that read; it is verified working, not assumed.

Failure at press time reports inline and names the next step. The tile stays
amber. Nothing is ever marked fixed without the read-back confirming it.

## Testing

`node --test`, pure helpers, no live HubSpot writes.

**Options merge helper** (new, browser-and-node safe so it unit-tests directly):

- appends a missing value with the next sequential `displayOrder`
- is idempotent — merging an already-present value changes nothing
- never drops an existing option, and never reorders one
- the guard rejects an assembled array that is shorter than the input
- the guard rejects an assembled array missing any previously-present value
- verification fails when the read-back lacks a requested value
- verification fails when the read-back count does not equal before + added

**Tile rendering**: rendered-string assertions for all four states, including
that `!resolved` wins over `importable === false` (a no-SoO account is a dead
end regardless of the list) and that `importable === null` never renders as
green.

**Selection footer**: the button's count matches `selectionSummary().blocked.length`,
and the button is absent when the schema-write scope is missing.

## Out of scope

- The 103 accounts with no SoO email. Nothing to add to the list; they stay red.
- Whatever is still creating ID-less synthetic contacts in HubSpot (89 since June) —
  tracked separately.
- The ~14% of Magellan records unrecoverable by member id, where `lookupBySlugs`
  is the candidate third key — tracked separately.
- Any removal or reordering of existing property options, ever.
