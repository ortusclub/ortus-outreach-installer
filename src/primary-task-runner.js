/**
 * src/primary-task-runner.js — the safe-window runner. Every 60s, when nothing
 * else has a browser open (browser-semaphore count 0) and no campaign is
 * running, it drains due primary tasks ONE browser at a time, routed by each
 * task's `sender`: the local browser when sender is 'local-browser', or the
 * primary's specific gologin profile when sender is a profileId. runDueTasks
 * takes injected deps so it's testable without a real browser.
 *
 * Safety properties:
 *  - Hard cap: every browser open routes through browser-semaphore (≤ max).
 *  - Soft idle: a re-checked `guardIdle()` before each acquire defers work if a
 *    campaign started during the file-read await (tightens the TOCTOU window).
 *  - No double-send: a task is marked 'in_progress' before its action; a
 *    terminal-mark failure after a successful send leaves it 'in_progress'
 *    (skipped by selectDue) rather than back to 'pending'.
 *  - Bounded retries: launch failures settle each task (attempts++), so a
 *    persistently-failing launch can't retry forever.
 */
import * as browserSemaphore from './browser-semaphore.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';
import { acceptInvitationFrom } from './linkedin/accept-invitation.js';
import { sendInThread } from './linkedin/thread-message.js';
import { appendCampaignLog } from './campaign-log-bus.js';
import {
  loadTasks as _loadTasks, markTask as _markTask, claimTask as _claimTask, resetInProgress,
  selectDue, partitionByBrowser, hasTaskOwner, taskControlBlocked,
} from './primary-tasks.js';
import { isSignedOut } from './linkedin/thread-message.js';
import { registerPrimaryOperation } from './primary-task-control.js';
import { preparePrimarySession } from './primary-session-control.js';

const MAX_ATTEMPTS = 3;
const SESSION_BACKOFF_MS = 30 * 60 * 1000;
let _timer = null;

/** Pure gate: only act when the whole app is idle. */
export function shouldRun({ campaignRunning, browserCount }) {
  return !campaignRunning && browserCount === 0;
}

// A signed-out follow-up browser is not the task's fault, and no number of
// retries fixes it — only the operator signing in does. Counting it toward
// MAX_ATTEMPTS is what turned five recoverable follow-ups into five dead ones on
// 1 Sep: three attempts each, then 'failed', terminal, while the leads sat there
// having received an intro and no follow-up. So it parks instead: pending,
// attempts untouched, waiting for a session rather than for a miracle.
export function isBlockedBySession(err) {
  return /FOLLOWUP_SIGNED_OUT/i.test(String((err && err.message) || err || ''));
}

