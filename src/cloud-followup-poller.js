/**
 * src/cloud-followup-poller.js — drains a cloud campaign's PERSONAL-primary
 * follow-ups to the local machine.
 *
 * The VM never sends a personal follow-up (LinkedIn invalidates a personal
 * session replayed from a datacenter IP — see the local-drain design). The
 * engine leaves each due personal follow-up pending; this poller pulls the
 * owner's, enqueues them into the SAME local queue a local campaign uses (so the
 * existing [primary-runner] sends them from the person's own browser), then acks
 * the engine. Ack is AFTER the local enqueue: a crash between pull and enqueue
 * re-offers next poll, and the local dedupeKey makes the re-enqueue a no-op.
 */
import { getLocalFollowups, ackLocalFollowups } from './campaigns-client.js';
import { buildFollowUpTask, enqueuePrimaryTask } from './primary-tasks.js';
import { getOperatorEmail } from './operator-identity.js';

const LATE_MS = 30 * 60_000; // due >30 min ago = the app was closed → surface it
let _timer = null;
let _lastLate = 0; // last poll's late count, for the UI nudge

export function lastLateCount() { return _lastLate; }

export async function pollOnce(deps = {}) {
  const {
    getOperatorEmail: opEmail = getOperatorEmail,
    getLocalFollowups: getFn = getLocalFollowups,
    ackLocalFollowups: ackFn = ackLocalFollowups,
    buildFollowUpTask: build = buildFollowUpTask,
    enqueuePrimaryTask: enqueue = enqueuePrimaryTask,
    now = () => Date.now(),
    log = (m) => console.log(`[cloud-followup-poller] ${m}`),
  } = deps;

  const owner = opEmail();
  if (!owner) return { enqueued: 0, acked: 0, late: 0 };

  const res = await getFn(owner);
  if (!res || res.error || !Array.isArray(res.followups) || !res.followups.length) {
    _lastLate = 0;
    return { enqueued: 0, acked: 0, late: 0 };
  }

  const acked = [];
  let late = 0;
  for (const fu of res.followups) {
    try {
      const task = build({
        campaignProfileId: fu.profileId, sheetUrl: fu.sheetUrl, sender: 'local-browser',
        threadUrl: fu.threadUrl, introTitle: fu.introTitle, leadName: fu.leadName,
        leadUrl: fu.leadUrl, primaryName: fu.primaryName, primaryUrl: fu.primaryUrl,
        body: fu.body, delayMinutes: 0, now: now(),
      });
      await enqueue(task);                 // dedupes on follow-up:<profileId>:<leadUrl>
      acked.push(fu.taskId);               // ack ONLY what actually enqueued
      if (fu.dueAt && (now() - new Date(fu.dueAt).getTime()) > LATE_MS) late++;
    } catch (e) {
      log(`enqueue failed for ${fu.leadUrl || fu.taskId}: ${e.message} — will retry next poll`);
    }
  }

  if (acked.length) { try { await ackFn(acked); } catch (e) { log(`ack failed: ${e.message}`); } }
  _lastLate = late;
  if (acked.length) log(`drained ${acked.length} personal follow-up(s)${late ? `, ${late} late` : ''}`);
  return { enqueued: acked.length, acked: acked.length, late };
}

export function startCloudFollowupPoller() {
  if (_timer) return;
  _timer = setInterval(() => { pollOnce().catch((e) => console.warn(`[cloud-followup-poller] tick: ${e.message}`)); }, 60_000);
  if (_timer.unref) _timer.unref();
  console.log('[cloud-followup-poller] started (60s tick).');
}
export function stopCloudFollowupPoller() { if (_timer) { clearInterval(_timer); _timer = null; } }
