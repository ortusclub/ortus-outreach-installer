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