async function _settleFailure(task, err, markTask) {
  if (isBlockedBySession(err)) {
    // Parked, not failed — but pushed out half an hour. A pending task whose
    // dueAt is in the past is selected on EVERY tick, so parking without a
    // backoff would relaunch Chrome once a minute forever. Signing in clears it
    // sooner via the Retry button, which resets dueAt to now.
    await markTask(task.id, 'pending', {
      attempts: task.attempts || 0,
      lastError: 'FOLLOWUP_SIGNED_OUT',
      blockedBySession: true,
      dueAt: Date.now() + SESSION_BACKOFF_MS,
    });
    return;
  }
  const attempts = (task.attempts || 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await markTask(task.id, status, { attempts, lastError: err.message || String(err), blockedBySession: false });
}

/** Persist a TERMINAL status; never throw. A failure here (disk pressure) after
 *  a successful action must NOT flip the task back to pending — leaving it
 *  'in_progress' means selectDue skips it this session, so a non-idempotent
 *  follow-up is never sent twice. */
async function _safeMark(markTask, id, status, patch, log) {
  try {
    await markTask(id, status, patch);
  } catch (e) {
    log(`  ⚠ Primary runner: could not mark ${id} '${status}' after its action (left in_progress; won't re-run this session): ${e.message}`);
  }
}

/** Process exactly one task. Never throws — failures are recorded internally so
 *  one bad task can't abort the rest of the bucket. Returns true if its action
 *  ran to completion (so the caller can count it). */
async function _processOne(t, page, deps) {
  const { acceptFn, sendFn, markTask, emit, log, isCurrent, claim } = deps;
  let operation;
  try {
    // A task may have been removed, cancelled, held or edited while its
    // browser opened. An old batch snapshot is not permission to act.
    if (!await isCurrent(t)) return false;
    // Claim the task before acting. If THIS throws, the action never ran, so the
    // catch path (retry) is correct.
    if (await claim(t) === false) return false;
    operation = registerPrimaryOperation({ campaignId: t.campaignId, campaignRunId: t.campaignRunId, taskId: t.id, sourceTaskId: t.sourceTaskId }, deps.closeCurrent);
    if (!await isCurrent(t, ['pending', 'in_progress']) || operation.signal.aborted) return false;
    if (t.type === 'accept') {
      const r = await acceptFn(page, t.account, { log });
      await _safeMark(markTask, t.id, r.accepted ? 'done' : 'skipped', { lastError: r.reason || null }, log);
      // The accepting browser is the local one unless an auto-accept sender
      // (a GoLogin profileId) was configured — keep the log truthful either way.
      const _via = (t.sender && t.sender !== 'local-browser') ? 'via a GoLogin profile' : 'via your local browser';
      emit(t, r.accepted
        ? `✓ Connection accepted — ${t.campaignProfileName || 'account'} (${_via})`
        : `⚠ Auto-accept: no matching invitation for ${t.campaignProfileName || 'account'} — skipped`);
    } else {
      // holdIfLeadReplied: a lead who has already written back should not get a
      // scheduled follow-up posted underneath their own message. The runner
      // parks it as 'held' — selectDue() only ever takes 'pending', so it can
      // never go out on its own — and the card asks the operator to read it.
      const r = await sendFn(page, t.threadUrl, t.body, {
        introTitle: t.introTitle, leadName: t.leadName, log, holdIfLeadReplied: true,
      });
      if (r && r.held) {
        await _safeMark(markTask, t.id, 'held', {
          heldReason: r.held.reason, heldPhrase: r.held.phrase,
          heldQuote: r.held.quote, heldAt: Date.now(), lastError: null,
        }, log);
        emit(t, r.held.reason === 'declined'
          ? `✋ Follow-up held — ${t.leadName || 'the lead'} replied and it reads like a no. Read it and decide.`
          : `✋ Follow-up held — ${t.leadName || 'the lead'} has replied. Read it and decide.`);
      } else {
        await _safeMark(markTask, t.id, 'done', {}, log);
        emit(t, `✓ Follow-up sent — ${t.leadName || 'lead'} (group chat)`);
      }
    }
    return true;
  } catch (e) {
    try {
      if (operation?.signal.aborted) await markTask(t.id, 'interrupted', { lastError: 'Stopped during background action; verify outcome before retrying' });
      else if (await isCurrent(t, ['pending', 'in_progress'])) await _settleFailure(t, e, markTask);
    }
    catch (se) { log(`  ⚠ Primary runner: could not record failure for ${t.id}: ${se.message}`); }
    return false;
  } finally {
    if (operation?.signal.aborted) deps.cancelledBrowser = true;
    operation?.finish();
  }
}

/** Core drain loop. deps are injected for testing. */
export async function runDueTasks(now, deps) {
  const {
    loadTasks, markTask, launchLocal, closeLocal, launchAccount, closeAccount,
    acceptInvitationFrom: acceptFn, sendInThread: sendFn, semaphore, log,
    guardIdle = async () => true, emit = () => {},
    checkSignedOut = isSignedOut,
  } = deps;
  const requireOwner = typeof deps.claimTask === 'function';
  const isCurrent = async (task, statuses = ['pending']) => {
    if (requireOwner && !hasTaskOwner(task)) return false;
    const tasks = await loadTasks();
    if (taskControlBlocked(tasks, task)) return false;
    if (task.campaignId && task.campaignRunId && tasks.some(item => item.type === 'owner-control'
      && item.status === 'stopped' && item.campaignId === task.campaignId && item.campaignRunId === task.campaignRunId)) return false;
    const current = tasks.find(item => item.id === task.id);
    if (!current || !statuses.includes(current.status) || current.dueAt > now) return false;
    // Reconfiguration also invalidates the snapshot: do not send an old body
    // or use an old account after the operator edits the queued task.
    return JSON.stringify({ ...current, status: 'pending' }) === JSON.stringify({ ...task, status: 'pending' });
  };
  const settlePendingFailure = async (task, error) => {
    if (await isCurrent(task)) await _settleFailure(task, error, markTask);
  };
  const claim = deps.claimTask
    ? task => deps.claimTask(task, now)
    : task => markTask(task.id, 'in_progress', {}); // legacy injected test dependencies
  const pdeps = { acceptFn, sendFn, markTask, emit, log, isCurrent, claim };

  const due = structuredClone(selectDue(await loadTasks(), now));
  if (due.length === 0) return { ran: 0 };
  const { local, byAccount } = partitionByBrowser(due);
  let ran = 0;

  if (local.length) {
    if (await guardIdle()) {
      let session;
      try {
        log(`  🖥 Opening your local browser — ${local.length} primary task(s) due`);
        session = await preparePrimarySession(local, { semaphore, launch: launchLocal, close: closeLocal, prepare: checkSignedOut });
        const { page } = session;
        // Ask once, not once per lead. Without this every task opens a thread,
        // waits 15s for a composer that an authwall will never show, and settles
        // separately — five leads' worth of silence on 1 Sep. One probe parks the
        // whole batch and says it in words.
        if (session.prepared) {
          log('  🔑 Your follow-up browser is signed out of LinkedIn — the follow-ups are parked, not lost. Sign in once and they go out on their own.');
          for (const t of local) { try { await settlePendingFailure(t, new Error('FOLLOWUP_SIGNED_OUT')); } catch { /* */ } }
        } else {
          pdeps.closeCurrent = session.close;
          for (const t of local) {
            if (await _processOne(t, page, pdeps)) ran++;
            if (pdeps.cancelledBrowser) break;
          }
        }
      } catch (e) {
        log(`  ⚠ Primary runner: local browser session failed: ${e.message}`);
        if (e.primaryPreparationCancelled) pdeps.cancelledBrowser = true;
        else for (const t of local) { try { await settlePendingFailure(t, e); } catch { /* */ } }
      } finally {
        if (session) {
          try { await session.close(); } catch { /* */ }
          semaphore.release();
        }
      }
    } else {
      log('  ⏸ Primary runner: no longer idle — deferring local-browser tasks to the next tick.');
    }
  }

  for (const [profileId, list] of Object.entries(byAccount)) {
    if (pdeps.cancelledBrowser) break;
    if (!(await guardIdle())) { log('  ⏸ Primary runner: no longer idle — deferring account follow-ups.'); break; }
    let session;
    try {
      session = await preparePrimarySession(list, { semaphore,
        launch: options => launchAccount(profileId, options), close: () => closeAccount(profileId) });
      const { page } = session;
      pdeps.closeCurrent = session.close;
      for (const t of list) {
        if (await _processOne(t, page, pdeps)) ran++;
        if (pdeps.cancelledBrowser) break;
      }
    } catch (e) {
      log(`  ⚠ Primary runner: account ${profileId} session failed: ${e.message}`);
      if (e.primaryPreparationCancelled) pdeps.cancelledBrowser = true;
      else for (const t of list) { try { await settlePendingFailure(t, e); } catch { /* */ } }
    } finally {
      if (session) {
        try { await session.close(); } catch { /* */ }
        semaphore.release();
      }
    }
  }

  return { ran };
}

async function _isCampaignRunning() {
  try { const m = await import('./campaign.js'); return !!m.campaign?.running; } catch { return false; }
}

function _log(line) {
  console.log(`[primary-runner] ${line}`);
}

/** Production tick — gated, then drains with the real browser deps. */
export async function tick() {
  const campaignRunning = await _isCampaignRunning();
  const { count } = browserSemaphore.getStatus();
  if (!shouldRun({ campaignRunning, browserCount: count })) return;

  const token = process.env.GOLOGIN_API_TOKEN;
  await runDueTasks(Date.now(), {
    loadTasks: _loadTasks,
    markTask: _markTask,
    claimTask: _claimTask,
    launchLocal: launchLocalBrowser,
    closeLocal: closeLocalBrowser,
    launchAccount: (pid) => launchProfile(pid, token),
    closeAccount: (pid) => closeProfile(pid),
    acceptInvitationFrom,
    sendInThread,
    semaphore: browserSemaphore,
    // Re-checked just before each acquire: defer if a campaign started (or any
    // browser opened) during the loadTasks await — closes the TOCTOU gap.
    guardIdle: async () => !(await _isCampaignRunning()) && browserSemaphore.getStatus().count === 0,
    // Surface the major beats in the app's live log (keyed by the task's sheet +
    // account), in addition to the console.
    emit: (task, line) => {
      _log(line);
      if (task && task.sheetId) { try { appendCampaignLog(task.sheetId, task.campaignProfileId, line); } catch { /* */ } }
    },
    log: (line) => _log(line),
  });
}

export function startPrimaryTaskRunner() {
  if (_timer) return;
  resetInProgress().catch(e => _log(`queue recovery failed: ${e.message}`));
  _timer = setInterval(() => { tick().catch(e => _log(`tick error: ${e.message}`)); }, 60 * 1000);
  if (_timer.unref) _timer.unref();
  _log('started (60s tick).');
}

export function stopPrimaryTaskRunner() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
