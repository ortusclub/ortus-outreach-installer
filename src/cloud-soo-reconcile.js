/**
 * Cloud → SoO weekly connection reconcile.
 *
 * A LOCAL campaign bumps the SoO "Number of Connections (this week)" tally by +1
 * per successful connection send (bumpConnectionsThisWeek). A CLOUD campaign
 * sends on the engine, which has no SoO code — so that tally never moves for
 * cloud runs. This module closes that gap app-side: given the engine's per-lead
 * data (GET /api/campaign/:id/leads), it bumps each account's weekly tally by
 * the number of NEW connection sends observed.
 *
 * Two correctness guards, because the SoO tally feeds real weekly reporting:
 *   1. DURABLE DEDUP — every counted (campaign, leadId) is persisted to disk, so
 *      the 4s board poll, an app restart, or two operators both looking at the
 *      campaign can never count the same send twice.
 *   2. CURRENT-WEEK ONLY — only sends whose sentAt falls in the current ISO week
 *      are counted, so reconciling a just-finished campaign never misattributes
 *      last week's sends to this week (the Apps Script buckets by write time).
 *
 * Best-effort: a bump failure leaves those leads UNcounted so a later poll
 * retries; a matched write marks them counted. Never throws to the caller.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';
import { bumpConnectionsThisWeek } from './soo-writer.js';

const FILE = dataPath('cloud-soo-reconcile.json');
const MAX_CAMPAIGNS = 300;

// The connection-request modes — the only ones that consume a CC credit and so
// should tick the weekly connection tally (mirrors soo-writer CONNECT_MODES).
const CC_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message']);

/**
 * ISO-8601 week key ("2026-W28") for a Date, in UTC. Used only to compare a
 * send's week against "now" — it just has to bucket consistently, not match any
 * particular locale's calendar. Classic Thursday-of-the-week algorithm.
 */
export function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (t.getUTCDay() + 6) % 7;      // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNr + 3);    // move to this week's Thursday
  const thursday = t.getTime();
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); // Jan 4 is always in W1
  const ysDay = (yearStart.getUTCDay() + 6) % 7;
  yearStart.setUTCDate(yearStart.getUTCDate() - ysDay + 3);       // W1's Thursday
  const week = 1 + Math.round((thursday - yearStart.getTime()) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

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

/**
 * Bump the SoO weekly connection tally for a cloud CC campaign's accounts from
 * the engine's per-lead sent data. Returns { bumped, byAccount } (counts of
 * newly-credited sends). No-op for non-CC modes / no leads / SoO write-back off.
 *
 * @param {object}   p
 * @param {string}   p.id            engine campaign id (dedup key)
 * @param {string}   p.mode          campaign mode
 * @param {object}   p.accountEmails profileId -> SoO email (from engine config)
 * @param {Array}    p.leads         per-lead rows from GET /api/campaign/:id/leads
 * @param {function} [p.log]
 * @param {string}   [p.nowWeek]     override "current week" (tests)
 */
export async function reconcileCloudConnections({ id, mode, accountEmails = {}, leads = [], log = () => {}, nowWeek } = {}) {
  if (!id || !CC_MODES.has(String(mode || ''))) return { bumped: 0, byAccount: {} };
  if (!Array.isArray(leads) || !leads.length) return { bumped: 0, byAccount: {} };
  const week = nowWeek || isoWeekKey(new Date());

  await load();
  const rec = cache.campaigns[id] || (cache.campaigns[id] = { counted: [], ts: 0 });
  const counted = new Set(rec.counted);

  // Group NEW, this-week connection sends by SoO email. In a CC mode, a lead
  // with status 'sent' means its connection request went out (one CC credit),
  // regardless of any later stage (IC/DM) it went on to reach.
  const perEmail = new Map(); // email -> [leadId,…]
  for (const l of leads) {
    if (!l || l.status !== 'sent' || !l.sentAt) continue;
    const key = String(l.id);
    if (counted.has(key)) continue;
    const when = new Date(l.sentAt);
    if (isNaN(when.getTime()) || isoWeekKey(when) !== week) continue; // this ISO week only
    const email = accountEmails[l.account];
    if (!email) continue; // no SoO email for this account → can't bump
    if (!perEmail.has(email)) perEmail.set(email, []);
    perEmail.get(email).push(key);
  }
  if (!perEmail.size) { rec.ts = Date.now(); await persist(); return { bumped: 0, byAccount: {} }; }

  let bumped = 0;
  const byAccount = {};
  for (const [email, leadIds] of perEmail) {
    const delta = leadIds.length;
    try {
      const res = await bumpConnectionsThisWeek({ email, delta });
      if (res && res.ok) {
        leadIds.forEach((k) => counted.add(k)); // durable: never re-count
        bumped += delta;
        byAccount[email] = delta;
        log(`[cloud] SoO connections: ${email} +${delta} (week total ${res.value ?? '?'}).`);
      } else {
        // leave UNcounted so a later poll retries (kill-switch off, transient, …)
        log(`[cloud] SoO connections bump failed for ${email}: ${(res && (res.error || (res.disabled && 'write-back OFF'))) || 'unknown'}.`);
      }
    } catch (e) {
      log(`[cloud] SoO connections bump error for ${email}: ${e.message}`);
    }
  }

  rec.counted = [...counted];
  rec.ts = Date.now();
  // Prune oldest campaigns so the store can't grow unbounded.
  const ids = Object.keys(cache.campaigns);
  if (ids.length > MAX_CAMPAIGNS) {
    ids.sort((a, b) => (cache.campaigns[a].ts || 0) - (cache.campaigns[b].ts || 0));
    for (const old of ids.slice(0, ids.length - MAX_CAMPAIGNS)) delete cache.campaigns[old];
  }
  await persist();
  return { bumped, byAccount };
}
