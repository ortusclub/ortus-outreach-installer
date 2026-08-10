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
import { diagnose, logLine, summarise } from './magellan-diagnose.js';
import { publish as publishSheet, resetPublished } from './magellan-sheet.js';
import {
  lookupByMemberIds, batchCreate, batchUpdate, attachSyntheticEmail,
  checkMagellanProperties,
} from './hubspot-client.js';

const idle = () => ({
  running: false,
  phase: 'idle',           // idle | collecting | previewing | importing | done | error
  account: null,
  step: null,              // what the current account is doing right now
  current: null,           // live count within the account being read
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  perAccount: [],          // [{ account, total, withMemberId, hidden, error, diagnosis }]
  log: [],                 // campaign-style ring buffer, newest last
  failures: [],            // failures grouped by cause
  preview: null,           // aggregate counts + the plan to import
  imported: null,
  error: null,
});

// Same shape the campaign log uses: timestamped lines, capped so a 300-account
// sweep can't grow without bound.
const LOG_CAP = 2000;
function log(line) {
  _state.log.push(`[${new Date().toISOString()}] ${line}`);
  if (_state.log.length > LOG_CAP) _state.log.splice(0, _state.log.length - LOG_CAP);
  console.log(`[magellan] ${line}`);
}

let _state = idle();
// The plan can hold hundreds of thousands of rows, so it stays here and only
// the totals cross the wire. Import replays what preview actually saw rather
// than trusting a payload the browser round-tripped.
let _plans = null;
// Set by stopCollect(). Checked between accounts — the one in flight is allowed
// to finish and close its browser cleanly rather than being killed mid-read.
let _stopRequested = false;

export function getState() { return { ..._state }; }

