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
import { explainProblem, problemLine, summariseProblems } from './magellan-problems.js';
import { publish as publishSheet, resetPublished, setPlanVerdicts, resetPlanVerdicts } from './magellan-sheet.js';
import {
  lookupByMemberIds, batchCreate, batchUpdate, attachSyntheticEmail,
  checkMagellanProperties, connectionsPropOptions, mergeContacts,
} from './hubspot-client.js';
import { buildOutcome } from './magellan-outcome.js';

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
  outcome: null,           // {ok, summary, problems} once the run has ended
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

// Fields that describe how a PREVIOUS run ended. A phase that starts a new
// run must not begin wearing another phase's leftover answer — that's how a
// Check ended up reporting the previous Import's numbers (`imported` beats
// `preview` in buildOutcome's field-presence check), and how a stopped
// collect's "Stopped" eyebrow survived forever into a Check that never
// stopped. `startRun` is the one place "starting a run" happens, so every
// phase clears the same things the same way instead of four hand-edited
// spreads quietly disagreeing about what counts as stale.
//
// `log` is never listed here — the ring buffer is deliberately cumulative
// across a session. `perAccount` likewise: a Check legitimately reports on
// the collect that preceded it (accountsRows/publish read it to keep writing
// the account tabs during a Check), so it survives unless the caller is the
// one thing that legitimately replaces it (collect itself, which already
// rebuilds from `idle()`).
const RUN_RESULT_FIELDS = {
  preview: null, imported: null, merged: null,
  stopped: false, finishedAt: null, error: null, outcome: null,
};

/**
 * The shared shape every phase begins from when it takes the card over.
 * `keep` lets a caller hold onto a field it still legitimately needs (e.g.
 * runImport and mergeDuplicates both still read `_state.preview` after
 * starting) — everything else in RUN_RESULT_FIELDS is cleared.
 */
function startRun(patch, keep = {}) {
  return { ..._state, ...RUN_RESULT_FIELDS, ...keep, running: true, ...patch };
}

// The plan can hold hundreds of thousands of rows, so it stays here and only
// the totals cross the wire. Import replays what preview actually saw rather
// than trusting a payload the browser round-tripped.
let _plans = null;
// Set by stopCollect(). Watched by the per-account watchdog as well as checked
// between accounts, so the account in flight is abandoned rather than finished:
// "after this account" is indistinguishable from "never" when that account is
// the one that hung. Nothing is lost — collectAccount writes its CSV only once
// the walk completes.
let _stopRequested = false;

// How long a read may go without a single progress tick before it is treated as
// dead. The beacon publishes every 1.5s through both halves of the walk, so this
// is silence, not slowness. Generous because a cold Orbita on a loaded laptop
// can take a while to produce its first page.
let STALL_MS = 4 * 60 * 1000;

/** Test seam. Four real minutes is not a unit test. */
export function setStallMs(ms) { STALL_MS = ms; }

export function getState() { return { ..._state }; }

/** Stop the sweep, abandoning the account currently being read. */
export function stopCollect() {
  if (!_state.running) return { stopped: false, reason: 'Nothing is running' };
  _stopRequested = true;
  _state.step = 'Stopping';
  log('◼ Stop requested — abandoning the account being read and stopping.');
  return { stopped: true };
}
/**
 * The sheet write that follows a run which has ALREADY ended.
 *
 * Never awaited by the route. Check and Import both finish their real work,
 * set running/phase/outcome, and only then push the record to Google — which
 * is minutes of Apps Script with retries on top. Awaiting it held the HTTP
 * response open long past the page's 30s guard, so a Check that had fully
 * succeeded printed "The app did not answer. It may have restarted" over its
 * own results, and the card read FINISHED · 100% · Idle while its stage block
 * still said "Writing the sheet for review". Measured 2026-08-13:
 * `[sheets-writer] transient write error (attempt 1/4): ... aborted due to
 * timeout — retrying` landed while the operator was staring at that banner.
 *
 * The state is copied because the caller's `finally` clears account/step the
 * instant this returns, and because the next run replaces _state entirely.
 * publish() only reads, so a snapshot is enough.
 */
