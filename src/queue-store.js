import { randomUUID } from 'node:crypto';

// Process-local serialization, not a cross-process lock. Publish only after
// durable replacement succeeds; callers never receive mutable cached objects.
export function createQueueStore({ read, write, makeId = () => 'q_' + randomUUID(), now = Date.now }) {
  let cache;
  let tail = Promise.resolve();
  const transact = (operation, persist = true) => {
    const result = tail.then(async () => {
      if (cache === undefined) {
        const loaded = await read();
        if (!Array.isArray(loaded)) throw new Error('Campaign queue is not an array');
        cache = structuredClone(loaded);
      }
      const draft = structuredClone(cache);
      const value = operation(draft);
      if (persist) { await write(draft); cache = draft; }
      return structuredClone(value);
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    getQueue: () => transact(q => q, false),
    addToQueue: (config, owner, { scheduledAt = null } = {}) => transact(q => {
      const entry = { id: makeId(), queuedAt: now(), name: config?.name || '', config: structuredClone(config), owner: owner || null, ...(scheduledAt ? { scheduledAt } : {}) };
      q.push(entry); return entry;
    }),
    removeFromQueue: id => transact(q => { const i = q.findIndex(e => e.id === id); if (i < 0) return false; q.splice(i, 1); return true; }),
    updateQueueEntry: (id, patch) => transact(q => {
      if (!patch || typeof patch !== 'object') throw new Error('updateQueueEntry: patch must be an object');
      for (const key of Object.keys(patch)) if (!['name', 'scheduledAt', 'config'].includes(key)) throw new Error(`updateQueueEntry: unknown key "${key}"`);
      const entry = q.find(e => e.id === id); if (!entry) return null;
      if (patch.name !== undefined) entry.name = patch.name;
      if (patch.scheduledAt !== undefined) entry.scheduledAt = patch.scheduledAt;
      if (patch.config !== undefined) entry.config = { ...entry.config, ...structuredClone(patch.config) };
      return entry;
    }),
    popNext: () => transact(q => q.shift() || null),
    popNextReady: (at = now()) => transact(q => {
      const i = q.findIndex(e => !e.scheduledAt || !Number.isFinite(new Date(e.scheduledAt).getTime()) || new Date(e.scheduledAt).getTime() <= at);
      return i < 0 ? null : q.splice(i, 1)[0];
    }),
    claimNextReady: (at = now()) => transact(q => {
      const entry = q.find(e => !e.launchState && (!e.scheduledAt || !Number.isFinite(new Date(e.scheduledAt).getTime()) || new Date(e.scheduledAt).getTime() <= at));
      if (!entry) return null;
      entry.launchState = 'starting-review-if-interrupted';
      return entry;
    }),
    releaseQueueClaim: id => transact(q => {
      const entry = q.find(e => e.id === id);
      if (!entry) return false;
      delete entry.launchState; return true;
    }),
    moveInQueue: (id, direction) => transact(q => {
      const i = q.findIndex(e => e.id === id); if (i < 0) return -1;
      const target = i + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
      if (target < 0 || target >= q.length || target === i) return i;
      q.splice(target, 0, q.splice(i, 1)[0]); return target;
    }),
    clearQueue: () => transact(q => { q.length = 0; }),
    reorderQueue: ids => transact(q => {
      if (!Array.isArray(ids)) return { ok: false, reason: 'invalid_input' };
      const byId = new Map(q.map(e => [e.id, e]));
      if (ids.length !== q.length || new Set(ids).size !== q.length || ids.some(id => !byId.has(id))) return { ok: false, reason: 'mismatch' };
      q.splice(0, q.length, ...ids.map(id => byId.get(id))); return { ok: true };
    }),
  };
}
