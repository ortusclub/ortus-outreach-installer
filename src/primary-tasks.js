/**
 * src/primary-tasks.js — the persisted queue behind primary-side automation.
 *
 * Two task types: 'accept' (local browser accepts the primary's incoming
 * invitation from a campaign account) and 'follow-up' (post-intro first
 * message in the group thread, from you or the campaign account). Pure
 * persistence + selection + builders — no Puppeteer, no campaign import. The
 * file path is injectable so tests run against a temp file.
 */
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { updateJsonAtomic, writeJsonAtomic } from './atomic-json-store.js';
import { dataPath } from './paths.js';

export const PRIMARY_TASKS_FILE = dataPath('primary-tasks.json');

function slug(v) { return String(v || '').trim(); }
export function hasTaskOwner(task) {
  return typeof task?.campaignId === 'string' && !!task.campaignId.trim()
    && typeof task?.campaignRunId === 'string' && !!task.campaignRunId.trim();
}

function holdUnownedTask(task) {
  if (!['accept', 'follow-up'].includes(task?.type) || hasTaskOwner(task)
    || !['pending', 'in_progress'].includes(task.status)) return false;
  task.reviewPreviousStatus = task.status;
  task.status = 'needs-review';
  task.reviewReason = 'campaign-ownership-unproven';
  task.lastError = 'Campaign/run ownership is missing. Review before sending; do not infer ownership from the account or message.';
  return true;
}

export function holdTasksWithoutOwner(file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => tasks.reduce((count, task) => count + Number(holdUnownedTask(task)), 0), file);
}
function stoppedOwner(tasks, task) {
  if (task.sourceTaskId && tasks.some(t => t.type === 'cloud-control' && t.campaignId === task.campaignId && t.status === 'stopped')) return true;
  return !!(task.campaignId && task.campaignRunId && tasks.some(t => t.type === 'owner-control'
    && t.status === 'stopped' && t.campaignId === task.campaignId && t.campaignRunId === task.campaignRunId));
}

export function taskControlBlocked(tasks, task) {
  return stoppedOwner(tasks, task) || tasks.some(t => t.type === 'owner-control' && t.status === 'paused'
    && t.campaignId === task.campaignId && t.campaignRunId === task.campaignRunId) || !!(task.sourceTaskId && tasks.some(t => t.type === 'cloud-control'
    && t.campaignId === task.campaignId && t.status === 'paused'));
}

export function pauseTaskOwner(owner, file = PRIMARY_TASKS_FILE) {
  if (!hasTaskOwner(owner)) throw new Error('Exact campaign and run IDs required');
  return mutateTasks(tasks => {
    if (stoppedOwner(tasks, owner)) throw new Error('A stopped run cannot be changed to paused');
    let marker = tasks.find(t => t.type === 'owner-control' && t.campaignId === owner.campaignId && t.campaignRunId === owner.campaignRunId);
    if (!marker) { marker = { ...owner, type: 'owner-control', id: `owner-control:${JSON.stringify([owner.campaignId, owner.campaignRunId])}` }; tasks.push(marker); }
    marker.status = 'paused'; marker.commandId = randomUUID();
    return { commandId: marker.commandId, inProgress: tasks.filter(t => t.campaignId === owner.campaignId
      && t.campaignRunId === owner.campaignRunId && t.status === 'in_progress').map(t => t.id) };
  }, file);
}

export function resumeTaskOwner(owner, commandId, file = PRIMARY_TASKS_FILE) {
  if (!hasTaskOwner(owner) || !commandId) throw new Error('Exact pause ownership required');
  return mutateTasks(tasks => {
    if (stoppedOwner(tasks, owner)) return false;
    const index = tasks.findIndex(t => t.type === 'owner-control' && t.status === 'paused'
      && t.campaignId === owner.campaignId && t.campaignRunId === owner.campaignRunId && t.commandId === commandId);
    if (index < 0) return false;
    tasks.splice(index, 1); return true;
  }, file);
}

export function controlCloudTaskOwner(campaignId, { pause = false } = {}, file = PRIMARY_TASKS_FILE) {
  if (typeof campaignId !== 'string' || !campaignId.trim()) throw new Error('Cloud campaign ID required');
  return mutateTasks(tasks => {
    let marker = tasks.find(t => t.type === 'cloud-control' && t.campaignId === campaignId);
    if (!marker) { marker = { id: `cloud-control:${campaignId}`, type: 'cloud-control', campaignId }; tasks.push(marker); }
    // Pause can never downgrade a Stop. Every newer command invalidates an old Resume.
    marker.status = marker.status === 'stopped' || !pause ? 'stopped' : 'paused';
    marker.commandId = randomUUID();
    marker.shutdownConfirmed = false;
    const inProgress = [];
    let cancelled = 0;
    for (const task of tasks) {
      if (!task.sourceTaskId || task.campaignId !== campaignId) continue;
      if (task.status === 'in_progress') inProgress.push(task.id);
      if (marker.status === 'stopped' && task.status === 'pending') { task.status = 'cancelled'; cancelled++; }
    }
    return { cancelled, inProgress, commandId: marker.commandId, status: marker.status };
  }, file);
}

