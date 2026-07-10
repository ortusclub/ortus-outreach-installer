/**
 * Cloud primary-handshake — app-side mapping + once-only guards.
 *
 * When a cloud CC+IC / CC+DM campaign's primary person lives only in the local
 * browser, the engine pauses in state:'awaiting_primary_accept' and lists the
 * sender invitations it fired at the primary. This machine's local browser
 * accepts them (reusing the primary-task-runner), then signals the engine to
 * resume. Pure mappers here turn the engine's senders[] into the accept-task
 * shape; the tiny disk store makes the 4s board poll fire the accept exactly
 * once per campaign (the one-time modal is deduped client-side per session in
 * app.js's _hsModalShown Set). See docs/cloud-engine-primary-handshake-spec.md.
 */
import fs from 'fs/promises';
import { dataPath } from './paths.js';

const FILE = dataPath('cloud-primary-handshake.json');
const MAX_CAMPAIGNS = 300;

// ── Pure mappers ────────────────────────────────────────────────────────────

/** True only when the engine reports this campaign is paused for the accept. */
export function isAwaitingAccept(detail) {
  return (((detail && detail.campaign) || {}).state) === 'awaiting_primary_accept';
}

/**
 * Map the engine's unaccepted senders[] → the { account:{name,profileUrl}, profileId }
 * shape buildAcceptTask/pickInvitation consume. Skips senders already accepted.
 */
export function sendersToAcceptTasks(detail) {
  const senders = ((detail && detail.campaign && detail.campaign.senders) || []);
  return senders
    .filter((s) => s && !s.accepted)
    .map((s) => ({ account: { name: s.name, profileUrl: s.url }, profileId: s.profileId }));
}

/**
 * From per-sender accept results ([{ profileId, accepted }]), the ids whose
 * accept SUCCEEDED — restricted to ids the engine actually listed as senders
 * (defensive: never signal an id the engine didn't ask about).
 */
export function computeAcceptedIds(detail, results) {
  const known = new Set(((detail && detail.campaign && detail.campaign.senders) || []).map((s) => s.profileId));
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.accepted && known.has(r.profileId))
    .map((r) => r.profileId);
}

// ── Once-only store (tmp+rename, mirrors cloud-soo-reconcile.js) ─────────────
let cache = null;
async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' && parsed.campaigns ? parsed : { campaigns: {} };
  } catch {
    cache = { campaigns: {} };
  }
  return cache;
}
async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}
function rec(id) {
  return cache.campaigns[id] || (cache.campaigns[id] = { signaled: false, ts: 0 });
}
function prune() {
  const ids = Object.keys(cache.campaigns);
  if (ids.length > MAX_CAMPAIGNS) {
    ids.sort((a, b) => (cache.campaigns[a].ts || 0) - (cache.campaigns[b].ts || 0));
    for (const old of ids.slice(0, ids.length - MAX_CAMPAIGNS)) delete cache.campaigns[old];
  }
}

export async function hasSignaled(id) { await load(); return !!cache.campaigns[id]?.signaled; }
export async function markSignaled(id) { await load(); const r = rec(id); r.signaled = true; r.ts = Date.now(); prune(); await persist(); }
