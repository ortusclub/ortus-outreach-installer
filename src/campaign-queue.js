import fs from 'node:fs/promises';
import { dataPath } from './paths.js';
import { writeJsonAtomic } from './atomic-json-store.js';
import { createQueueStore } from './queue-store.js';

const file = dataPath('queued-campaigns.json');
const store = createQueueStore({
  read: async () => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  },
  write: value => writeJsonAtomic(file, value),
});
export const { getQueue, addToQueue, removeFromQueue, updateQueueEntry,
  popNext, popNextReady, claimNextReady, releaseQueueClaim, moveInQueue, clearQueue, reorderQueue } = store;