export async function cloudTaskControl(campaignId, file = PRIMARY_TASKS_FILE) {
  let tasks;
  try { tasks = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Array.isArray(tasks)) throw new Error('Primary task queue must be an array');
  return tasks.find(t => t.type === 'cloud-control' && t.campaignId === campaignId) || null;
}

export function resumeCloudTaskOwner(campaignId, commandId, file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
    const index = tasks.findIndex(t => t.type === 'cloud-control' && t.campaignId === campaignId);
    if (index < 0) return !commandId;
    if (tasks[index].status !== 'paused' || tasks[index].commandId !== commandId
      || tasks[index].shutdownConfirmed !== true) return false;
    tasks.splice(index, 1);
    return true;
  }, file);
}

export function recordCloudControlReceipt(campaignId, commandId, confirmed, file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
    const marker = tasks.find(t => t.type === 'cloud-control' && t.campaignId === campaignId);
    if (!marker || marker.commandId !== commandId) return false;
    marker.shutdownConfirmed = confirmed === true;
    return true;
  }, file);
}

export async function isTaskOwnerStopped(owner, file = PRIMARY_TASKS_FILE) {
  if (!owner?.campaignId || !owner?.campaignRunId) return false; // legacy ownership remains unresolved
  let tasks;
  try { tasks = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Array.isArray(tasks)) throw new Error('Primary task queue must be an array');
  return stoppedOwner(tasks, owner);
}

export async function isTaskOwnerSuspended(owner, file = PRIMARY_TASKS_FILE) {
  if (!hasTaskOwner(owner)) return true;
  let tasks;
  try { tasks = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Array.isArray(tasks)) throw new Error('Primary task queue must be an array');
  return taskControlBlocked(tasks, owner);
}

/** Stable dedupe identity: a pending task already covering the same work. */
export function dedupeKey(task) {
  const owner = task.campaignId && task.campaignRunId ? `${JSON.stringify([task.campaignId, task.campaignRunId])}:` : '';
  if (task.type === 'accept') return `${owner}accept:${task.campaignProfileId}`;
  return `${owner}follow-up:${task.campaignProfileId}:${task.leadUrl || ''}`;
}

export function buildFollowUpTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  sender = 'local-browser', threadUrl = '', introTitle = '',
  leadName = '', leadUrl = '', primaryName = '', primaryUrl = '', body = '',
  // Which campaign this follow-up came from. A task never recorded it, so the
  // dashboard could only ever show the whole app's totals on every card, and a
  // campaign minutes old reported another campaign's failures as its own (Sam,
  // 2026-09-02). Tasks queued before this exist without it — src/followup-groups.js
  // places those by their message instead, which is the same campaign's template.
  campaignId = '', campaignName = '', campaignRunId = '',
  delayMinutes = 10, now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  // Honor an explicit 0 (send now — the cloud poller pulls already-due
  // follow-ups); only a missing/NaN/negative delay falls back to 10 min.
  const n = Number(delayMinutes);
  const delay = Number.isFinite(n) && n >= 0 ? n : 10;
  return {
    id: `follow-up:${campaignProfileId}:${slug(leadUrl) || 'lead'}:${created}${campaignRunId ? ':' + encodeURIComponent(campaignRunId) : ''}`,
    type: 'follow-up', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created + delay * 60_000,
    campaignId, campaignName, campaignRunId,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    sender, threadUrl, introTitle, leadName, leadUrl, primaryName, primaryUrl, body,
  };
}

/** Pure: return a COPY of tasks where every PENDING follow-up for this campaign
 *  has its dueAt set to `dueAt`. Accept tasks, other campaigns, and non-pending
 *  tasks are returned unchanged. Used to batch a run's follow-ups so they ripen
 *  together (v2.111). */
export function slideFollowUpDueDates(tasks, campaignProfileId, dueAt, owner = null) {
  return (tasks || []).map(t =>
    (t && t.type === 'follow-up' && t.status === 'pending' && t.campaignProfileId === campaignProfileId
      && (!owner || (t.campaignId === owner.campaignId && t.campaignRunId === owner.campaignRunId)))
      ? { ...t, dueAt }
      : t
  );
}

