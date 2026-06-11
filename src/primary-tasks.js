/**
 * src/primary-tasks.js — the persisted queue behind primary-side automation.
 *
 * Two task types: 'accept' (local browser accepts the primary's incoming
 * invitation from a campaign account) and 'follow-up' (post-intro first
 * message in the group thread, from you or the campaign account). Pure
 * persistence + selection + builders — no Puppeteer, no campaign import. The
 * file path is injectable so tests run against a temp file.
 */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dataPath } from './paths.js';

export const PRIMARY_TASKS_FILE = dataPath('primary-tasks.json');

function slug(v) { return String(v || '').trim(); }

/** Stable dedupe identity: a pending task already covering the same work. */
export function dedupeKey(task) {
  if (task.type === 'accept') return `accept:${task.campaignProfileId}`;
  return `follow-up:${task.campaignProfileId}:${task.leadUrl || ''}`;
}

export function buildFollowUpTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  sender = 'local-browser', threadUrl = '', introTitle = '',
  leadName = '', leadUrl = '', primaryName = '', primaryUrl = '', body = '',
  delayMinutes = 10, now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  const delay = Number(delayMinutes) > 0 ? Number(delayMinutes) : 10;
  return {
    id: `follow-up:${campaignProfileId}:${slug(leadUrl) || 'lead'}:${created}`,
    type: 'follow-up', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created + delay * 60_000,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    sender, threadUrl, introTitle, leadName, leadUrl, primaryName, primaryUrl, body,
  };
}

export function buildAcceptTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  account = { name: '', profileUrl: '' }, primaryUrl = '', now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  return {
    id: `accept:${campaignProfileId}:${created}`,
    type: 'accept', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    account, primaryUrl,
  };
}

/** Pure: pending tasks whose dueAt has arrived. */
export function selectDue(tasks, now) {
  return (tasks || []).filter(t => t && t.status === 'pending' && t.dueAt <= now);
}

/** Pure: split due tasks into the local-browser bucket and per-account buckets. */
export function partitionByBrowser(due) {
  const local = [];
  const byAccount = {};
  for (const t of due) {
    if (t.type === 'accept' || t.sender === 'local-browser') {
      local.push(t);
    } else {
      (byAccount[t.sender] ||= []).push(t);
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
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2));
  await rename(tmp, file);
}

/** Append a task unless an equivalent pending one already exists. Returns the
 *  stored task, or null if it was a duplicate. */
export async function enqueuePrimaryTask(task, file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  const key = dedupeKey(task);
  if (tasks.some(t => t.status === 'pending' && dedupeKey(t) === key)) return null;
  tasks.push(task);
  await saveTasks(tasks, file);
  return task;
}

export async function markTask(id, status, patch = {}, file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  const t = tasks.find(x => x.id === id);
  if (!t) return false;
  t.status = status;
  Object.assign(t, patch);
  await saveTasks(tasks, file);
  return true;
}

/** Boot recovery: a task left 'in_progress' by a crash is reset to pending. */
export async function resetInProgress(file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  let changed = false;
  for (const t of tasks) {
    if (t.status === 'in_progress') { t.status = 'pending'; changed = true; }
  }
  if (changed) await saveTasks(tasks, file);
  return changed;
}

export async function clearTasksFile(file = PRIMARY_TASKS_FILE) {
  try { await unlink(file); } catch { /* not there is fine */ }
}
