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
  if (s === 'running') return 'running';
  if (s === 'pending' || s === 'queued') return 'queued';
  return 'done';
}

/**
 * Aggregate campaign entries into per-owner rows.
 *
 * @param {Array<{owner?: string, bucket?: string, sent?: number}>} entries
 *   One entry per campaign. `bucket` must be 'running' | 'queued' | 'done'
 *   (use bucketForCloudStatus for cloud statuses). `sent` is the campaign's
 *   sent count (leadCounts.sent for cloud, totalProcessed for local).
 * @returns {Array<{owner: string, running: number, queued: number, done: number, sent: number}>}
 *   One row per owner, sorted: owners with running campaigns first, then by
 *   sent desc, then owner alphabetically. Owner emails are normalized to
 *   lowercase; entries with no owner group under '(unknown)'.
 */
export function aggregateTeamStatus(entries) {
  const byOwner = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || typeof e !== 'object') continue;
    const owner = String(e.owner || '').trim().toLowerCase() || '(unknown)';
    let row = byOwner.get(owner);
    if (!row) { row = { owner, running: 0, queued: 0, done: 0, sent: 0 }; byOwner.set(owner, row); }
    const bucket = e.bucket === 'running' || e.bucket === 'queued' ? e.bucket : 'done';
    row[bucket] += 1;
    const sent = Number(e.sent);
    if (Number.isFinite(sent) && sent > 0) row.sent += sent;
  }
  return [...byOwner.values()].sort((a, b) =>
    (b.running - a.running) || (b.sent - a.sent) || a.owner.localeCompare(b.owner));
}
