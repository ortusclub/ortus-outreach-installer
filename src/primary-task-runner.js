/**
 * src/primary-task-runner.js — the safe-window runner. Every 60s, when nothing
 * else has a browser open (browser-semaphore count 0) and no campaign is
 * running, it drains due primary tasks ONE browser at a time: the local browser
 * for accepts + your-side follow-ups; the specific gologin account for
 * campaign-account follow-ups. runDueTasks takes injected deps so it's testable
 * without a real browser.
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
  loadTasks as _loadTasks, markTask as _markTask, resetInProgress,
  selectDue, partitionByBrowser,
} from './primary-tasks.js';

const MAX_ATTEMPTS = 3;
let _timer = null;

/** Pure gate: only act when the whole app is idle. */
export function shouldRun({ campaignRunning, browserCount }) {
  return !campaignRunning && browserCount === 0;
}

async function _settleFailure(task, err, markTask) {
  const attempts = (task.attempts || 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await markTask(task.id, status, { attempts, lastError: err.message || String(err) });
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
  const { acceptFn, sendFn, markTask, emit, log } = deps;
  try {
    // Claim the task before acting. If THIS throws, the action never ran, so the
    // catch path (retry) is correct.
    await markTask(t.id, 'in_progress', {});
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
      await sendFn(page, t.threadUrl, t.body, { introTitle: t.introTitle, leadName: t.leadName, log });
      await _safeMark(markTask, t.id, 'done', {}, log);
      emit(t, `✓ Follow-up sent — ${t.leadName || 'lead'} (group chat)`);
    }
    return true;
  } catch (e) {
    try { await _settleFailure(t, e, markTask); }
    catch (se) { log(`  ⚠ Primary runner: could not record failure for ${t.id}: ${se.message}`); }
    return false;
  }
}

/** Core drain loop. deps are injected for testing. */
export async function runDueTasks(now, deps) {
  const {
    loadTasks, markTask, launchLocal, closeLocal, launchAccount, closeAccount,
    acceptInvitationFrom: acceptFn, sendInThread: sendFn, semaphore, log,
    guardIdle = async () => true, emit = () => {},
  } = deps;
  const pdeps = { acceptFn, sendFn, markTask, emit, log };

  const due = selectDue(await loadTasks(), now);
  if (due.length === 0) return { ran: 0 };
  const { local, byAccount } = partitionByBrowser(due);
  let ran = 0;

  if (local.length) {
    if (await guardIdle()) {
      await semaphore.acquire();
      try {
        log(`  🖥 Opening your local browser — ${local.length} primary task(s) due`);
        const { page } = await launchLocal();
        for (const t of local) { if (await _processOne(t, page, pdeps)) ran++; }
      } catch (e) {
        log(`  ⚠ Primary runner: local browser session failed: ${e.message}`);
        for (const t of local) { try { await _settleFailure(t, e, markTask); } catch { /* */ } }
      } finally {
        try { await closeLocal(); } catch { /* */ }
        semaphore.release();
      }
    } else {
      log('  ⏸ Primary runner: no longer idle — deferring local-browser tasks to the next tick.');
    }
  }

  for (const [profileId, list] of Object.entries(byAccount)) {
    if (!(await guardIdle())) { log('  ⏸ Primary runner: no longer idle — deferring account follow-ups.'); break; }
    await semaphore.acquire();
    try {
      const { page } = await launchAccount(profileId);
      for (const t of list) { if (await _processOne(t, page, pdeps)) ran++; }
    } catch (e) {
      log(`  ⚠ Primary runner: account ${profileId} session failed: ${e.message}`);
      for (const t of list) { try { await _settleFailure(t, e, markTask); } catch { /* */ } }
    } finally {
      try { await closeAccount(profileId); } catch { /* */ }
      semaphore.release();
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
  resetInProgress().catch(() => {});
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(e => _log(`tick error: ${e.message}`)); }, 60 * 1000);
  if (_timer.unref) _timer.unref();
  _log('started (60s tick).');
}

export function stopPrimaryTaskRunner() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
