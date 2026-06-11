/**
 * src/primary-task-runner.js — the safe-window runner. Every 60s, when nothing
 * else has a browser open (browser-semaphore count 0) and no campaign is
 * running, it drains due primary tasks ONE browser at a time: the local browser
 * for accepts + your-side follow-ups; the specific gologin account for
 * campaign-account follow-ups. runDueTasks takes injected deps so it's testable
 * without a real browser.
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

/** Core drain loop. deps are injected for testing. */
export async function runDueTasks(now, deps) {
  const {
    loadTasks, markTask, launchLocal, closeLocal, launchAccount, closeAccount,
    acceptInvitationFrom: acceptFn, sendInThread: sendFn, semaphore, log,
  } = deps;

  const due = selectDue(await loadTasks(), now);
  if (due.length === 0) return { ran: 0 };
  const { local, byAccount } = partitionByBrowser(due);
  let ran = 0;

  if (local.length) {
    await semaphore.acquire();
    try {
      const { page } = await launchLocal();
      for (const t of local) {
        try {
          if (t.type === 'accept') {
            const r = await acceptFn(page, t.account, { log });
            await markTask(t.id, r.accepted ? 'done' : 'skipped', { lastError: r.reason || null });
          } else {
            await sendFn(page, t.threadUrl, t.body, { introTitle: t.introTitle, leadName: t.leadName, log });
            await markTask(t.id, 'done', {});
          }
          ran++;
        } catch (e) {
          await _settleFailure(t, e, markTask);
        }
      }
    } catch (e) {
      log(`  ⚠ Primary runner: local browser session failed: ${e.message}`);
    } finally {
      try { await closeLocal(); } catch { /* */ }
      semaphore.release();
    }
  }

  for (const [profileId, list] of Object.entries(byAccount)) {
    await semaphore.acquire();
    try {
      const { page } = await launchAccount(profileId);
      for (const t of list) {
        try {
          await sendFn(page, t.threadUrl, t.body, { introTitle: t.introTitle, leadName: t.leadName, log });
          await markTask(t.id, 'done', {});
          ran++;
        } catch (e) {
          await _settleFailure(t, e, markTask);
        }
      }
    } catch (e) {
      log(`  ⚠ Primary runner: account ${profileId} session failed: ${e.message}`);
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