/** Ask the sweep to stop after the current account. */
export function stopCollect() {
  if (!_state.running) return { stopped: false, reason: 'Nothing is running' };
  _stopRequested = true;
  _state.step = 'Stopping after this account';
  log('◼ Stop requested — finishing the current account, then stopping.');
  return { stopped: true };
}
export function getPlans() { return _plans; }
export function reset() { _state = idle(); _plans = null; _stopRequested = false; }

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
    semaphore = browserSemaphore, collect = collectAccount, sheet = publishSheet } = deps;

  // The sheet is a record, never a dependency — a Google failure must not stop
  // the sweep, so this swallows everything and only notes it in the log.
  const toSheet = (force = false) => sheet(_state, { force })
    .then((r) => { if (r && r.error) log(`⚠ Could not update the sheet — ${r.error}`); })
    .catch((err) => log(`⚠ Could not update the sheet — ${err.message}`));

  if (_state.running) return { started: false, reason: 'Magellan is already running' };
  const list = (accounts || []).filter((a) => a && a.profileId && a.account);
  if (!list.length) return { started: false, reason: 'No accounts selected' };

  _stopRequested = false;
  resetPublished();   // a new sweep rewrites every account tab it touches
  _state = { ...idle(), running: true, phase: 'collecting', total: list.length, startedAt: new Date().toISOString() };

  log(`▶ Collecting ${list.length} account${list.length === 1 ? '' : 's'}.`);

  (async () => {
    for (const entry of list) {
      if (_stopRequested) {
        log(`◼ Stopped. ${_state.done} of ${list.length} accounts done; the rest were not started.`);
        break;
      }
      _state.account = entry.account;
      // Two goes at an account whose failure is worth retrying. bulk-check
      // effectively gets this for free — a failed sweep is simply retried on
      // the next tick — but Magellan only visits an account once, so without
      // it a single cold launch or slow page loses the whole account.
      let attempt = 0;
      let done = false;
      while (!done) {
        attempt += 1;
        let launched = null;
        // Which half of the account we are in, so a failure is explained by the
        // rules that can actually apply to it.
        let phase = 'launch';
        _state.step = 'Waiting for a free browser slot';
        await semaphore.acquire();
        try {
          _state.step = 'Opening the browser';
          log(`◦ ${entry.account}: opening the browser…${attempt > 1 ? ' (second try)' : ''}`);
          launched = await launchProfile(entry.profileId);

          phase = 'read';
          _state.step = 'Reading the connections list';
          log(`◦ ${entry.account}: signed in, reading the connections list…`);
          const r = await collect(launched.page, entry.account, {
            onProgress: ({ count, pages, total }) => {
              _state.current = { account: entry.account, count, pages, total };
            },
          });
          _state.current = null;

          _state.perAccount.push({
            account: entry.account,
            total: r.total,
            withMemberId: r.withMemberId,
            hidden: r.hidden,
            partial: r.partial || null,
            collectedAt: new Date().toISOString(),
          });
          const noId = r.total - r.withMemberId;
          log(`✓ ${entry.account}: ${r.total} connections`
            + (noId ? `, ${noId} without a LinkedIn ID` : '')
            + (r.hidden ? `, ${r.hidden} hidden by LinkedIn` : ''));
          // Kept, but said out loud: a short account is worse than a failed one
          // if nobody notices it was cut off.
          if (r.partial) log(`⚠ ${entry.account}: the list was cut short — ${r.partial}`);
          done = true;
        } catch (err) {
          // One dead account must not end the sweep. Record WHY, in words the
          // operator can act on, not the raw stack.
          _state.current = null;
          const d = diagnose(err, { phase });
          if (d.retryable && attempt < 2 && !_stopRequested) {
            log(`⚠ ${entry.account}: ${d.what} — trying once more. [${d.raw}]`);
          } else {
            _state.perAccount.push({ account: entry.account, error: err.message, diagnosis: d });
            log(logLine(entry.account, d));
            done = true;
          }
        } finally {
          _state.step = 'Closing the browser';
          try {
            if (launched) await closeProfile(entry.profileId);
          } catch (err) {
            log(`⚠ ${entry.account}: the browser did not close cleanly — ${err.message}`);
          }
          semaphore.release();
        }
      }
      _state.done += 1;
      _state.failures = summarise(_state.perAccount);
      toSheet();
    }
    const ok = _state.perAccount.filter((a) => !a.error);
    const people = ok.reduce((n, a) => n + (a.total || 0), 0);
    log(`■ Finished. ${ok.length} of ${list.length} accounts, ${people} people`
      + (ok.length < list.length ? `, ${list.length - ok.length} failed.` : '.'));
    _state.phase = _stopRequested ? 'stopped' : 'done';
    _state.stopped = _stopRequested;
    _state.running = false;
    _state.account = null;
    _state.step = null;
    _state.finishedAt = new Date().toISOString();
    // force: the final picture must land even if a per-account write is still
    // in flight, otherwise the tab freezes one account short of the truth.
    await toSheet(true);
  })().catch(async (err) => {
    log(`✗ The collection stopped unexpectedly — ${err.message}`);
    _state.error = err.message;
    _state.phase = 'error';
    _state.running = false;
    await toSheet(true);
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
  const { create = batchCreate, update = batchUpdate, attach = attachSyntheticEmail,
    sheet = publishSheet } = deps;

  if (_state.running) return { ok: false, reason: 'Magellan is already running' };
  if (!plans) return { ok: false, reason: 'Nothing to import — build a preview first' };
  _state = { ..._state, running: true, phase: 'importing', error: null };

  // perAccount so the sheet can show which account contributed what, rather
  // than one aggregate number nobody can trace back.
  const result = { created: 0, updated: 0, extraEmails: 0, errors: [], perAccount: [] };
  try {
    for (const { account, plan } of plans || []) {
      const row = { account, created: 0, updated: 0, extraEmails: 0, errors: [] };
      result.perAccount.push(row);

      const c = await create(plan.creates);
      row.created = c.created;
      row.errors.push(...c.errors.map((e) => ({ stage: 'create', ...e })));

      const u = await update(plan.updates);
      row.updated = u.updated;
      row.errors.push(...u.errors.map((e) => ({ stage: 'update', ...e })));

      // One call each — no batch endpoint exists for secondary emails.
      for (const item of plan.additionalEmails) {
        try { await attach(item); row.extraEmails += 1; } catch (err) {
          row.errors.push({ stage: 'email', id: item.id, error: err.message });
        }
      }

      result.created += row.created;
      result.updated += row.updated;
      result.extraEmails += row.extraEmails;
      result.errors.push(...row.errors.map((e) => ({ account, ...e })));
    }
    _state.imported = { ...result, at: new Date().toISOString() };
    await sheet(_state, { force: true }).catch(() => {});
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
