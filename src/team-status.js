/**
 * Team status aggregation (feature ⑩ — ADMIN-ONLY dashboard section).
 *
 * Pure helpers: turn a list of campaign entries (cloud engine list + this
 * machine's local campaign/queue) into per-operator rows for the admin-only
 * Team status table. No I/O here — server.js gathers the entries and the
 * /api/team-status route (admin-gated) serves the aggregate.
 *
 * Scope note: only CLOUD campaigns carry an owner across machines; local
 * campaigns of OTHER operators are invisible to this machine, so the table is
 * "cloud activity per owner + whatever is running locally on THIS machine".
 */

/**
 * Map a cloud-engine campaign status to a board bucket. Mirrors the mapping
 * used by renderCampaignsBoard() in public/js/app.js so the admin table and
 * the campaigns board never disagree about what counts as "running".
 *
 * @param {string} status engine status: running | pending | queued | done | cancelled | error | …
 * @returns {'running'|'queued'|'done'}
 */
export function bucketForCloudStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'stopping' || s === 'pausing') return 'running';
  if (s === 'pending' || s === 'queued') return 'queued';
  return 'done';
}

/**
 * Count how many of a campaign's per-lead rows were SENT today — a lead whose
 * `sentAt` (the engine's send timestamp; snake_case `sent_at` also accepted)
 * falls in [dayStartMs, dayEndMs). This is the real "today's sends", vs the
 * cumulative leadCounts.sent which spans the campaign's whole life. Pure.
 *
 * @param {Array<{sentAt?: string, sent_at?: string}>} leads engine per-lead rows
 * @param {number} dayStartMs local start-of-day epoch ms (inclusive)
 * @param {number} dayEndMs   local end-of-day epoch ms (exclusive)
 * @returns {number} count of leads sent within the window
 */
export function countLeadsSentToday(leads, dayStartMs, dayEndMs) {
  if (!Array.isArray(leads)) return 0;
  let n = 0;
  for (const l of leads) {
    if (!l) continue;
    const t = Date.parse(l.sentAt || l.sent_at || '');
    if (Number.isFinite(t) && t >= dayStartMs && t < dayEndMs) n++;
  }
  return n;
}

/**
 * Aggregate campaign entries into per-owner rows.
 *
 * @param {Array<{owner?: string, bucket?: string, sent?: number,
 *   campaignName?: string, mode?: string, accounts?: string[],
 *   accountNames?: Record<string,string>, startedAt?: number|string|null}>} entries
 *   One entry per campaign. `bucket` must be 'running' | 'queued' | 'done'
 *   (use bucketForCloudStatus for cloud statuses). `sent` is the campaign's
 *   CUMULATIVE sent count (leadCounts.sent for cloud, totalProcessed for local);
 *   `todaySent` is how many of its leads went out TODAY (countLeadsSentToday for
 *   cloud; local machine's own today for the local row). Both accumulate per owner.
 *   `campaignName`/`mode`/`accounts`/`accountNames`/`startedAt` describe the
 *   RUNNING campaign for that entry — used to enrich the owner's row when
 *   they have a running campaign. Non-running entries only contribute to the
 *   counts/sent totals.
 * @returns {Array<{owner: string, running: number, queued: number, done: number,
 *   sent: number, campaignName: string, mode: string, accounts: string[],
 *   accountNames: Record<string,string>, startedAt: number|string|null}>}
 *   One row per owner, sorted: owners with running campaigns first, then by
 *   sent desc, then owner alphabetically. Owner emails are normalized to
 *   lowercase; entries with no owner group under '(unknown)'. `campaignName`/
 *   `mode`/`startedAt` reflect the RUNNING entry with the earliest
 *   `startedAt` for that owner (or the first running entry if no entry
 *   carries a startedAt); `accounts` is the deduped union of `accounts`
 *   across that owner's running entries; `accountNames` merges every
 *   running entry's id→name map (later entries never overwrite an id
 *   already named).
 */
