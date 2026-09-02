/**
 * src/followup-groups.js — who a follow-up belongs to, and which ones are stuck.
 *
 * The follow-up queue is one flat list for the whole app (src/primary-tasks.js).
 * The dashboard showed that list's TOTALS on every campaign card, so a campaign
 * started five minutes ago reported "56 sent · 48 could not send" from campaigns
 * that finished weeks earlier (Sam, 2026-09-02). Two questions had no answer:
 * which campaign is this follow-up from, and is it still worth sending?
 *
 * WHICH CAMPAIGN. A task records campaignProfileId (a GoLogin account) but never
 * recorded the campaign. New tasks now carry campaignId/campaignName; the ones
 * already queued do not, so they are grouped by their MESSAGE instead. That is
 * not a fallback so much as the real identity: the body comes from the
 * campaign's own follow-up template, so one message is one campaign. Measured on
 * a live queue, 68 tasks with 65 distinct bodies collapsed to 11 templates once
 * the lead's name was taken out.
 *
 * IS IT STILL WORTH SENDING. Only the operator can answer that, and only by
 * reading the message: "our dinner on 4 September" is worth sending on the 2nd
 * and worthless on the 5th. So a group carries its message verbatim, and the
 * only judgement this module makes is which tasks are stuck.
 */

/** A follow-up that will not send on its own: parked on a signed-out browser,
 *  or already given up on. A plain pending task is not stuck — it is waiting. */
export function isStuck(task) {
  if (!task || task.type !== 'follow-up') return false;
  if (task.status === 'failed') return true;
  return task.status === 'pending' && !!task.blockedBySession;
}

/**
 * The campaign's follow-up template, recovered from one personalized body by
 * removing the names that vary per lead. Whitespace is normalised so a body
 * that wrapped differently still matches.
 */
export function messageTemplate(task) {
  let body = String((task && task.body) || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const names = [task.leadName, task.primaryName].filter(Boolean).map(String);
  // Longest first: replacing "Ann" before "Ann Marie" would leave " Marie".
  const parts = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]))]
    .filter((p) => p.length > 2)
    .sort((a, b) => b.length - a.length);
  for (const p of parts) body = body.split(p).join('{}');
  return body;
}

/** Stable identity for "these follow-ups are from the same campaign". */
export function groupKeyOf(task) {
  if (task && task.campaignId) return `id:${task.campaignId}`;
  const t = messageTemplate(task);
  return t ? `msg:${t}` : `acct:${(task && task.campaignProfileId) || 'unknown'}`;
}

/** Every follow-up belonging to one campaign, by whichever identity it has.
 *  campaignId wins when the task carries it; otherwise the account is the only
 *  honest filter, which is why the card also passes its profile ids. */
export function belongsToCampaign(task, { campaignId = '', profileIds = [] } = {}) {
  if (!task || task.type !== 'follow-up') return false;
  if (campaignId && task.campaignId) return task.campaignId === campaignId;
  const ids = profileIds instanceof Set ? profileIds : new Set(profileIds || []);
  return ids.has(task.campaignProfileId);
}

/** The card's counts, for ONE campaign — never the whole app's. */
export function healthForCampaign(tasks, scope) {
  const mine = (tasks || []).filter((t) => belongsToCampaign(t, scope));
  const blocked = mine.filter((t) => t.status === 'pending' && t.blockedBySession);
  const failed = mine.filter((t) => t.status === 'failed');
  return {
    sent: mine.filter((t) => t.status === 'done').length,
    pending: mine.filter((t) => t.status === 'pending' && !t.blockedBySession).length,
    blocked: blocked.length,
    failed: failed.length,
    reason: blocked.length ? 'signed-out' : (failed.length ? 'error' : ''),
    lastError: (failed[failed.length - 1] || {}).lastError || '',
  };
}

/**
 * Stuck follow-ups, grouped by campaign, newest group first.
 *
 * `liveCampaignIds` / `liveProfileIds` are the campaigns still on the operator's
 * board. Their follow-ups are shown on their own card, so excluding them here is
 * what keeps a follow-up in exactly one place on screen.
 */
export function groupStaleFollowUps(tasks, { liveCampaignIds = [], liveProfileIds = [] } = {}) {
  const liveIds = new Set(liveCampaignIds);
  const liveProfiles = new Set(liveProfileIds);
  const groups = new Map();

  for (const t of (tasks || []).filter(isStuck)) {
    if (t.campaignId && liveIds.has(t.campaignId)) continue;
    // A task with no campaignId can only be placed by its account. Treat it as
    // live when that account is running something, so the card and the strip
    // never both claim it.
    if (!t.campaignId && liveProfiles.has(t.campaignProfileId)) continue;

    const key = groupKeyOf(t);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        campaignId: t.campaignId || '',
        campaignName: t.campaignName || '',
        accounts: new Set(),
        leadNames: [],
        count: 0,
        firstQueuedAt: t.createdAt,
        lastQueuedAt: t.createdAt,
        // Verbatim, personalisation and all — the operator reads THIS to decide.
        message: String(t.body || ''),
        reason: '',
        lastError: '',
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (t.campaignName && !g.campaignName) g.campaignName = t.campaignName;
    if (t.campaignProfileName) g.accounts.add(t.campaignProfileName);
    if (t.leadName) g.leadNames.push(t.leadName);
    if (Number.isFinite(t.createdAt)) {
      g.firstQueuedAt = Math.min(g.firstQueuedAt ?? t.createdAt, t.createdAt);
      g.lastQueuedAt = Math.max(g.lastQueuedAt ?? t.createdAt, t.createdAt);
    }
    // Signed-out outranks an error: it is the one with a one-click fix.
    if (t.status === 'pending' && t.blockedBySession) g.reason = 'signed-out';
    else if (!g.reason) { g.reason = 'error'; g.lastError = t.lastError || ''; }
  }

  return [...groups.values()]
    .map((g) => ({ ...g, accounts: [...g.accounts] }))
    .sort((a, b) => (b.lastQueuedAt || 0) - (a.lastQueuedAt || 0));
}

/** Pure: mark every stuck task in these groups discarded. selectDue() only ever
 *  takes 'pending', so a discarded follow-up can never be sent. Returns a COPY
 *  plus the ids changed, which is what Undo hands back to restore(). */
export function discardGroups(tasks, keys) {
  const want = new Set(keys || []);
  const discarded = [];
  const next = (tasks || []).map((t) => {
    if (!isStuck(t) || !want.has(groupKeyOf(t))) return t;
    discarded.push({ id: t.id, status: t.status, blockedBySession: !!t.blockedBySession });
    return { ...t, status: 'discarded', discardedAt: Date.now(), discardedFrom: t.status };
  });
  return { tasks: next, discarded };
}

/** Pure: put discarded tasks back exactly as they were. */
export function restoreDiscarded(tasks, discarded) {
  const by = new Map((discarded || []).map((d) => [d.id, d]));
  return (tasks || []).map((t) => {
    const d = t && by.get(t.id);
    if (!d || t.status !== 'discarded') return t;
    const { discardedAt, discardedFrom, ...rest } = t;
    return { ...rest, status: d.status };
  });
}
