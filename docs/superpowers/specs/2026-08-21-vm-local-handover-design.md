# Switching a live campaign between the VM and this Mac

**Date:** 2026-08-21
**Status:** approved (variant C)
**Repos:** app `ortus-gologin-clone` + engine `ortus-salesnav-scraper-cloud`

## Why

On 2026-08-21 an operator could not tell whether a VM campaign's acceptance check
was working. He stopped the campaign mid-check, tried to run the check on his own
machine instead, and got "A bulk check is already running. Wait for it to finish,
or press Stop." Both instructions were dead ends. The underlying hang is fixed
separately (v3.1.33), but the reason he was stuck in the first place stands:

**A campaign belongs to one side forever.** Dispatch it to the VM and the VM owns
it until it finishes. If you stop trusting the VM mid-run, there is no supported
way to take the work back, and no way to hand it the other way either.

This spec adds that: a campaign can move between the VM and the operator's Mac at
any point in its life, while sending, while checking, while monitoring.

## What already exists

Not a rewrite. The move is a generalisation of a shipped pattern.

- `POST /api/campaign/cloud/:id/edit-redispatch` (`server.js:2116`) already stops a
  cloud campaign and resumes its remaining leads elsewhere, passing the
  already-processed lead URLs as `excludeLeadUrls` so nobody is contacted twice.
- `POST /api/campaign/cloud/:id/sync-sheet-status` (`server.js:1895`) already
  mirrors sheet statuses back into the engine, fill-only, so the VM's next sweep
  does not redo work a local check already did.
- `cloudCheckLocal()` (`app.js:11388`) already runs the app's own GoLogin sweep
  against a cloud campaign's sheet. Handover for the CHECK phase is this, promoted
  from a one-off action to a durable ownership change.

The sheet is the shared source of truth both sides already write to. Handover is
therefore: stop side A, read what the sheet says is done, resume the remainder on
side B.

## Decisions (operator, 2026-08-21)

1. **The in-flight lead is retried on the new side.** Switching stops the old side
   immediately rather than draining. The lead being processed at that instant is
   treated as pending and re-attempted. Accepted consequence: if the old side had
   in fact sent it, that person may receive a second connection request.
2. **The adaptive check cadence resets to base on every switch.** An operator who
   moves a campaign wants to see something happen. `empty_check_streak` goes to 0
   and the cadence returns to their configured interval on the new side.
3. **A campaign moved local stays local.** If the laptop sleeps or the app closes,
   the campaign waits. It does not fall back to the VM. The card must say it is
   waiting on this Mac, loudly, or this becomes the next "it is stuck" report.
4. **Variant C**: the control asks first, inline on the card, naming the
   consequences before the move happens.

## Hard constraint: never a second intro DM

The operator's explicit requirement. Measured, not assumed:

- `Introduction Status` is a one-shot terminal column. Any non-blank value, including
  `Failed — …` and `Skipped — …`, blocks a re-send (`auto-intro.js:80`).
- The send loop re-reads it immediately before sending, not from a stale snapshot
  (`campaign.js:3536`).

So decision 1 is safe as far as intros go: the in-flight lead in CC+IC is a
**connect request**, not an intro. The intro fires later, after acceptance, behind
that gate. A retried connect cannot itself produce a second intro.

**The real risk is overlap, not retry.** If both sides sweep the same campaign
concurrently, two sweeps can each see the same lead as newly-Connected with a blank
`Introduction Status` and both fire an intro before either stamps. The column
cannot save us there, because neither has written yet.

Therefore:

- **Handover is strictly serialised.** The new side MUST NOT begin until the old
  side is confirmed stopped and any in-flight sweep has been observed to end. The
  UI shows this as the handover state; there is no window in which both sides own
  the campaign.
- **A campaign has exactly one owner at all times**, persisted, and both sides
  refuse to act on a campaign they do not own.

This is the one rule in this spec that may not be relaxed for speed.

## Scope: the local side needs the adaptive cadence

Measured 2026-08-21: `src/campaign.js` has **no** empty-check streak. The 1h → 2h →
4h backoff shipped yesterday lives only in the engine (`empty_check_streak`,
`checkCadenceMin`). `live-activity.mjs:51` reads the fields for display only.

So a monitoring campaign moved local today would silently lose the feature and
return to checking hourly forever. Per the operator's instruction that yesterday's
work must "also get these sorts of updates", porting the streak to the local
monitoring loop is in scope, with the same thresholds and the same 240-minute cap
that never undercuts the operator's own interval.

## Architecture

**Ownership** is a single persisted field per campaign, `runs_on ∈ {vm, local}`,
owned by the engine for cloud-dispatched campaigns and by the local monitoring
state for locally-started ones. Every actor reads it before acting.

**The move** is one endpoint per direction, both following edit-redispatch's shape:

- `POST /api/campaign/:id/handover` with `{ to: 'local' | 'vm' }`
- Stop the current side. Wait for confirmed-stopped, including any in-flight sweep.
- Read the sheet for what is already done.
- Start the remainder on the target side, excluding those leads.
- Reset `empty_check_streak` to 0 and recompute the next check from now.
- Record the move in the campaign's event log so the card can say "moved 2 min ago".

**Failure is explicit.** If the old side cannot be confirmed stopped, the handover
aborts and the campaign stays where it was. It never proceeds on a maybe, because
proceeding on a maybe is precisely the concurrent-intro case above.

## UI (variant C)

A `RUNNING ON` segmented control on the real `#active-card`, below the live line:
`Cloud VM | This Mac`, current side filled. Present while sending, checking and
monitoring.

Clicking the other side opens an inline confirm strip on the card naming, in this
order: what stops, how many leads remain, that the in-flight lead is retried and may
be sent twice, that moving here opens GoLogin browsers and needs the app open, and
that checks return to the base interval.

Three states the card must render:
- **handing over**: both buttons locked, live line narrates which way it is moving
- **moved**: new side filled, note reads "moved N min ago"
- **waiting for this Mac**: local-owned but nothing running, stated as waiting on
  the laptop rather than looking stalled

Sketch: `public/sketches/2026-08-21-vm-local-handover.html` (commit `ed5d47b`).

## Testing

The repo's pattern: pure-helper unit tests under `node --test`, manual browser
verification for UI.

- Pure: the ownership guard, the exclude-list derivation from sheet statuses, the
  cadence reset, the local empty-check streak (mirroring the engine's
  `test-check-cadence.js` cases including the base-above-cap case).
- Real-SQL, engine side: `runs_on` round-trips and a non-owner refuses to act.
- Serialisation: a test that proves the target side cannot start while the source
  is still reported running. This is the spec's load-bearing rule and needs a test
  that fails if the ordering is reversed.
- Manual: the three card states, both directions.

## Rejected

- **Auto-fallback to the VM when the laptop sleeps.** Operator chose explicit
  waiting. Reconsider only if stalled local campaigns become a real complaint.
- **Draining the in-flight lead before switching.** Operator chose the instant stop
  with a retry, accepting the duplicate-connect risk.
- **Per-phase ownership** (sending local while monitoring stays on the VM). The
  request was for the whole campaign to move. Split ownership also multiplies the
  concurrency surface the intro rule above exists to close.
