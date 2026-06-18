// v2.112: the per-turn "keep sending this profile's batch?" gate. Extracted pure so the
// mid-turn bench fix is unit-tested. Mirrors the inner-loop condition in campaign.js plus
// the new benched check (#2a / H1).
export function shouldContinueTurn({ abort, orphan, weeklyLimited, benched }) {
  return !abort && !orphan && !weeklyLimited && !benched;
}

// v2.112 (#2a/H2): a profile can be re-queued only if it isn't already queued and isn't
// mid-turn — fixes a parked-then-retried profile that drained from the queue being stranded,
// and avoids double-enqueue.
export function shouldRequeue({ inQueue, beingRun }) {
  return !inQueue && !beingRun;
}

// v2.112 (#2b): a profile can be added to the rotation only if it has an id and isn't
// already present. Pure so the dedup rule is unit-tested.
export function canAddProfile(existingIds, id) {
  return !!id && !(existingIds || []).includes(id);
}