/** Pure: summary of the soonest pending follow-up batch for the given campaign
 *  profile ids → { count, dueAt, sender } or null when none pending. count is
 *  ALL pending follow-ups for those ids; dueAt is the soonest; sender is that
 *  soonest task's sender. Feeds the live-campaign countdown (v2.111). */
export function summarizeFollowUps(tasks, campaignProfileIds) {
  const ids = new Set(campaignProfileIds || []);
  const pending = (tasks || []).filter(
    t => t && t.type === 'follow-up' && t.status === 'pending' && ids.has(t.campaignProfileId)
  );
  if (pending.length === 0) return null;
  const soonest = pending.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
  return { count: pending.length, dueAt: soonest.dueAt, sender: soonest.sender || 'local-browser' };
}

export function buildAcceptTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  account = { name: '', profileUrl: '' }, primaryUrl = '', sender = 'local-browser', now,
  campaignId = '', campaignName = '', campaignRunId = '',
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  return {
    id: `accept:${campaignProfileId}:${created}${campaignRunId ? ':' + encodeURIComponent(campaignRunId) : ''}`,
    type: 'accept', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created,
    campaignId, campaignName, campaignRunId,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    account, primaryUrl, sender,
  };
}

/** Pure: pending tasks whose dueAt has arrived. */
export function selectDue(tasks, now) {
  return (tasks || []).filter(t => t && hasTaskOwner(t) && t.status === 'pending' && t.dueAt <= now && !taskControlBlocked(tasks, t));
}

/** Pure: split due tasks into the local-browser bucket and per-account buckets.
 *  Routing is by `sender` for ALL task types. Accept tasks built before the
 *  auto-accept-sender change have no `sender` field → treated as local-browser,
 *  preserving the old "accept always runs locally" behaviour. */
export function partitionByBrowser(due) {
  const local = [];
  const byAccount = {};
  for (const t of due) {
    const sender = t.sender || 'local-browser';
    if (sender === 'local-browser') {
      local.push(t);
    } else {
      (byAccount[sender] ||= []).push(t);
    }
  }
  return { local, byAccount };
}

export async function loadTasks(file = PRIMARY_TASKS_FILE) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Missing file is normal (empty queue). A corrupt file is worth a warning
    // so a silent parse failure doesn't look like "no tasks" without a trace.
    if (e && e.code !== 'ENOENT') console.warn(`[primary-tasks] load failed, starting empty: ${e.message}`);
    return [];
  }
}

export async function saveTasks(tasks, file = PRIMARY_TASKS_FILE) {
  await writeJsonAtomic(resolve(file), tasks);
}

// Same-process transaction shared by enqueue, claim and operator mutations.
// Strict reads prevent a corrupt queue from becoming an empty writable queue.
export async function mutateTasks(mutate, file = PRIMARY_TASKS_FILE) {
  let result;
  await updateJsonAtomic(resolve(file), [], async () => {
    let tasks;
    try { tasks = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') tasks = []; else throw error; }
    if (!Array.isArray(tasks)) throw new Error('Primary task queue must be an array');
    result = await mutate(tasks);
    return tasks;
  });
  return result;
}

export function claimTask(snapshot, now = Date.now(), file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
    const current = tasks.find(task => task.id === snapshot.id);
    if (holdUnownedTask(current) || !hasTaskOwner(current)) return false;
    if (!current || taskControlBlocked(tasks, current) || current.status !== 'pending' || !(current.dueAt <= now)
      || !isDeepStrictEqual(current, snapshot)) return false;
    current.status = 'in_progress';
    return true;
  }, file);
}

export function cancelTasksForOwner({ campaignId, campaignRunId }, file = PRIMARY_TASKS_FILE) {
  if (!campaignId || !campaignRunId) throw new Error('Exact campaign and run IDs required');
  return mutateTasks(tasks => {
    let cancelled = 0;
    for (const task of tasks) {
      if (task.campaignId === campaignId && task.campaignRunId === campaignRunId
        && task.status === 'pending') { task.status = 'cancelled'; cancelled++; }
    }
    return cancelled;
  }, file);
}

/** Append a task unless an equivalent pending one already exists. Returns the
 *  stored task, or null if it was a duplicate. */
