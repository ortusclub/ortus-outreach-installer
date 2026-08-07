// services/fg-roster/reconcile.js
// Server-side reconcile pass for FG cloud runs. Mirrors the app's
// reconcileListRun (server.js) so write-back happens even when no operator
// has the desktop app open. Runs on every daily CronJob tick (via the
// autopilot handler), not just dispatch days. All I/O is injected for
// testability.

import { ledgerUpdatesFromLeads } from '../../src/connections/fg-list.js';
import { invitedWritebackFromLeads } from '../../src/connections/fg-cloud-launch.js';

const TERMINAL = new Set(['done', 'error', 'stopped', 'cancelled']);

/**
 * Reconcile a single list-driven cloud run record.
 * Mirrors the app's reconcileListRun: stamps the run tab ledger, writes
 * invited + already-follows to FG Invites, and observes credits at terminal.
 *
 * @param {Object} record  { cloudId, kind, tab, perAccount, month, status }
 * @param {Object} deps
 * @param {(id)=>Promise} deps.getCampaign
 * @param {(id)=>Promise} deps.getLeads
 * @param {(id)=>Promise} deps.getAccounts
 * @param {(tab,updates)=>Promise} deps.updateLedger
 * @param {(args)=>Promise} deps.markInvited
 * @param {(args)=>Promise} deps.observeCredits
 * @param {(msg)=>void} deps.log
 * @returns {Promise<{reconciled:boolean}>}
 */
export async function reconcileListRecord(record, deps) {
  if (!record || !record.cloudId) return { reconciled: false };
  if (record.status === 'reconciled') return { reconciled: true };

  const camp = await deps.getCampaign(record.cloudId);
  const status = String((camp && (camp.campaign?.status ?? camp.status)) || '');

  let leads = [];
  try {
    const res = await deps.getLeads(record.cloudId);
    leads = (res && res.leads) || [];
  } catch (e) {
    deps.log(`reconcile ${record.cloudId}: could not read leads (${e.message})`);
    return { reconciled: false };
  }

  // Stamp the run's own tab ledger (Status / Invited At / Note / Member ID).
  const updates = ledgerUpdatesFromLeads(leads);
  if (updates.length && record.tab) {
    try {
      const r = await deps.updateLedger(record.tab, updates);
      deps.log(`reconcile ${record.cloudId}: stamped ${r.updated} row(s) in "${record.tab}"`);
    } catch (e) {
      deps.log(`reconcile ${record.cloudId}: ledger stamp failed (${e.message})`);
    }
  }

  // Write invited + already-follows to FG Invites (de-dupe source).
  if (record.perAccount) {
    const groups = invitedWritebackFromLeads(leads, record);

    // Already-follows: same merge as the app's reconcileListRun (Gap 4).
    const byUrl = {};
    for (const a of record.perAccount) Object.assign(byUrl, a.rowsByUrl || {});
    const byProfileMeta = new Map(record.perAccount.map((a) => [String(a.profileId), a]));
    const alreadyFollowsById = new Map();
    for (const l of leads) {
      if (l.status !== 'skipped' || !/already follow/i.test(l.error || '')) continue;
      const memberId = byUrl[String(l.leadUrl || '').trim()];
      if (!memberId) continue;
      const profileId = String(l.account || '');
      if (!profileId || !byProfileMeta.has(profileId)) continue;
      if (!alreadyFollowsById.has(profileId)) alreadyFollowsById.set(profileId, new Set());
      alreadyFollowsById.get(profileId).add(String(memberId));
    }
    for (const [profileId, ids] of alreadyFollowsById) {
      const existing = groups.find((g) => byProfileMeta.get(profileId)?.account === g.account);
      if (existing) {
        for (const id of ids) if (!existing.memberIds.includes(id)) existing.memberIds.push(id);
      } else {
        const meta = byProfileMeta.get(profileId);
        groups.push({ account: meta.account, operator: meta.operator, month: meta.month, memberIds: [...ids] });
      }
    }

    for (const g of groups) {
      try {
        await deps.markInvited({ memberIds: g.memberIds, account: g.account, operator: g.operator, month: g.month });
        deps.log(`reconcile ${record.cloudId}: marked ${g.memberIds.length} invite(s)/follow(s) for ${g.account}`);
      } catch (e) {
        deps.log(`reconcile ${record.cloudId}: FG Invites writeback failed for ${g.account} (${e.message})`);
      }
    }
  }

  const terminal = TERMINAL.has(status);

  // Observe credits at terminal (Gap 3).
  if (terminal && record.perAccount && deps.observeCredits) {
    try {
      const acctResp = await deps.getAccounts(record.cloudId);
      const cloudAccounts = (acctResp && acctResp.accounts) || [];
      for (const ca of cloudAccounts) {
        if (!ca.credits || ca.credits.available == null) continue;
        const meta = record.perAccount.find((a) => a.profileId === ca.profileId);
        if (!meta) continue;
        try {
          await deps.observeCredits({
            account: meta.account, operator: meta.operator, month: meta.month,
            available: ca.credits.available, allowance: ca.credits.allowance,
            refill: ca.credits.refill || '',
          });
          deps.log(`reconcile ${record.cloudId}: observed credits for ${meta.account} — ${ca.credits.available}/${ca.credits.allowance}`);
        } catch (e) {
          deps.log(`reconcile ${record.cloudId}: credit observation failed for ${meta.account} (${e.message})`);
        }
      }
    } catch (e) {
      deps.log(`reconcile ${record.cloudId}: could not read accounts for credits (${e.message})`);
    }
  }

  return { reconciled: terminal };
}

/**
 * Reconcile all unreconciled list runs in the run store.
 * @param {Object} runStore  { load(), update(cloudId, patch) }
 * @param {Object} deps      same as reconcileListRecord deps
 * @returns {Promise<{processed:number, reconciled:number}>}
 */
export async function reconcileAll(runStore, deps) {
  const runs = runStore.load() || [];
  let processed = 0, reconciled = 0;
  for (const record of runs) {
    if (record.status === 'reconciled') continue;
    // Only list-driven runs — legacy runs are app-only.
    if (record.kind && record.kind !== 'list') continue;
    processed++;
    try {
      const out = await reconcileListRecord(record, deps);
      if (out.reconciled) {
        runStore.update(record.cloudId, { status: 'reconciled' });
        reconciled++;
      }
    } catch (e) {
      deps.log(`reconcile ${record.cloudId}: unexpected error (${e.message})`);
    }
  }
  return { processed, reconciled };
}