function sheetAfterRun(state, sheet, what) {
  const snapshot = { ...state };
  return sheet(snapshot, { force: true })
    .then((r) => {
      if (r && r.error) return log(`⚠ Could not update the sheet — ${r.error}`);
      log(`✓ The ${what} sheet is up to date.`);
    })
    .catch((err) => log(`⚠ Could not update the sheet — ${err.message}`));
}

export function getPlans() { return _plans; }
export function reset() {
  _state = idle(); _plans = null; _stopRequested = false;
  resetPlanVerdicts();   // stale verdicts must not survive into the next sweep
}

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
  // Two profiles can resolve to the same SoO address, and the picker has let
  // the same one through twice. Collecting an account twice in one run just
  // fights itself over the same file.
  const seen = new Set();
  const list = (accounts || []).filter((a) => {
    if (!a || !a.profileId || !a.account) return false;
    const key = String(a.account).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
        let watchdog = null;
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
          // The entire walk happens inside ONE page.evaluate(), so if the
          // browser dies the promise never settles: the loop never comes back
          // round to its stop check and Stop does nothing at all. 2026-08-12,
          // an operator's log — nushe.himaj sat on "reading the connections
          // list" for six minutes across two Stop clicks, with no browser open.
          //
          // So the read is raced against two ways of not finishing. Nothing is
          // lost by abandoning one: collectAccount writes its CSV only after
          // the walk completes, so a read that never completes was never going
          // to save anything.
          let lastTick = Date.now();
          const r = await Promise.race([
            collect(launched.page, entry.account, {
              onProgress: ({ count, pages, total, stage }) => {
                lastTick = Date.now();
                _state.current = { account: entry.account, count, pages, total, stage: stage || 'list' };
              },
            }),
            new Promise((_resolve, reject) => {
              watchdog = setInterval(() => {
                // Stop means stop. It used to mean "after this account", which
                // is indistinguishable from "never" when this account is hung.
                if (_stopRequested) return reject(new Error('stopped-by-operator'));
                // The beacon ticks every 1.5s through both halves of the read,
                // so four minutes of silence is a dead browser, not a slow one.
                if (Date.now() - lastTick > STALL_MS) {
                  reject(new Error(`stalled: no progress for ${Math.round(STALL_MS / 60000)} minutes`));
                }
              }, 1000);
            }),
          ]);
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
          if (watchdog) clearInterval(watchdog);
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
    _state.account = null;
    _state.step = null;
    _state.finishedAt = new Date().toISOString();
    // running clears only once the state above already tells the truth about
    // how the sweep ended — then buildOutcome(state) is asked honestly, since
    // it refuses to answer (returns null) while state.running is still true.
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    // force: the final picture must land even if a per-account write is still
    // in flight, otherwise the tab freezes one account short of the truth.
    await toSheet(true);
  })().catch(async (err) => {
    log(`✗ The collection stopped unexpectedly — ${err.message}`);
    _state.error = err.message;
    _state.phase = 'error';
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    await toSheet(true);
  });

  return { started: true };
}

/**
 * Phase 2 — work out what the import would do. Reads what was collected, asks
 * HubSpot which of those member ids it already has, and builds the plan.
 * Writes nothing to HubSpot — the only write is the best-effort Plan tab on
 * the review sheet, so a second person can see the answer before anyone
 * presses Import.
 */
