import fs from 'node:fs';

// Cloud dispatch + reconcile for the Follower Growth Team Launch flow.
// Pure functions; all I/O is injected via `deps` so this is unit-testable
// with no browser, no HTTP, no filesystem. Mirrors the local path's write-back
// semantics (server.js:2379-2474) against the FG sheet.

// FG row column indices — mirror src/connections/fg-export.js FG_HEADER.
const I_NAME = 0, I_URL = 1, I_MEMBER = 2, I_COMPANY = 3, I_TITLE = 4;

/**
 * Build each pair's targets and flatten to engine leads.
 * @param {Array} pairs  [{ profileId, account, operator, operatorName }]
 * @param {{month:string}} ctx
 * @param {{buildTargets:(pair)=>{rows:Array,count:number,reason:string}}} deps
 * @returns {{ perAccount:Array, leads:Array }}
 */
export function buildCloudLeads(pairs, ctx, deps) {
  const month = ctx && ctx.month;
  const perAccount = [];
  const leads = [];
  const seen = new Set(); // memberId already claimed by an earlier pair (cross-account dedup)
  for (const pair of pairs || []) {
    const built = deps.buildTargets(pair) || {};
    const rows = Array.isArray(built.rows) ? built.rows : [];
    const rowsByUrl = {};
    const keptRows = [];
    for (const r of rows) {
      const leadUrl = String(r[I_URL] || '').trim();
      if (!leadUrl) continue;
      const memberId = String(r[I_MEMBER] || '');
      if (memberId && seen.has(memberId)) continue;
      if (memberId) seen.add(memberId);
      rowsByUrl[leadUrl] = memberId;
      keptRows.push(r);
      leads.push({
        leadUrl,
        fullName: r[I_NAME],
        memberUrn: null,
        routeAccount: pair.profileId,
        row: { memberId, name: r[I_NAME], company: r[I_COMPANY], title: r[I_TITLE] },
      });
    }
    perAccount.push({
      profileId: pair.profileId,
      account: pair.account,
      operator: pair.operator,
      month,
      rows: keptRows,
      rowsByUrl,
      count: keptRows.length,
      reason: built.reason || '',
    });
  }
  return { perAccount, leads };
}

function isInvited(lead) {
  return lead && (lead.stage === 'Invited' || lead.status === 'sent');
}

/**
 * Turn cloud per-lead rows into per-account markFgInvited arguments.
 * @param {Array} cloudLeads [{ leadUrl, account(=profileId), stage, status }]
 * @param {{perAccount:Array}} record
 * @returns {Array} [{ account, operator, month, memberIds:[…] }]
 */
export function invitedWritebackFromLeads(cloudLeads, record) {
  const byProfile = new Map((record && record.perAccount || []).map((a) => [String(a.profileId), a]));
  const idsByProfile = new Map(); // profileId → Set(memberId)
  for (const lead of cloudLeads || []) {
    if (!isInvited(lead)) continue;
    const meta = byProfile.get(String(lead.account));
    if (!meta) continue;
    const memberId = meta.rowsByUrl[String(lead.leadUrl || '').trim()];
    if (!memberId) continue;
    if (!idsByProfile.has(meta.profileId)) idsByProfile.set(meta.profileId, new Set());
    idsByProfile.get(meta.profileId).add(String(memberId));
  }
  return [...idsByProfile.entries()].map(([profileId, ids]) => {
    const meta = byProfile.get(String(profileId));
    return { account: meta.account, operator: meta.operator, month: meta.month, memberIds: [...ids] };
  });
}

export function makeRunStore(filePath) {
  const load = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) || []; }
    catch { return []; }
  };
  const save = (runs) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
    fs.renameSync(tmp, filePath);
  };
  return {
    load,
    save,
    add(run) { const runs = load(); runs.push(run); save(runs); },
    update(cloudId, patch) {
      const runs = load();
      const i = runs.findIndex((r) => r.cloudId === cloudId);
      if (i < 0) return false;
      runs[i] = { ...runs[i], ...patch };
      save(runs);
      return true;
    },
  };
}

