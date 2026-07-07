/**
 * Pure throttle-policy module — decide 429 recovery action without side effects.
 *
 * @module throttle-policy
 */

/**
 * Decide whether to enter cooldown or park based on episode history.
 *
 * @param {Object} opts - options object
 * @param {number} [opts.consecutive429s] - how many 429s in a row for this profile in this episode
 * @param {number} [opts.cooldownsSoFar] - how many cooldown episodes this profile has served in this run
 * @returns {Object} { action: 'cooldown'|'park', waitMs: number }
 *
 * Logic:
 * - If cooldownsSoFar < 2:
 *   - cooldownsSoFar=0 → action: 'cooldown', waitMs: 30 min (1800000 ms)
 *   - cooldownsSoFar=1 → action: 'cooldown', waitMs: 60 min (3600000 ms)
 * - If cooldownsSoFar >= 2:
 *   - action: 'park', waitMs: 0
 *
 * Missing/negative values are treated as 0.
 */
export function decide429({ consecutive429s, cooldownsSoFar } = {}) {
  // Input validation: treat missing/negative values as 0
  const cooldowns = Math.max(0, cooldownsSoFar ?? 0);

  // Determine action and wait time based on cooldown episode count
  if (cooldowns < 2) {
    // First or second episode: enter cooldown
    const waitMs = cooldowns === 0 ? 30 * 60 * 1000 : 60 * 60 * 1000;
    return { action: 'cooldown', waitMs };
  }

  // Third or subsequent episode: park the profile
  return { action: 'park', waitMs: 0 };
}
