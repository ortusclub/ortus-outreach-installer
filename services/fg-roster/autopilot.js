// FG Auto-Pilot orchestration — decide + dispatch one run. All real I/O is
// injected, so this is unit-testable with no engine, no filesystem, no HTTP.
// Targets come from the connections DB, capped per account at the monthly FG
// allowance (~30) so a run dispatches ~30 invites/account, not every match. The
// engine still skips already-following/invited and caps to live invite credits.
import { shouldFire, cycleKey, nextRun } from '../../src/fg-autopilot.js';
import { readFgList } from '../../src/connections/fg-sync.js';
import { fgListTabName } from '../../src/connections/fg-list.js';
import { dispatchFromRows } from '../../src/connections/fg-list-launch.js';

export function makeAutopilotHandler(deps) {
  const {
    startCloud, runStore, loadConfig, saveRuns,
    sendAlert, now, log, inviteUrl, monthlyBudget, tz = 'Europe/London',
    // Reads the pre-generated per-run invite-list tab. Injected for testability;
    // defaults to the real FG Apps Script reader. (already-invited de-dupe now
    // happens at Generate time, and the engine's own already-following guard is
    // the backstop — so the fire no longer needs getFgState here.)
    readList = (tab) => readFgList(tab),
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
      // The invite list is now a pre-generated, editable Google Sheet tab (FG board
      // → "Generate list"). The fire READS that tab and works down it — it no longer
      // builds the list itself. The tab is named for the run day, so a list made
      // ahead of time is picked up on the 1st/15th. A "Run now" (force) reads the
      // upcoming run's tab (same one Generate wrote). Missing tab → skip + alert.
      const runCycleKey = force
        ? cycleKey(nextRun(nd, { days: config.days || [1, 15], enabled: true }) || nd, tz)
        : key;
      const tab = fgListTabName(runCycleKey);

      let rows;
      try {
        rows = await readList(tab);
      } catch (e) {
        runStore.add({ cycleKey: key, status: 'failed', error: e.message, dispatchedAt: now(), source: force ? 'manual' : 'auto' });
        saveRuns();
        try { await sendAlert(`⚠️ FG Auto-Pilot could not read the list — ${key}`, `Tab: ${tab}\nError: ${e.message}`); } catch (_) {}
        return { failed: true, error: e.message, cycleKey: key, tab };
      }
      if (!rows || rows.length < 2) {
        // No list generated for this run — the operator hasn't pressed Generate.
        // Alert (not a failure, so it doesn't block a later re-fire once generated).
        try { await sendAlert(`FG Auto-Pilot — no invite list for ${tab}`, `Nothing fired for ${key}.\n\nGenerate the list first: FG board → "Generate list from roles". The scheduled run reads whatever tab exists.`); } catch (_) {}
        return { skipped: true, reason: 'no-list', cycleKey: key, tab };
      }

      const accountEmails = Object.fromEntries((config.pairs || []).map((p) => [p.profileId, p.account]));
      const result = await dispatchFromRows(rows, {
        accountEmails,
        campaign: {
          name: `Team Follower Growth · ${month} · auto`,
          owner: config.publishedBy || '',
          config: { inviteUrl, monthlyBudget },
        },
      }, { startCloud });

      if (result.error) {
        // A list with no usable rows (all bad accounts) is benign — don't record a
        // `failed` run (that would block a re-fire once the tab is fixed).
        if (/^No invites to send/.test(result.error)) {
          return { skipped: true, reason: 'no-usable-rows', cycleKey: key, tab, listSkipped: result.skipped || [] };
        }
        runStore.add({ cycleKey: key, status: 'failed', error: result.error, dispatchedAt: now(), source: force ? 'manual' : 'auto', tab });
        saveRuns();
        try { await sendAlert(`⚠️ FG Auto-Pilot run failed — ${key}`, `Cycle ${key}\nTab: ${tab}\nError: ${result.error}`); }
        catch (_) { /* alerting must never mask the original failure */ }
        return { failed: true, error: result.error, cycleKey: key, tab };
      }

      runStore.add({
        cloudId: result.cloudId, cycleKey: key, source: force ? 'manual' : 'auto',
        month, tab, listDriven: true, perAccount: result.perAccount || [],
        dispatchedAt: now(),
      });
      saveRuns();
      return { dispatched: true, cloudId: result.cloudId, cycleKey: key, tab, listSkipped: result.skipped || [] };
    },
  };
}