const TERMINAL_STATUS = new Set(['done', 'error', 'stopped', 'cancelled']);

export async function reconcileCloudRun(record, deps) {
  if (record && record.status === 'reconciled') return { reconciled: true };
  const camp = await deps.getCampaign(record.cloudId);
  const status = camp && (camp.status || (camp.campaign && camp.campaign.status));
  if (!status || !TERMINAL_STATUS.has(status)) return { reconciled: false, status: status || 'unknown' };

  const res = await deps.getLeads(record.cloudId);
  const leads = (res && res.leads) || [];
  const groups = invitedWritebackFromLeads(leads, record);
  for (const g of groups) {
    try {
      await deps.markInvited({ memberIds: g.memberIds, account: g.account, operator: g.operator, month: g.month });
    } catch (e) {
      deps.log(`⚠ STRANDED: ${g.memberIds.length} invite(s) WERE sent for ${g.account} but the FG-sheet write-back failed — they will be re-checked next reconcile (${e.message})`);
      return { reconciled: false, stranded: true };
    }
  }

  // Whatever is still 'Queued' for this run was never sent — flip it to Failed so
  // the sheet shows a red line + reason instead of permanent limbo. Best-effort.
  if (deps.markFailed) {
    try { await deps.markFailed({ runId: record.cloudId, reason: 'not sent — account may be logged out or out of credits' }); }
    catch (e) { deps.log(`⚠ FG failure-sweep write failed (${e.message})`); }
  }

  return { reconciled: true, groups: groups.length };
}

/**
 * Dispatch a Follower Growth Team Launch to the cloud engine.
 * Orchestrates target building, dispatch, proof-at-launch queuing, and record persistence.
 * @param {Array} pairs [{ profileId, account, operator, operatorName }]
 * @param {{buildTargets, startCloud, queueInvites, runStore, now, log, month, owner, name, inviteUrl, monthlyBudget}} deps
 * @returns {Promise<{cloudId}|{error}>}
 */
export async function startTeamLaunchCloud(pairs, deps) {
  const { perAccount, leads } = buildCloudLeads(pairs, { month: deps.month }, { buildTargets: deps.buildTargets });
  if (!leads.length) {
    const reason = (perAccount.find((a) => a.reason) || {}).reason || 'no eligible targets';
    return { error: `No invites to send — ${reason}.` };
  }
  const resp = await deps.startCloud({
    mode: 'follower_growth',
    name: deps.name || `Team Follower Growth · ${deps.month}`,
    owner: deps.owner || '',
    profileIds: [...new Set(pairs.map((p) => p.profileId))],
    leads,
    config: { inviteUrl: deps.inviteUrl, monthlyBudget: deps.monthlyBudget },
  });
  if (!resp || resp.error || !resp.id) return { error: (resp && resp.error) || 'Cloud dispatch failed.' };
  const cloudId = resp.id;

  // Proof-at-launch — ONLY after a successful dispatch, so a failed dispatch
  // never strands Queued rows. Best-effort: a sheet hiccup must not fail the run.
  const runAt = deps.now();
  const allRows = perAccount.flatMap((a) => a.rows);
  try { if (allRows.length) await deps.queueInvites(allRows, { runId: cloudId, runAt }); }
  catch (e) { deps.log(`⚠ FG-sheet Queue write failed at launch (${e.message}) — invites still dispatched; reconcile will still flip Invited.`); }

  deps.runStore.add({
    cloudId,
    month: deps.month,
    dispatchedAt: deps.now(),
    status: 'dispatched',
    perAccount: perAccount.map((a) => ({
      profileId: a.profileId, account: a.account, operator: a.operator, month: deps.month, rowsByUrl: a.rowsByUrl,
    })),
  });
  return { cloudId };
}