export async function buildPreview(accounts, deps = {}) {
  const { lookup = lookupByMemberIds, read = readForPlan, checkProps = checkMagellanProperties,
    options = connectionsPropOptions, sheet = publishSheet,
    // Test seam, not a production dependency: fired once, in the finally, the
    // instant after running clears, with a snapshot of the state at that exact
    // moment. Nothing else can observe that instant — the whole tail below is
    // synchronous, so a timer-based poller races code that never yields and
    // always loses. Named for what it watches, not what it does.
    onRunEnd = () => {} } = deps;

  // startCollect, runImport and mergeDuplicates each refuse to start on top of
  // a live run; Check was the one that did not. It shares the same module-level
  // _state, so a Check clicked during a collect replaced the collect's counters
  // mid-sweep, and the collect then ended the Check for it — writing a COLLECT
  // outcome and running:false while HubSpot calls were still in flight. Throws
  // rather than returning a reason because the route destructures the result.
  if (_state.running) throw new Error('Magellan is already running — wait for it to finish.');

  // Fail before doing any work if the portal is missing the properties we write
  // — otherwise every single create silently drops the fields that matter.
  const props = await checkProps();
  if (!props.ok) {
    throw new Error(`HubSpot is missing ${props.missing.join(' and ')} — add the properties before importing.`);
  }

  // "Linkedin 1st Connections" is a fixed list of Ortus account emails. An
  // account that isn't on it cannot be written — HubSpot rejects the value —
  // so it is held back here, named, instead of failing 7,000 rows at a time
  // during the import.
  const allowed = await options();
  const blocked = [];
  const usable = [];
  for (const a of accounts || []) {
    (allowed.has(String(a).trim().toLowerCase()) ? usable : blocked).push(a);
  }

  const plans = [];
  const totals = { created: 0, existing: 0, updated: 0, extraEmails: 0, hidden: 0, unresolved: 0, total: 0 };

  // Check is three minutes of silence on a real sweep. Drive the same card the
  // collect and import halves drive, so "is it still going?" is answered by
  // looking at it.
  _state = startRun({
    phase: 'checking',
    done: 0, total: usable.length, account: null, current: null,
    checked: 0, step: 'Asking HubSpot who it already has',
  });

  // People HubSpot holds twice under one LinkedIn id. Found here, before a
  // single write, because it is the one problem the import cannot fix by
  // itself — and the reason for every "different vid" refusal later.
  //
  // Keyed by member id, NOT collected per account: a popular person is a
  // connection of six Ortus accounts and would otherwise be counted six times
  // and merged six times. One person, one entry, with every account they came
  // from listed against them.
  const dupeByMember = new Map();

  // What Check found, keyed by member id: the HubSpot id if the person is
  // already there, null if new. Handed to magellan-sheet's planRows via
  // setPlanVerdicts below — readForPlan rebuilds its rows from disk on every
  // call, so nothing stamped onto a row here would survive a second read, and
  // publish() is called from three OTHER places (collect, merge, import) that
  // never run this loop at all. Keeping the verdicts in one shared place means
  // all four agree, instead of only the caller that happens to pass an override.
  const verdicts = new Map();

  let checkedSoFar = 0;
  try {
    for (const account of usable) {
      const rows = read(account);
      const memberIds = rows.map((r) => r.memberId).filter(Boolean);
      _state.account = account;
      const existing = await lookup(memberIds, {
        onProgress: ({ done, total }) => {
          _state.current = { account, count: done, total, stage: 'check' };
          _state.checked = checkedSoFar + done;
        },
      });
      for (const d of existing.duplicates || []) {
        const seen = dupeByMember.get(d.memberId);
        if (seen) { if (!seen.accounts.includes(account)) seen.accounts.push(account); continue; }
        dupeByMember.set(d.memberId, { ...d, accounts: [account] });
      }
      const plan = planAccount(rows, account, (c) => existing.get(String(c.memberId)) || null);
      // Same verdict planAccount just used to sort creates from updates,
      // recorded so the Plan tab can answer the same question later.
      for (const id of memberIds) {
        const hit = existing.get(String(id));
        verdicts.set(String(id), hit ? hit.id : null);
      }
      plans.push({ account, plan });
      for (const k of Object.keys(totals)) totals[k] += plan.counts[k] || 0;
      checkedSoFar += memberIds.length;
      _state.done += 1;
      _state.current = null;
    }

    // Everything below used to sit AFTER the finally, so the card went idle
    // seconds before the answer existed — "NOT RUNNING · 92% · Idle" while the
    // request was still open. running now clears only once the state carries a
    // preview or an error. There is no instant where the card can truthfully
    // say "not running" and have nothing to show.
    const duplicates = [...dupeByMember.values()];
    if (duplicates.length) {
      log(`⚠ ${duplicates.length} people are in HubSpot twice under one LinkedIn ID. `
        + 'Their connection is recorded on the record with a real email address, so nothing is '
        + 'missed. The second address is refused — that is the "different vid" message.');
      for (const d of duplicates.slice(0, 10)) {
        log(`⚠ ${d.name || 'unnamed'} (LinkedIn ${d.memberId}): recorded on ${d.keptId}, `
          + `also exists as ${d.otherIds.join(', ')}`);
      }
      if (duplicates.length > 10) log(`⚠ …and ${duplicates.length - 10} more — the full list is in the sheet.`);
    }

    _plans = plans;
    _state.preview = {
      totals, blocked, duplicates, builtAt: new Date().toISOString(), accounts: usable,
      // Accounts that actually had a file to read. `accounts` is what HubSpot
      // ALLOWED, which is not the same thing: tick an allowed account that was
      // never collected and readForPlan returns [] silently, so every total
      // stays 0 and the summary reads "0 new · 0 already there" as if the sweep
      // had looked and found everything known. This is what it looked at.
      read: plans.filter((p) => p.plan.counts.total > 0).map((p) => p.account),
    };
    if (blocked.length) {
      log(`⚠ ${blocked.length} account${blocked.length === 1 ? '' : 's'} cannot go into HubSpot — `
        + `not on the "Linkedin 1st Connections" list: ${blocked.join(', ')}`);
    }
    _state.phase = 'done';
    // running clears here, the moment the state actually carries the preview —
    // not in the finally below. buildOutcome(state) refuses to answer while
    // state.running is true (there is nothing truthful to say about a run
    // still in flight — the project's "never invent data" rule, enforced in
    // code), so it can only be asked honestly once running is already false.
    // The finally's own running = false a few lines down is then just an
    // idempotent safety net for any path that throws before reaching here.
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    // Shared with every other publish() caller — see the comment on `verdicts`
    // above. Set before the write below so this Check's own Plan tab is
    // correct, and left in place afterwards so collect/merge/import's later
    // writes stay correct too.
    setPlanVerdicts(verdicts);
    // Written now, not on a button: the person who reviews this is not the
    // person at the keyboard, and asking them to wait for someone to press
    // "publish" is how a review does not happen.
    // Detached — see sheetAfterRun. The answer above is what the operator
    // pressed the button for; the sheet is a record of it, and a record must
    // never hold up the thing it records.
    sheetAfterRun(_state, sheet, 'review');
    return { totals, plans, blocked, duplicates };
  } catch (err) {
    log(`✗ The check stopped — ${err.message}`);
    _state.error = err.message;
    _state.phase = 'error';
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    throw err;
  } finally {
    // Check writes nothing to HubSpot, so the card must not be left looking
    // busy — whether it finished, threw, or the portal refused halfway through.
    _state.account = null;
    _state.current = null;
    _state.step = null;
    _state.running = false;
    // Test seam — see onRunEnd above. Fires after everything this function
    // ever writes, so a regression that puts a write back after this point
    // shows up here, not just in a slower-to-notice output assertion.
    onRunEnd(getState());
  }
}

