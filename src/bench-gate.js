// v2.112: the per-turn "keep sending this profile's batch?" gate. Extracted pure so the
// mid-turn bench fix is unit-tested. Mirrors the inner-loop condition in campaign.js plus
// the new benched check (#2a / H1).
export function shouldContinueTurn({ abort, orphan, weeklyLimited, benched }) {
  return !abort && !orphan && !weeklyLimited && !benched;
}
