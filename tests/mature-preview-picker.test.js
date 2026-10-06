import test from 'node:test';
import assert from 'node:assert/strict';
import { maturingPreviewAccounts } from '../public/js/mature-preview-picker.mjs';
test('active browsers come first, then sleeping and stopped accounts', () => {
  const rows = maturingPreviewAccounts([{ id:'s', name:'A', bucket:'done' }, { id:'w', name:'B', bucket:'running' }, { id:'l', name:'Z', live:true,liveProgress:{phase:'sending',stepAt:Date.now()} }, {id:'p',name:'C',paused:true}]);
  assert.deepEqual(rows.map(x=>x.status), ['Connecting','Sleeping','Paused','Stopped']);
});
test('one entry per account prefers its active run and skips drafts', () => {
  const rows = maturingPreviewAccounts([{id:'warm',name:'A',bucket:'running'}, {id:'cold',name:'A · Cold',live:true,liveProgress:{phase:'sending',stepAt:Date.now()}}, {id:'draft',name:'D',bucket:'draft'}, {id:'saved',name:'S',bucket:'saved'}]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id,'cold');
  assert.equal(rows[0].name,'A');
});

import { maturingPreviewActivity } from '../public/js/mature-preview-picker.mjs';
test('open browser, daily sleep, and stale progress never imply activity', () => {
  const now = Date.now();
  const live = {live:true, liveProgress:{phase:'sending',stepAt:now}};
  assert.equal(maturingPreviewActivity({live:true}, now), '');
  assert.equal(maturingPreviewActivity({...live,dailyWait:true}, now), '');
  assert.equal(maturingPreviewActivity({...live,batchDoneToday:true}, now), '');
  assert.equal(maturingPreviewActivity({...live,bucket:'done'}, now), '');
  assert.equal(maturingPreviewActivity({...live,liveProgress:{phase:'sending',stepAt:now-180000}}, now), '');
  assert.equal(maturingPreviewActivity(live, now), 'Connecting');
  assert.equal(maturingPreviewActivity({...live,dailyWait:true,liveProgress:{phase:'accepting',stepAt:now}}, now), 'Accepting');
});

test('final acceptance stays active after sending completes, but cancellation wins', () => {
  const item={id:'warm',name:'Pauline',live:true,bucket:'done',engineStatus:'completed',liveProgress:{phase:'accepting',accountName:'Recipient',stepAt:Date.now()}};
  assert.equal(maturingPreviewActivity(item), 'Accepting');
  assert.equal(maturingPreviewAccounts([item])[0].active,true);
  assert.equal(maturingPreviewActivity({...item,engineStatus:'cancelled'}), '');
});