export function aggregateTeamStatus(entries) {
  const byOwner = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || typeof e !== 'object') continue;
    const owner = String(e.owner || '').trim().toLowerCase() || '(unknown)';
    let row = byOwner.get(owner);
    if (!row) {
      row = {
        owner, running: 0, queued: 0, done: 0, sent: 0, todaySent: 0,
        campaignName: '', mode: '', accounts: [], accountNames: {}, startedAt: null,
      };
      byOwner.set(owner, row);
    }
    const bucket = e.bucket === 'running' || e.bucket === 'queued' ? e.bucket : 'done';
    row[bucket] += 1;
    const sent = Number(e.sent);
    if (Number.isFinite(sent) && sent > 0) row.sent += sent;             // cumulative (all-time)
    const todaySent = Number(e.todaySent);
    if (Number.isFinite(todaySent) && todaySent > 0) row.todaySent += todaySent; // sent TODAY only

    if (bucket === 'running') {
      const startedAt = e.startedAt ?? null;
      const startedMs = startedAt != null ? Date.parse(startedAt) : NaN;
      const rowStartedMs = row.startedAt != null ? Date.parse(row.startedAt) : NaN;
      // Earliest-started running entry wins the display fields; if neither
      // (or the current row) has a usable timestamp, keep the first one seen.
      const shouldAdopt = !row.campaignName
        || (Number.isFinite(startedMs) && (!Number.isFinite(rowStartedMs) || startedMs < rowStartedMs));
      if (shouldAdopt) {
        row.campaignName = e.campaignName || '';
        row.mode = e.mode || '';
        row.startedAt = startedAt;
      }
      for (const acc of (Array.isArray(e.accounts) ? e.accounts : [])) {
        if (acc && !row.accounts.includes(acc)) row.accounts.push(acc);
      }
      const names = e.accountNames;
      if (names && typeof names === 'object') {
        for (const [id, name] of Object.entries(names)) {
          if (id && name && !row.accountNames[id]) row.accountNames[id] = name;
        }
      }
    }
  }
  return [...byOwner.values()].sort((a, b) =>
    (b.running - a.running) || (b.sent - a.sent) || a.owner.localeCompare(b.owner));
}

/**
 * Detect account conflicts between the Team status rows and the viewer's
 * current wizard draft selection.
 *
 * A conflict is an account id that is BOTH selected in the viewer's draft
 * AND currently "In Use" (accounts[]) by some OTHER owner's running
 * campaign. Two rows sharing the SAME owner (e.g. multiple running
 * campaigns for one operator) never conflict with each other — this only
 * flags cross-operator collisions, mirroring the sketch's "held by
 * marlon.j AND selected in your draft" copy.
 *
 * @param {Array<{owner?: string, accounts?: string[], accountNames?: Record<string,string>}>} rows
 *   Team status rows (aggregateTeamStatus output, or any array shaped like it).
 * @param {string[]} myAccountIds Viewer's current draft account-id selection.
 * @param {string} [myOwner] Viewer's own owner key (email), normalized the
 *   same way `aggregateTeamStatus` normalizes owners (trim + lowercase not
 *   required here — comparison is case-insensitive). Rows belonging to the
 *   viewer are never a conflict source — an account already In Use on the
 *   viewer's OWN running campaign isn't "held by another operator". Optional:
 *   omit when the caller has already filtered `rows` to other operators.
 * @returns {Array<{account: string, accountName: string, heldBy: string}>}
 *   One entry per conflicting account id, in the order first encountered in
 *   `rows`. Empty array when there is no overlap (including when either
 *   input is empty/absent).
 */
export function detectAccountConflicts(rows, myAccountIds, myOwner) {
  const mine = new Set((Array.isArray(myAccountIds) ? myAccountIds : []).filter(Boolean));
  if (!mine.size) return [];
  const myOwnerKey = String(myOwner || '').trim().toLowerCase();
  const conflicts = [];
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || typeof row !== 'object') continue;
    const heldBy = String(row.owner || '').trim();
    if (!heldBy) continue;
    if (myOwnerKey && heldBy.toLowerCase() === myOwnerKey) continue; // own campaign, not a conflict
    for (const acc of (Array.isArray(row.accounts) ? row.accounts : [])) {
      if (!acc || !mine.has(acc) || seen.has(acc)) continue;
      seen.add(acc);
      const accountName = (row.accountNames && row.accountNames[acc]) || acc;
      conflicts.push({ account: acc, accountName, heldBy });
    }
  }
  return conflicts;
}
