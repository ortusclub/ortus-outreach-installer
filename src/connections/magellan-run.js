// Operation Magellan — orchestration. Three phases the operator sees as
// Exported → Cleaned → Imported, matching the tracker sheet's own columns.
//
// Collect and import are deliberately separate jobs. Collecting 300 accounts is
// hours of browser work; the import is a few minutes of API calls. Splitting
// them means a preview can be reviewed — and rejected — without redoing the
// slow half, and nothing reaches HubSpot until someone presses the button.
import * as launcher from '../gologin-launcher.js';
import * as browserSemaphore from '../browser-semaphore.js';
import { collectAccount, readForPlan } from './magellan-pull.js';
import { planAccount } from './magellan.js';
import {
  lookupByMemberIds, batchCreate, batchUpdate, attachSyntheticEmail,
  checkMagellanProperties,
} from './hubspot-client.js';

const idle = () => ({
  running: false,
  phase: 'idle',           // idle | collecting | previewing | importing | done | error
  account: null,
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  perAccount: [],          // [{ account, total, withMemberId, hidden, error }]
  preview: null,           // aggregate counts + the plan to import
  imported: null,
  error: null,
});

let _state = idle();
// The plan can hold hundreds of thousands of rows, so it stays here and only
// the totals cross the wire. Import replays what preview actually saw rather
// than trusting a payload the browser round-tripped.
let _plans = null;

export function getState() { return { ..._state }; }
export function getPlans() { return _plans; }
export function reset() { _state = idle(); _plans = null; }

/**
 * Phase 1 — collect. Opens each account in turn and writes its connections to
 * data/connections/<email>.csv. Sends nothing: this only reads a list, which is
 * why it ignores campaign concepts like credits, assignment and in-use.
 *
 * One account at a time. The browser semaphore is shared with live campaigns,
 * so a 300-account sweep must not starve them of slots.
 */
export function startCollect(accounts, deps = {}) {
  const { launchProfile = launcher.launchProfile, closeProfile = launcher.closeProfile,
    semaphore = browserSemaphore, collect = collectAccount } = deps;

  if (_state.running) return { started: false, reason: 'Magellan is already running' };
  const list = (accounts || []).filter((a) => a && a.profileId && a.account);
  if (!list.length) return { started: false, reason: 'No accounts selected' };

  _state = { ...idle(), running: true, phase: 'collecting', total: list.length, startedAt: new Date().toISOString() };

  (async () => {
    for (const entry of list) {
      _state.account = entry.account;
      let launched = null;
      await semaphore.acquire();
      try {
        launched = await launchProfile(entry.profileId);
        const r = await collect(launched.page, entry.account);
        _state.perAccount.push({
          account: entry.account,
          total: r.total,
          withMemberId: r.withMemberId,
          hidden: r.hidden,
          collectedAt: new Date().toISOString(),
        });
      } catch (err) {
        // One dead account must not end the sweep — record and carry on.
        _state.perAccount.push({ account: entry.account, error: err.message });
      } finally {
        try { if (launched) await closeProfile(entry.profileId); } catch { /* already gone */ }
        semaphore.release();
        _state.done += 1;
      }
    }
    _state.phase = 'done';
    _state.running = false;
    _state.account = null;
    _state.finishedAt = new Date().toISOString();
  })().catch((err) => {
    _state.error = err.message;
    _state.phase = 'error';
    _state.running = false;
  });

  return { started: true };
}

/**
 * Phase 2 — work out what the import would do. Reads what was collected, asks
 * HubSpot which of those member ids it already has, and builds the plan.
 * Writes nothing.
 */
export async function buildPreview(accounts, deps = {}) {
  const { lookup = lookupByMemberIds, read = readForPlan, checkProps = checkMagellanProperties } = deps;

  // Fail before doing any work if the portal is missing the properties we write
  // — otherwise every single create silently drops the fields that matter.
  const props = await checkProps();
  if (!props.ok) {
    throw new Error(`HubSpot is missing ${props.missing.join(' and ')} — add the properties before importing.`);
  }

  const plans = [];
  const totals = { created: 0, updated: 0, extraEmails: 0, hidden: 0, unresolved: 0, total: 0 };

  for (const account of accounts || []) {
    const rows = read(account);
    const memberIds = rows.map((r) => r.memberId).filter(Boolean);
    const existing = await lookup(memberIds);
    const plan = planAccount(rows, account, (c) => existing.get(String(c.memberId)) || null);
    plans.push({ account, plan });
    for (const k of Object.keys(totals)) totals[k] += plan.counts[k] || 0;
  }

  _plans = plans;
  _state.preview = { totals, builtAt: new Date().toISOString(), accounts: accounts || [] };
  return { totals, plans };
}

/**
 * Phase 3 — write. Only ever called from an explicit operator action; there is
 * no automatic path from collect to import.
 */
export async function runImport(plans = _plans, deps = {}) {
  const { create = batchCreate, update = batchUpdate, attach = attachSyntheticEmail } = deps;

  if (_state.running) return { ok: false, reason: 'Magellan is already running' };
  if (!plans) return { ok: false, reason: 'Nothing to import — build a preview first' };
  _state = { ..._state, running: true, phase: 'importing', error: null };

  const result = { created: 0, updated: 0, extraEmails: 0, errors: [] };
  try {
    for (const { account, plan } of plans || []) {
      const c = await create(plan.creates);
      result.created += c.created;
      result.errors.push(...c.errors.map((e) => ({ account, stage: 'create', ...e })));

      const u = await update(plan.updates);
      result.updated += u.updated;
      result.errors.push(...u.errors.map((e) => ({ account, stage: 'update', ...e })));

      // One call each — no batch endpoint exists for secondary emails.
      for (const item of plan.additionalEmails) {
        try { await attach(item); result.extraEmails += 1; } catch (err) {
          result.errors.push({ account, stage: 'email', id: item.id, error: err.message });
        }
      }
    }
    _state.imported = { ...result, at: new Date().toISOString() };
    _state.phase = 'done';
    return { ok: true, ...result };
  } catch (err) {
    _state.error = err.message;
    _state.phase = 'error';
    return { ok: false, reason: err.message, ...result };
  } finally {
    _state.running = false;
  }
}
