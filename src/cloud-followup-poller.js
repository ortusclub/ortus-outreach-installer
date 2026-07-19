/**
 * src/cloud-followup-poller.js — drains a cloud campaign's PERSONAL-primary
 * follow-ups to the local machine.
 *
 * The VM never sends a personal follow-up (LinkedIn invalidates a personal
 * session replayed from a datacenter IP — see the local-drain design). The
 * engine leaves each due personal follow-up pending; this poller pulls the
 * owner's, enqueues them into the SAME local queue a local campaign uses (so the
 * existing [primary-runner] sends them from the person's own browser), then acks
 * the engine.
 *
 * DOUBLE-SEND SAFETY: the engine has no durable dedup for the personal path
 * (unlike GoLogin follow-ups, which use the Redis wasActionSent guard) — it
 * re-offers a follow-up on every poll until the ack lands. If an ack is lost
 * after the local send, a naive re-poll would enqueue + send the message AGAIN.
 * So we keep a DURABLE set of engine taskIds we've already enqueued: a re-offered
 * taskId is never re-enqueued (only re-acked to stop the re-offers). Persisted
 * before the ack, so it survives a lost ack, an app restart, or a crash.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { getLocalFollowups, ackLocalFollowups } from './campaigns-client.js';
import { buildFollowUpTask, enqueuePrimaryTask } from './primary-tasks.js';
import { getOperatorEmail } from './operator-identity.js';
import { dataPath } from './paths.js';

const LATE_MS = 30 * 60_000; // due >30 min ago = the app was closed → surface it
const DRAINED_FILE = dataPath('drained-followups.json');
const DRAINED_CAP = 2000; // bound the durable set (engine taskIds are monotonic)
let _timer = null;
let _lastLate = 0; // last poll's late count, for the UI nudge

export function lastLateCount() { return _lastLate; }

function sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}
async function loadDrained(file = DRAINED_FILE) {
  try { const a = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; } // missing = empty
}
async function saveDrained(ids, file = DRAINED_FILE) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(ids.slice(-DRAINED_CAP)));
  await rename(tmp, file);
}

export async function pollOnce(deps = {}) {
  const {
    getOperatorEmail: opEmail = getOperatorEmail,
    getLocalFollowups: getFn = getLocalFollowups,
    ackLocalFollowups: ackFn = ackLocalFollowups,
    buildFollowUpTask: build = buildFollowUpTask,
    enqueuePrimaryTask: enqueue = enqueuePrimaryTask,
    loadDrained: loadD = loadDrained,
    saveDrained: saveD = saveDrained,
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

  const drained = new Set(await loadD());
  const acked = [];
  let enqueued = 0;
  let late = 0;
  for (const fu of res.followups) {
    // Already enqueued in a prior poll (ack must have been lost) → re-ack only,
    // never re-enqueue, so the lead is never messaged twice.
    if (drained.has(fu.taskId)) { acked.push(fu.taskId); continue; }
    try {
      const task = build({
        campaignProfileId: fu.profileId, sheetId: sheetIdFromUrl(fu.sheetUrl), sheetUrl: fu.sheetUrl,
        sender: 'local-browser', threadUrl: fu.threadUrl, introTitle: fu.introTitle, leadName: fu.leadName,
        leadUrl: fu.leadUrl, primaryName: fu.primaryName, primaryUrl: fu.primaryUrl,
        body: fu.body, delayMinutes: 0, now: now(),
      });
      await enqueue(task);                 // local dedupe on follow-up:<profileId>:<leadUrl>
      drained.add(fu.taskId);              // mark before persist/ack — the durable guard
      acked.push(fu.taskId);
      enqueued++;
      if (fu.dueAt && (now() - new Date(fu.dueAt).getTime()) > LATE_MS) late++;
    } catch (e) {
      log(`enqueue failed for ${fu.leadUrl || fu.taskId}: ${e.message} — will retry next poll`);
    }
  }

  if (enqueued) { try { await saveD([...drained]); } catch (e) { log(`persist drained failed: ${e.message}`); } }
  if (acked.length) { try { await ackFn(acked, owner); } catch (e) { log(`ack failed: ${e.message}`); } }
  _lastLate = late;
  if (enqueued) log(`drained ${enqueued} personal follow-up(s)${late ? `, ${late} late` : ''}`);
  return { enqueued, acked: acked.length, late };
}

export function startCloudFollowupPoller() {
  if (_timer) return;
  _timer = setInterval(() => { pollOnce().catch((e) => console.warn(`[cloud-followup-poller] tick: ${e.message}`)); }, 60_000);
  if (_timer.unref) _timer.unref();
  console.log('[cloud-followup-poller] started (60s tick).');
}
export function stopCloudFollowupPoller() { if (_timer) { clearInterval(_timer); _timer = null; } }
