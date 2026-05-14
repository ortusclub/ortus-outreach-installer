/**
 * Pre-flight orchestrator — runs verifyPrimaryPerson across all active
 * sender profiles in parallel with an overall timeout.
 *
 * Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md §6
 */

import { verifyPrimaryPerson as defaultVerifier } from './linkedin/verify-primary-person.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {object} args
 * @param {Array<{profileId, profileName, page}>} args.sessions
 * @param {string} args.primaryName
 * @param {string} args.primaryUrl
 * @param {Function} [args.log]
 * @param {number}   [args.overallTimeoutMs]
 * @param {Function} [args.verifier]  - DI hook for tests
 * @returns {Promise<{ allPassed: boolean, results: Array<object> }>}
 */
export async function runPreflight({
  sessions,
  primaryName,
  primaryUrl,
  log = () => {},
  overallTimeoutMs = DEFAULT_TIMEOUT_MS,
  verifier = defaultVerifier,
}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { allPassed: true, results: [] };
  }

  // Per-profile promise: never rejects — always resolves with a result object.
  const perProfile = sessions.map(async (sess) => {
    try {
      const r = await verifier({
        page: sess.page,
        profileName: sess.profileName,
        primaryName,
        primaryUrl,
        log,
      });
      return { profileId: sess.profileId, profileName: sess.profileName, ...r };
    } catch (err) {
      return {
        profileId: sess.profileId,
        profileName: sess.profileName,
        ok: false,
        failureType: 'crash',
        detail: err.message,
      };
    }
  });

  // Race per-profile promises against an overall timeout. Profiles still
  // pending at the deadline are reported as failureType=timeout.
  const timeoutMarker = Symbol('timeout');
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(timeoutMarker), overallTimeoutMs);
  });

  const settledOrTimeout = await Promise.race([
    Promise.all(perProfile),
    timeoutPromise,
  ]);

  let results;
  if (settledOrTimeout === timeoutMarker) {
    // Build results from whatever resolved; mark unresolved as timeout.
    results = await Promise.all(perProfile.map(async (p, i) => {
      const sess = sessions[i];
      const resolved = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r(null), 0)),
      ]);
      if (resolved) return resolved;
      return {
        profileId: sess.profileId,
        profileName: sess.profileName,
        ok: false,
        failureType: 'timeout',
        detail: `Verifier did not complete within ${overallTimeoutMs}ms`,
      };
    }));
  } else {
    results = settledOrTimeout;
  }

  return {
    allPassed: results.every(r => r.ok),
    results,
  };
}
