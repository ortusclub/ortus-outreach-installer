# CC+IC Note-Aware Group Intro + Dedup — Design

**Date:** 2026-06-10
**Branch:** `ccic-reliability-2.86`
**Status:** Approved (operator green-lit incl. the gated `actions.js` addition)

## Problem

In a **Connect + Introduce (CC+IC, `connect_and_introduce`)** campaign that sends a
**connection note**, the auto-intro lands as a plain 1:1 DM instead of a 3-way group
chat — the primary person (the third pill) is silently dropped.

**Root cause (operator-confirmed, documented since v2.58.x):** the connection note
creates a 1:1 message thread between sender and lead. The intro path
(`sendIntroMessage`) URL-routes the lead (`/messaging/compose/?recipient=<leadSlug>`),
and LinkedIn collapses that compose into the existing 1:1 thread. The "Group name"
field never renders, the second pill is discarded, and the body is delivered 1:1.

This is the **exact** failure the Introduce Back campaign already solved with
`sendIntroViaCleanCompose` (open a *blank* compose, typeahead-add **both** recipients →
real group). That fix was deliberately scoped to IB only ("do NOT touch CC+IC",
operator constraint 2026-05-19) because note-less CC+IC has no prior thread and the
URL path works (and is more exact).

Now that operators run CC+IC **with** notes, CC+IC hits the same collapse.

## Goal

Make CC+IC produce a real 3-way group intro **even when a connection note was sent**,
by reusing the existing IB clean-compose mechanism — **only** for the note case — while
preserving double-message protection in both cases and leaving everything else
byte-for-byte identical.

## Approved Design

### 1. Note-aware routing (in `src/linkedin/auto-intro.js`)

The intro step forks on whether this campaign sends a connection note:

```
hasConnectionNote = (templates.connectionNote || templates.note).trim() !== ''
```

| Condition | Intro path |
|---|---|
| Note present **and** lead full name available | `sendIntroViaCleanCompose` (blank box → typeahead lead + primary → group) **with dedupe probe ON** |
| Note present but lead name missing on row | **Fallback** to `sendIntroMessage` (today's path) + a warning log (clean-compose needs the name to typeahead the lead) |
| No note | `sendIntroMessage` (today's URL-routing path) — **unchanged** |

`hasConnectionNote` is campaign-level (computed once). The lead's full name is already
derived per-row in `runAutoIntros` (`leadFirstName` + `leadLastName`, the casing-
tolerant reads). `leadFullName = "${leadFirstName} ${leadLastName}".trim()`.

### 2. Empty-group dedupe probe (in `src/linkedin/actions.js`, gated)

`sendIntroViaCleanCompose` gains an **off-by-default** options flag. When ON
(CC+IC note-branch only), after **both** recipients are added and the thread settles
but **before** typing the body, it probes for existing message events
(`.msg-s-event-listitem` et al.):

- **0 events** → empty/new group → proceed (type + send).
- **>0 events** → a group thread for this lead+primary already exists → `throw new
  Error('INTRO_ALREADY_EXISTS')`.

This reuses the **same error string** the URL path already throws, so the existing
handler in `runAutoIntros` maps it to **"Introduction Already Made"** with no new
stamping code.

**Why the connection note can't fool this:** the note lives in the *1:1* chat (just
sender + lead). The probe only ever inspects the *group* compose (sender + lead +
primary), where the note cannot appear.

### 3. Dedup symmetry — both branches refuse to double-message

| Branch | Dedup guard | Outcome on repeat |
|---|---|---|
| Note (clean-compose) | **New** empty-group probe → `INTRO_ALREADY_EXISTS` | "Introduction Already Made", nothing sent |
| No-note (`sendIntroMessage`) | **Existing** `INTRO_ALREADY_EXISTS` via compose→thread redirect (`actions.js:1812`) | "Introduction Already Made", nothing sent |

Both sit on top of the unchanged durable guards: the one-shot `Introduction Status`
sheet gate (`bulk-check-connections.js:288`) and the in-run `introducedInRun` set.

## Non-Goals (explicit — protect what works)

- **Do NOT change Introduce Back behavior.** The probe flag defaults OFF; IB calls
  `sendIntroViaCleanCompose` with the existing 5-arg signature → byte-for-byte
  identical.
- **Do NOT change the no-note CC+IC path.** `sendIntroMessage` and its existing
  redirect guard are untouched. No second probe bolted on (its redirect guard fires
  first and aborts anyway — redundant, pure risk).
- **Do NOT touch** the connect step, connection notes, bulk-check matching
  (v2.86.12 ID-only), or the connect-identity verify (v2.86.10). Different files/paths.
- **Do NOT** add member-identity row-level dedupe (the "same person = two rows" cause).
  Tracked separately as optional follow-up.

## Test Strategy

`node --test`, pure-helper unit tests preferred (per repo convention); the DOM/compose
flow is verified manually in a real paused/monitoring run (no UI/browser test harness).

- **`_decideIntroPath({ hasConnectionNote, leadFullName })`** (pure, exported):
  - note + name → `'clean-compose'`
  - note + empty name → `'url-routing'` (fallback)
  - no note → `'url-routing'`
- **`_groupHasHistory(eventCount)`** (pure, exported): `eventCount > 0`.
- **Retry/stamp wiring:** `INTRO_ALREADY_EXISTS` from the clean-compose branch maps to
  `alreadyMade` (existing handler); clean-compose's `IC_INTRO_RECIPIENT_NOT_FOUND` is
  honored by the retry-once branch.
- **Regression:** IB still calls clean-compose with probe OFF (assert default-off
  behavior path).

## Manual Verification Checklist (operator)

1. CC+IC **with** a note → accept → intro fires → **group chat** with all three; sheet
   reads "Introduction Made".
2. Re-run / duplicate the same lead → **no second message**; sheet reads "Introduction
   Already Made".
3. CC+IC **without** a note → still a group chat (unchanged).
4. Introduce Back campaign → identical to today.

## Files

- `src/linkedin/auto-intro.js` — routing fork + helpers (allowed file).
- `src/linkedin/actions.js` — gated dedupe probe inside `sendIntroViaCleanCompose`
  (off-limits file; operator-approved, gated, CC+IC-only).
- `tests/ccic-note-group-intro.test.js` — new pure-helper tests.
