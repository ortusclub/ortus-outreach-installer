import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dataPath } from '../paths.js';

// Membership is separate from collected data: removing an account never deletes a CSV.
export function createRoster(file = dataPath('magellan-roster.json')) {
  const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const save = (rows) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 2));
    renameSync(`${file}.tmp`, file);
    return rows;
  };
  return {
    list: read,
    seed(accounts) { if (!existsSync(file)) this.add(accounts.filter(a => a.collected)); },
    add(accounts) {
      const rows = read();
      for (const a of accounts) {
        if (!a || typeof a.profileId !== 'string' || typeof a.account !== 'string' || !a.account.trim()) continue;
        if (!rows.some(r => r.profileId === a.profileId)) rows.push({ profileId: a.profileId, account: a.account, paused: false });
      }
      return save(rows);
    },
    action(id, action) {
      const rows = read();
      const row = rows.find(a => a.profileId === id);
      if (!row) throw new Error('Account is not in Operation Magellan');
      if (action === 'delete') return save(rows.filter(a => a.profileId !== id));
      if (!['pause', 'resume'].includes(action)) throw new Error('Unknown account action');
      row.paused = action === 'pause';
      return save(rows);
    },
  };
}
export const magellanRoster = createRoster();
