import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCallerConfig, callerSheetUrl, callerPreview } from '../public/js/caller-sheet-model.mjs';
const url='https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=123';
test('caller configuration preserves explicit tab and validates limits',()=>{
 const config=normalizeCallerConfig({sourceUrl:url,rowStart:3,rowEnd:6,smsDelayMinutes:0,eventDefaults:{event_city:'Rome'}});
 assert.equal(config.sourceUrl,url);assert.equal(config.smsDelayMinutes,0);assert.equal(config.eventDefaults.event_city,'Rome');
 assert.equal(config.maxCalls,250);assert.equal(config.dailyBudgetUsd,100);
 assert.throws(()=>callerSheetUrl('https://evil.example/spreadsheets/d/test/edit#gid=1'));
 assert.throws(()=>callerSheetUrl('https://docs.google.com/spreadsheets/d/test/edit'));
 assert.throws(()=>normalizeCallerConfig({timezone:'invalid'}));
 assert.throws(()=>normalizeCallerConfig({concurrency:51}));
 assert.throws(()=>normalizeCallerConfig({rowStart:10,rowEnd:2}));
});
test('preview retains sheet row identities, resolves headers, flags history and duplicates',()=>{
 const config=normalizeCallerConfig({sourceUrl:url,rowStart:3,rowEnd:9,eventDefaults:{event_city:'Rome'}});
 const row=(rowNumber,extra)=>({rowNumber,row:{'Record ID':String(rowNumber),'First Name':'Test','First Phone':'+44 1234 567890','VAPI Status':'',...extra}});
 const preview=callerPreview([row(2,{}),row(3,{}),row(5,{}),row(7,{'First Phone':'+441234567891','call_attempt':'1'}),row(9,{'First Phone':'invalid'})],config);
 assert.deepEqual(preview.rows.map(r=>r.rowNumber),[3,5,7,9]);assert.equal(preview.ready,1);assert.equal(preview.needsReview,3);
 assert.equal(preview.rows[0].phone,'+441234567890');assert.equal(preview.rows[0].event_city,'Rome');
 assert.match(preview.rows[1].reviewReason,/Duplicate/);assert.match(preview.rows[2].reviewReason,/history/);
 assert.deepEqual(preview.missing,[]);
});
test('explicit mapping overrides aliases and values remain plain text',()=>{
 const config=normalizeCallerConfig({sourceUrl:url,mapping:{phone:'Mobile'}});
 const p=callerPreview([{rowNumber:2,row:{'Record ID':'1','First Name':'<script>','Mobile':'+441234567890','First Phone':'wrong','Transcript':'quoted\ntext'}}],config);
 assert.equal(p.ready,1);assert.equal(p.rows[0].name,'<script>');assert.equal(p.rows[0].transcript,'quoted\ntext');
});
