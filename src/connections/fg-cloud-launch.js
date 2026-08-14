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
 * @returns {Array} [{ account, operator, month, memberIds:[…], invited:[{memberId,url}] }]
 */
export function invitedWritebackFromLeads(cloudLeads, record) {
  const byProfile = new Map((record && record.perAccount || []).map((a) => [String(a.profileId), a]));
  const groupByProfile = new Map(); // profileId → { ids:Set(memberId), invited:[{memberId,url}] }
  for (const lead of cloudLeads || []) {
    if (!isInvited(lead)) continue;
    const meta = byProfile.get(String(lead.account));
    if (!meta) continue;
    const leadUrl = String(lead.leadUrl || '').trim();
    const memberId = meta.rowsByUrl[leadUrl];
    if (memberId === undefined) continue; // url not tracked for this profile at all
    if (!groupByProfile.has(meta.profileId)) groupByProfile.set(meta.profileId, { ids: new Set(), invited: [] });
    const g = groupByProfile.get(meta.profileId);
    if (memberId) g.ids.add(String(memberId));
    // Member ID stays the FG Invites key; the URL is what lets FG Master stamp
    // people whose linkedin_membership_id is null (a large share of the DB).
    g.invited.push({ memberId: String(memberId || ''), url: leadUrl });
  }
  return [...groupByProfile.entries()].map(([profileId, g]) => {
    const meta = byProfile.get(String(profileId));
    return { account: meta.account, operator: meta.operator, month: meta.month, memberIds: [...g.ids], invited: g.invited };
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

/**
 * The most recent run that a new launch would duplicate, or null.
 *
 * Sam dispatched the same 89 leads three times on 8 Aug — 20:16, 20:17, 20:20,
 * same page, same accounts — by pressing Start again when the first press
 * showed no immediate sign of working. The later two sent 1 and 0 invites: the
 * first had already spent the accounts' monthly invite credits, and all three
 * then sat on the board as identical cards.
 *
 * "Duplicate" is same PAGE and same SOURCE within a short window. Not same
 * accounts: the sheet names its own senders and the routing can differ run to
 * run, while the page + source pair is what actually decides who gets invited.
 *
 * The window is deliberately short. This exists to stop a double-press, not to
 * ration re-runs — a deliberate second run an hour later is legitimate (credits
 * refill, a row was fixed), and the caller can override sooner than that.
 *
 * @param {Array<Object>} runs      _fgCloudRunStore.load()
 * @param {Object} launch           { pageId, sheetUrl, tab }
 * @param {Object} [opts]           { now = Date.now(), windowMs }
 * @returns {Object|null} the run being duplicated
 */
export function duplicateFgRun(runs, launch, opts = {}) {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 15 * 60 * 1000;
  const key = (r) => `${String(r?.pageId || '')}|${String(r?.sheetUrl || '')}|${String(r?.tab || '')}`;
  const want = key(launch);
  let best = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (key(r) !== want) continue;
    const at = Date.parse(r?.dispatchedAt || '');
    if (!Number.isFinite(at)) continue;          // undated run — can't judge, don't block
    const age = now - at;
    if (age < 0 || age > windowMs) continue;
    if (!best || at > Date.parse(best.dispatchedAt)) best = r;
  }
  return best;
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
      await deps.markInvited({ memberIds: g.memberIds, invited: g.invited, account: g.account, operator: g.operator, month: g.month });
    } catch (e) {
      deps.log(`⚠ STRANDED: ${g.memberIds.length} invite(s) WERE sent for ${g.account} but the FG-sheet write-back failed — they will be re-checked next reconcile (${e.message})`);
      return { reconciled: false, stranded: true };
    }
  }

  // Whatever is still 'Queued' for this run was never sent — flip it to Failed with
  // a per-lead reason so the sheet shows a red line + WHY, not permanent limbo.
  if (deps.markFailed) {
    const reasons = fgFailureReasons(leads, record, status);
    try { await deps.markFailed({ runId: record.cloudId, reason: 'Not sent', reasons }); }
    catch (e) { deps.log(`⚠ FG failure-sweep write failed (${e.message})`); }
  }

  return { reconciled: true, groups: groups.length };
}

// Per-lead failure reasons for a reconciled run, keyed by Member ID, from what the
// engine actually exposes to reconcile: each lead's own `error` (the engine's own
// words — "profile not found", a timeout/VM error, …), else "Campaign stopped" when
// the run was killed, else an honest generic. We deliberately do NOT guess
// logged-out-vs-out-of-credits: reconcile only sees leads, not per-account FG
// results, so a specific claim there would be fabrication. ponytail: upgrade to
// exact account reasons only if the engine persists its per-account FG result.
export function fgFailureReasons(leads, record, status) {
  const stopped = status === 'cancelled' || status === 'stopped';
  const byUrl = {}; // leadUrl -> Member ID, from the run record's per-account maps
  for (const a of (record && record.perAccount) || []) Object.assign(byUrl, a.rowsByUrl || {});
  const out = {};
  for (const l of leads || []) {
    if (l.stage === 'Invited' || l.status === 'sent') continue; // sent → not a failure
    const memberId = byUrl[String(l.leadUrl || '').trim()];
    if (!memberId) continue;
    out[String(memberId)] = l.error ? String(l.error)
      : stopped ? 'Campaign stopped before it sent'
      : 'Not sent — check the account (logged out / no credits / browser didn’t open)';
  }
  return out;
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
    config: {
      inviteUrl: deps.inviteUrl, monthlyBudget: deps.monthlyBudget,
      // Engine labels every log line / account pill with config.accountEmails —
      // without it the run prints raw 24-hex GoLogin ids.
      accountEmails: Object.fromEntries(pairs.map((p) => [p.profileId, p.account])),
    },
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
    // The identity duplicateFgRun matches on. This path builds its own list
    // from the connections DB rather than reading a sheet or a tab, so those
    // two stay empty and the page alone identifies it — which is what keeps it
    // from ever colliding with a list run on the same page.
    pageId: deps.pageId || '',
    sheetUrl: '',
    tab: '',
    perAccount: perAccount.map((a) => ({
      profileId: a.profileId, account: a.account, operator: a.operator, month: deps.month, rowsByUrl: a.rowsByUrl,
    })),
  });
  return { cloudId };
}