/**
 * Fold every duplicate pair Check found into one contact each.
 *
 * Separate from the import on purpose. The import can be re-run all day; a
 * merge cannot be undone in HubSpot at all, so it is its own button, its own
 * confirmation, and it writes the pairs to the log BEFORE touching anything —
 * if a merge goes wrong, that list is the only record of what existed.
 *
 * The record with a real email address is always the one kept: it is the one
 * people open, and the synthetic address is the disposable half.
 */
export async function mergeDuplicates(pairs = null, deps = {}) {
  const { merge = mergeContacts, sheet = publishSheet } = deps;
  const list = pairs || (_state.preview && _state.preview.duplicates) || [];

  if (_state.running) return { ok: false, reason: 'Magellan is already running' };
  if (!list.length) return { ok: false, reason: 'No duplicates to merge — run Check first' };

  // Records that share a LinkedIn id but disagree about the person's name are
  // never merged. A wrong id on one contact is rare; fusing two real people
  // with no way back is not a risk worth taking to save a manual check.
  const unsafe = list.filter((d) => d.nameMatch === false);
  const safe = list.filter((d) => d.nameMatch !== false);
  if (unsafe.length) {
    log(`⚠ ${unsafe.length} of these are NOT being merged: the records share a LinkedIn ID but `
      + 'have different names, so they may be two different people. Check them by hand in HubSpot.');
    for (const d of unsafe.slice(0, 10)) log(`⚠ left alone: ${d.name || 'unnamed'} (LinkedIn ${d.memberId})`);
  }
  if (!safe.length) return { ok: false, reason: 'Nothing safe to merge — every pair has a name mismatch' };

  // preview and imported are both kept: this function mutates
  // _state.preview.duplicates below once the merge finishes, and merge can
  // legitimately run after an import without erasing that import's result.
  _state = startRun({
    phase: 'merging',
    done: 0, total: safe.length, account: null, step: 'Merging duplicate people',
  }, { preview: _state.preview, imported: _state.imported });

  const result = { merged: 0, errors: [] };
  log(`▶ Merging ${safe.length} duplicate ${safe.length === 1 ? 'person' : 'people'}. This cannot be undone.`);
  // Written before the first merge, so the pairs survive even if the run dies.
  for (const d of safe) {
    log(`◦ ${d.name || 'unnamed'} (LinkedIn ${d.memberId}): keeping ${d.keptId}, folding in ${d.otherIds.join(', ')}`);
  }

  try {
    for (const d of safe) {
      _state.account = d.name || d.memberId;
      for (const other of d.otherIds) {
        try {
          await merge({ primaryId: d.keptId, mergeId: other });
          result.merged += 1;
        } catch (err) {
          const p = explainProblem(err.message, { stage: 'merge' });
          result.errors.push({ account: d.account || '', memberId: d.memberId, error: err.message });
          log(problemLine(d.name || d.memberId, p));
        }
      }
      _state.done += 1;
    }
    _state.merged = { ...result, at: new Date().toISOString(), skipped: unsafe.length };
    log(`■ Merging finished. ${result.merged} folded together`
      + (result.errors.length ? `, ${result.errors.length} could not be merged` : '')
      + (unsafe.length ? `, ${unsafe.length} left alone for a human to check.` : '.'));
    // The duplicates are gone, so the preview that named them is stale — a
    // second Check is the honest way to see what is left.
    if (_state.preview) _state.preview.duplicates = [];
    _state.phase = 'done';
    sheetAfterRun(_state, sheet, 'review');
    return { ok: true, ...result };
  } catch (err) {
    log(`✗ Merging stopped — ${err.message}`);
    _state.error = err.message;
    _state.phase = 'error';
    return { ok: false, reason: err.message, ...result };
  } finally {
    _state.running = false;
    _state.account = null;
    _state.step = null;
  }
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
  // The import used to run silently and report one number at the end. On a
  // 25,000-person write that is minutes of a card that looks broken, and a
  // "check the log" message pointing at an empty box. Same log, same counters
  // and same progress bar the collect half uses.
  // preview is kept, not cleared: planRows (magellan-sheet.js) reads
  // state.preview.accounts to write the Plan tab, and that write happens
  // during THIS run's final publish below.
  _state = startRun({
    phase: 'importing',
    done: 0, total: (plans || []).length, account: null, step: 'Starting the import',
  }, { preview: _state.preview });
  const people = (plans || []).reduce((n, p) => n + p.plan.creates.length + p.plan.updates.length, 0);
  log(`▶ Importing ${plans.length} account${plans.length === 1 ? '' : 's'} — ${people} people.`);

  // perAccount so the sheet can show which account contributed what, rather
  // than one aggregate number nobody can trace back.
  const result = { created: 0, updated: 0, extraEmails: 0, notWritten: 0, errors: [], perAccount: [] };
  try {
    for (const { account, plan } of plans || []) {
      const row = { account, created: 0, updated: 0, extraEmails: 0, notWritten: 0, errors: [] };
      result.perAccount.push(row);
      _state.account = account;

      _state.step = `Adding ${plan.creates.length} new people`;
      const c = await create(plan.creates);
      row.created = c.created;
      row.errors.push(...c.errors.map((e) => ({ stage: 'create', ...e })));

      _state.step = `Updating ${plan.updates.length} existing people`;
      const u = await update(plan.updates);
      row.updated = u.updated;
      row.errors.push(...u.errors.map((e) => ({ stage: 'update', ...e })));

      // One call each — no batch endpoint exists for secondary emails.
      _state.step = `Attaching ${plan.additionalEmails.length} email addresses`;
      for (const item of plan.additionalEmails) {
        try { await attach(item); row.extraEmails += 1; } catch (err) {
          row.errors.push({ stage: 'email', id: item.id, error: err.message });
        }
      }

      // What the failures COST, not how many lines they produced. A rejected
      // batch of 100 is one error object and a hundred missing people; counting
      // the objects reported that as "1 problem" next to "168 added" and read
      // like a clean run.
      const byCause = summariseProblems(row.errors);
      row.notWritten = byCause.reduce((n, g) => n + g.people, 0);
      const notes = byCause.filter((g) => !g.blocking).reduce((n, g) => n + g.count, 0);

      const bits = [`${row.created} added`, `${row.updated} updated`];
      if (row.extraEmails) bits.push(`${row.extraEmails} email addresses attached`);
      if (row.notWritten) bits.push(`${row.notWritten} NOT written`);
      if (notes) bits.push(`${notes} note${notes === 1 ? '' : 's'}`);
      log(`✓ ${account}: ${bits.join(', ')}`);
      // Every problem, in the words of whoever has to fix it — and never more
      // than one line per distinct cause per account. Ten thousand identical
      // duplicate-contact clashes are one job, not ten thousand log lines.
      // Worst-first: the cause that cost people leads, whatever its tally.
      for (const g of byCause) {
        const first = row.errors.find((e) => explainProblem(e.error, { stage: e.stage }).code === g.code);
        const p = explainProblem(first.error, { stage: first.stage });
        log(problemLine(account, p, { people: g.people, count: g.count }));
      }

      result.created += row.created;
      result.updated += row.updated;
      result.extraEmails += row.extraEmails;
      result.notWritten += row.notWritten;
      result.errors.push(...row.errors.map((e) => ({ account, ...e })));
      _state.done += 1;
    }
    _state.imported = { ...result, at: new Date().toISOString(), problems: summariseProblems(result.errors) };
    const totals = [`${result.created} added`, `${result.updated} updated`];
    if (result.extraEmails) totals.push(`${result.extraEmails} email addresses attached`);
    if (result.notWritten) totals.push(`${result.notWritten} NOT written`);
    log(`■ Import finished. ${totals.join(', ')}.`);
    // The roll-up: one line per KIND of problem, with the count and what to do.
    // This is the part someone hands to whoever cleans HubSpot, so it has to
    // stand on its own without the lines above it — and it has to keep the two
    // kinds apart. Lumped together, one config error that dropped 61 people sat
    // in the same list as thirty duplicate notes where nothing was lost at all.
    const who = (p) => (p.accounts.length <= 3
      ? ` (${p.accounts.join(', ')})` : ` (across ${p.accounts.length} accounts)`);
    const blocking = _state.imported.problems.filter((p) => p.blocking);
    const notes = _state.imported.problems.filter((p) => !p.blocking);
    if (blocking.length) {
      log(`⚠ ${result.notWritten} people were not written. Fix these, then run the import for `
        + 'those accounts again — people already written are skipped, so a repeat run is safe:');
      for (const p of blocking) {
        log(`⚠ ${p.people} not written — ${p.what} — ${p.fix}${who(p)}`);
      }
    }
    for (const p of notes) {
      log(`· ${p.count} × ${p.what} — nothing was lost. ${p.fix}${who(p)}`);
    }
    _state.phase = 'done';
    // Same rule as buildPreview: running clears once _state.imported already
    // exists, THEN buildOutcome(state) is asked — honestly, since it returns
    // null for as long as state.running reads true. The finally's running =
    // false is the idempotent safety net for a throw before this line.
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    // Detached, and last: the snapshot it writes has to carry the finished
    // phase and the outcome, or the Import tab records a run still in flight.
    sheetAfterRun(_state, sheet, 'import');
    return { ok: true, ...result };
  } catch (err) {
    log(`✗ The import stopped — ${err.message}`);
    // Whatever already went into HubSpot is real and cannot be taken back, so
    // it is recorded before the error is. Without this the card showed only the
    // error sentence: an import that died on account 9 of 12 left no trace of
    // the 18,000 contacts it had already written except the log.
    if (result.created || result.updated || result.extraEmails || result.errors.length) {
      _state.imported = { ...result, at: new Date().toISOString(), problems: summariseProblems(result.errors) };
    }
    _state.error = err.message;
    _state.phase = 'error';
    _state.running = false;
    _state.outcome = buildOutcome(_state);
    return { ok: false, reason: err.message, ...result };
  } finally {
    _state.running = false;
    _state.account = null;
    _state.step = null;
  }
}
