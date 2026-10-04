import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'ortus-queue-limit-'));
process.env.ORTUS_DATA_DIR = dir;
after(() => rmSync(dir, {recursive:true, force:true}));
const { addToQueue, getQueue, removeFromQueue } = await import('../src/campaign-queue.js');
test('concurrent local admissions allow five per owner and reuse freed slots', async () => {
 const results = await Promise.allSettled(Array.from({length:9}, (_,i)=>addToQueue({name:'Campaign '+i},' person@example.com ')));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
 for(const r of results.filter(r=>r.status==='rejected')) assert.equal(r.reason.code,'CAMPAIGN_QUEUE_FULL');
 await addToQueue({name:'Another user'},'other@example.com');
 const queue=await getQueue();assert.equal(queue.length,6);
 await removeFromQueue(queue[0].id);await addToQueue({name:'New slot'},'PERSON@example.com');assert.equal((await getQueue()).length,6);
});
