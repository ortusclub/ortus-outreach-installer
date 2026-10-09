import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataPath } from './paths.js';

// Local Connection DB work had no durable run/actor history. Record each
// explicitly started phase; never attribute legacy runs to the current viewer.
export function createConnectionHistory(file = dataPath('connection-run-history.json')) {
  let rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  let current = null;
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(rows), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  if (rows.some(r => r.status === 'running')) {
    rows = rows.map(r => r.status === 'running' ? { ...r, status: 'interrupted' } : r);
    save();
  }
  return {
    list: () => rows.map(({ log, ...r }) => r),
    get: id => rows.find(r => r.id === id),
    start(state, actor, phase) {
      current = { id: randomUUID(), name: `Connection DB · ${phase}`, phase, owner: actor || '',
        startedAt: state.startedAt || new Date().toISOString(), status: 'running', total: state.total || 0, done: 0, log: [] };
      rows.push(current); save();
    },
    update(state) {
      if (!current) return;
      Object.assign(current, { total: state.total, done: state.done, log: (state.log || []).slice(-500),
        status: state.running ? 'running' : state.error ? 'error' : state.stopped ? 'stopped' : 'done',
        finishedAt: state.running ? null : state.finishedAt || new Date().toISOString(), outcome: state.outcome });
      save();
      if (!state.running) current = null;
    },
  };
}
