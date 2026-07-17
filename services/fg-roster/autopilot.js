// FG Auto-Pilot orchestration — decide + dispatch one run. All real I/O is
// injected, so this is unit-testable with no engine, no filesystem, no HTTP.
// Targets come from the connections DB, capped per account at the monthly FG
// allowance (~30) so a run dispatches ~30 invites/account, not every match. The
// engine still skips already-following/invited and caps to live invite credits.
import { shouldFire, cycleKey, fgCriteria } from '../../src/fg-autopilot.js';
import { startTeamLaunchCloud } from '../../src/connections/fg-cloud-launch.js';
import { invitedKeysFromState } from '../../src/connections/fg-sync.js';

export function makeAutopilotHandler(deps) {
  const {
    searchService, startCloud, queueInvites, runStore, loadConfig, saveRuns,
    sendAlert, now, log, inviteUrl, monthlyBudget, tz = 'Europe/London',
    // Reads the FG sheet's already-invited list so a run skips people already done
    // — mirrors the manual /api/fg/team-launch/start path. Optional/injected so the
    // handler stays unit-testable; falls back to "invite nobody twice unknown" = [].
    getFgState = async () => ({ invites: [] }),
  } = deps;

  return {
    async run({ force = false, nowDate } = {}) {
      const nd = nowDate || new Date(now());
      const config = loadConfig() || {};
      const ranKeys = (runStore.load() || []).map((r) => r.cycleKey).filter(Boolean);

      let key;
      if (force) {
        // Manual "Run now": bypass the gate, but still need pairs to do anything.
        if (!Array.isArray(config.pairs) || !config.pairs.length) return { skipped: true, reason: 'no-pairs' };
        const manualN = ranKeys.filter((k) => k.startsWith(cycleKey(nd, tz) + '-manual-')).length + 1;
        key = `${cycleKey(nd, tz)}-manual-${manualN}`;
      } else {
        const decision = shouldFire(nd, config, ranKeys, tz);
        if (!decision.fire) return { skipped: true, reason: decision.reason };
        key = decision.cycleKey;
      }

      const month = cycleKey(nd, tz).slice(0, 7); // YYYY-MM
      // Skip people already invited this month — same key format the manual path uses
      // (Member ID, else LinkedIn URL). Best-effort: a sheet hiccup must not block the
      // run, so an unreadable sheet falls back to [] (worst case: a re-invite the
      // engine's own already-following/invited guard still catches).
      let alreadyInvited = [];
      try {
        const snap = await getFgState();
        alreadyInvited = invitedKeysFromState(snap.invites);
      } catch (e) { (log || (() => {}))(`⚠ FG sheet unreachable, not skipping already-invited (${e.message})`); }
      const buildTargets = (pair) => {
        const out = searchService.buildFgTargets(fgCriteria(config.keywords || []), {
          operator: pair.operator, operatorName: pair.operatorName,
          account: pair.account, month, alreadyInvited, budget: monthlyBudget,
        });
        let reason = '';
        if (!out.count) reason = out.matched === 0 ? 'no connections match these roles' : 'no eligible targets';
        return { rows: out.rows, count: out.count, reason };
      };

      let result;
      let threw = false;
      try {
        result = await startTeamLaunchCloud(config.pairs, {
          buildTargets,
          startCloud,
          queueInvites: queueInvites || (async () => {}),
          runStore,
          now,
          log: log || (() => {}),
          month,
          owner: config.publishedBy || '',
          name: `Team Follower Growth · ${month} · auto`,
          inviteUrl,
          monthlyBudget,
        });
      } catch (e) {
        result = { error: e.message };
        threw = true;
      }

      if (result.error) {
        // No targets to send is a benign, expected outcome (nobody matched the
        // criteria this cycle) — not a failure. Don't alert, don't record a
        // `failed` run (that would write a cycleKey and block a later re-fire).
        // Only startTeamLaunchCloud's own {error} return can be this benign case;
        // a thrown exception is always a genuine dispatch/engine error.
        if (!threw && /^No invites to send —/.test(result.error)) {
          return { skipped: true, reason: 'no-eligible-targets' };
        }
        runStore.add({ cycleKey: key, status: 'failed', error: result.error, dispatchedAt: now(), source: force ? 'manual' : 'auto' });
        saveRuns();
        try { await sendAlert(`⚠️ FG Auto-Pilot run failed — ${key}`, `Cycle ${key}\nStage: dispatch\nError: ${result.error}\n\nFix, then use "Run now" from the FG board.`); }
        catch (_) { /* alerting must never mask the original failure */ }
        return { failed: true, error: result.error, cycleKey: key };
      }

      // startTeamLaunchCloud already added a {cloudId,...} record; tag it with the cycle key + source.
      runStore.update(result.cloudId, { cycleKey: key, source: force ? 'manual' : 'auto' });
      saveRuns();
      return { dispatched: true, cloudId: result.cloudId, cycleKey: key };
    },
  };
}