export function stopTaskOwner({ campaignId, campaignRunId }, file = PRIMARY_TASKS_FILE) {
  if (!campaignId || !campaignRunId) throw new Error('Exact campaign and run IDs required');
  return mutateTasks(tasks => {
    let cancelled = 0;
    const inProgress = [];
    for (const task of tasks) {
      if (task.campaignId !== campaignId || task.campaignRunId !== campaignRunId) continue;
      if (task.status === 'pending') { task.status = 'cancelled'; cancelled++; }
      if (task.status === 'in_progress') inProgress.push(task.id);
    }
    let marker = tasks.find(t => t.type === 'owner-control' && t.campaignId === campaignId && t.campaignRunId === campaignRunId);
    if (!marker) {
      marker = { id: `owner-control:${JSON.stringify([campaignId, campaignRunId])}`, type: 'owner-control', campaignId, campaignRunId };
      tasks.push(marker);
    }
    marker.status = 'stopped';
    return { cancelled, inProgress };
  }, file);
}

export async function enqueuePrimaryTask(task, file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
  // Imported engine tasks retain the same ID on every offer, even after done.
  // A re-offer must never replace a terminal task or a review/Stop decision.
  if (task.sourceTaskId && tasks.some(t => t.id === task.id)) return null;
  if (!hasTaskOwner(task)) {
    const stored = { ...task };
    holdUnownedTask(stored);
    if (!tasks.some(t => t.id === stored.id)) tasks.push(stored);
    return null;
  }
  if (stoppedOwner(tasks, task)) {
    tasks.push({ ...task, status: 'cancelled' });
    return null;
  }
  const key = dedupeKey(task);
  if (tasks.some(t => t.status === 'pending' && dedupeKey(t) === key)) return null;
  tasks.push(task);
  return task;
  }, file);
}

/** Enqueue a follow-up so the whole campaign's pending follow-ups ripen together:
 *  align this task AND existing pending siblings (same campaignProfileId) to
 *  now + delayMinutes, then dedupe like enqueuePrimaryTask. Returns the stored
 *  task, or null on a duplicate lead (siblings are still slid + persisted, since
 *  a new intro DID fire). (v2.111) */
export async function enqueueFollowUpBatched(task, delayMinutes, now, file = PRIMARY_TASKS_FILE) {
  const created = Number.isFinite(now) ? now : Date.now();
  const delay = Number(delayMinutes) > 0 ? Number(delayMinutes) : 10;
  const batchDue = created + delay * 60_000;
  return mutateTasks(tasks => {
  if (!hasTaskOwner(task)) {
    const stored = { ...task, dueAt: batchDue };
    holdUnownedTask(stored);
    if (!tasks.some(t => t.id === stored.id)) tasks.push(stored);
    return null;
  }
  if (stoppedOwner(tasks, task)) {
    tasks.push({ ...task, dueAt: batchDue, status: 'cancelled' });
    return null;
  }
  const owner = task.campaignId && task.campaignRunId ? task : null;
  const slid = slideFollowUpDueDates(tasks, task.campaignProfileId, batchDue, owner);
  tasks.splice(0, tasks.length, ...slid);
  const key = dedupeKey(task);
  if (tasks.some(t => t.status === 'pending' && dedupeKey(t) === key)) {
    return null;
  }
  const stored = { ...task, dueAt: batchDue };
  tasks.push(stored);
  return stored;
  }, file);
}

export async function markTask(id, status, patch = {}, file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
  const t = tasks.find(x => x.id === id);
  if (!t) return false;
  // A late failure must not turn a review hold into a retryable failure.
  // A confirmed success may still settle an action interrupted during cleanup.
  if (['needs-review', 'interrupted'].includes(t.status) && !['done', 'skipped'].includes(status)) return false;
  if (['pending', 'in_progress'].includes(status)
    && (!hasTaskOwner(t) || ['needs-review', 'interrupted'].includes(t.status))) return false;
  if (taskControlBlocked(tasks, t) && ['pending', 'in_progress'].includes(status)) return false;
  // Retry/claim handlers may be finishing from an old snapshot. Explicit
  // operator restore uses mutateTasks; background marks cannot undo a cancel.
  if (['cancelled', 'discarded'].includes(t.status) && ['pending', 'in_progress'].includes(status)) return false;
  t.status = status;
  Object.assign(t, patch);
  return true;
  }, file);
}

/** Boot recovery must not retry an action whose remote outcome is unknown. */
export async function resetInProgress(file = PRIMARY_TASKS_FILE) {
  return mutateTasks(tasks => {
  let changed = false;
  for (const t of tasks) {
    if (holdUnownedTask(t)) { changed = true; continue; }
    if (t.status === 'in_progress') {
      t.status = 'interrupted';
      t.reviewReason = 'action-outcome-unknown';
      t.lastError = 'App restarted during an action. Verify its outcome before retrying.';
      changed = true;
    }
  }
  return changed;
  }, file);
}

export async function clearTasksFile(file = PRIMARY_TASKS_FILE) {
  try { await unlink(file); } catch { /* not there is fine */ }
}
