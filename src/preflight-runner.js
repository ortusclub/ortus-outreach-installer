/**
 * One-shot preflight runner — launches profiles, runs preflight, closes them.
 * Used by the "Verify primary person now" dev-tool button. No campaign
 * lifecycle implications.
 *
 * Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md
 */

import { runPreflight } from './preflight-primary.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';

/**
 * Launch each profile, run the preflight verifier across all of them, then
 * close every profile regardless of pass/fail. Returns the preflight result.
 *
 * @param {object} args
 * @param {string[]} args.profileIds
 * @param {string}   args.primaryName
 * @param {string}   args.primaryUrl
 * @param {Object}   [args.profileNameMap]  - { [profileId]: displayName }
 * @param {Function} [args.log]             - (msg: string) => void
 * @returns {Promise<{ allPassed: boolean, results: Array<object> }>}
 */
export async function runPreflightStandalone({
  profileIds,
  primaryName,
  primaryUrl,
  profileNameMap = {},
  log = () => {},
}) {
  if (!Array.isArray(profileIds) || profileIds.length === 0) {
    return {
      allPassed: false,
      results: [{
        profileName: 'config',
        ok: false,
        failureType: 'config',
        detail: 'No profile IDs provided',
      }],
    };
  }
  if (!primaryName || !primaryUrl) {
    return {
      allPassed: false,
      results: [{
        profileName: 'config',
        ok: false,
        failureType: 'config',
        detail: 'primaryName or primaryUrl missing',
      }],
    };
  }

  const token = process.env.GOLOGIN_API_TOKEN;
  const launched = []; // { profileId, profileName, browser, page } | { profileId, profileName, launchError }

  try {
    for (const pid of profileIds) {
      const profileName = profileNameMap[pid] || pid;
      try {
        log(`▶ Opening ${profileName}…`);
        const session = await launchProfile(pid, token);
        launched.push({ profileId: pid, profileName, browser: session.browser, page: session.page });
        log(`✓ ${profileName} opened`);
      } catch (e) {
        log(`✕ ${profileName} failed to launch: ${e.message}`);
        launched.push({ profileId: pid, profileName, launchError: e.message });
      }
    }

    const verifiable = launched
      .filter(s => !s.launchError)
      .map(s => ({ profileId: s.profileId, profileName: s.profileName, page: s.page }));

    const launchFailures = launched
      .filter(s => s.launchError)
      .map(s => ({
        profileId: s.profileId,
        profileName: s.profileName,
        ok: false,
        failureType: 'launch_failed',
        detail: s.launchError,
      }));

    let preflight;
    if (verifiable.length > 0) {
      preflight = await runPreflight({ sessions: verifiable, primaryName, primaryUrl, log });
    } else {
      preflight = { allPassed: false, results: [] };
    }

    preflight.results.push(...launchFailures);
    if (launchFailures.length > 0) preflight.allPassed = false;

    return preflight;
  } finally {
    // Always close everything, pass or fail — no campaign follows.
    for (const s of launched) {
      if (s.launchError) continue; // never launched, nothing to close
      try { await closeProfile(s.profileId); } catch { /* best-effort */ }
    }
  }
}
