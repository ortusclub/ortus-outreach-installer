import test from 'node:test';
import assert from 'node:assert/strict';
import {createJpegDecoder} from '../public/js/mjpeg-frames.mjs';
import {createScrapeWaitLog} from '../public/js/scrape-wait-log.mjs';
test('preview decodes JPEG boundaries split across arbitrary network chunks',()=>{
 const bytes=Uint8Array.from([13,10,255,216,1,2,255,217,13,10,255,216,3,255,217]);
 for(let size=1;size<=bytes.length;size++){
  const frames=[];const decode=createJpegDecoder(f=>frames.push([...f]));
  for(let i=0;i<bytes.length;i+=size)decode(bytes.slice(i,i+size));
  assert.deepEqual(frames,[[255,216,1,2,255,217],[255,216,3,255,217]]);
 }
});
test('waiting logs are throttled and stop when worker starts',()=>{
 const log=createScrapeWaitLog();const jobs=[{id:'one',state:'queued',createdAt:1000}];
 assert.equal(log(jobs,1000).length,1);assert.equal(log(jobs,2000).length,1);
 assert.equal(log(jobs,31000).length,2);jobs[0].state='running';
 assert.equal(log(jobs,61000).length,2);
});
