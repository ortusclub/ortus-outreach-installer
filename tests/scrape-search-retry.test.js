import test from 'node:test';
import assert from 'node:assert/strict';
import { retrySearchPayload } from '../public/js/scrape-retry.mjs';
const job = {state:'error',searchUrl:'https://www.linkedin.com/sales/search/people?query=one',sheetUrl:'sheet',tabName:'Results 10',profileId:'account1',campaignName:'APHI_GUES_CHI',slowMode:true,accountPool:['account1','account2'],pages:90,profiles:2190};
test('retry dispatches only the failed URL to its original tab and preserves options',()=>{
 const p=retrySearchPayload(job);
 assert.deepEqual(p.searchUrls,[job.searchUrl]);
 assert.equal(p.sheetUrl,job.sheetUrl);assert.equal(p.tabName,'Results 10');
 assert.equal(p.campaignName,'APHI_GUES_CHI');assert.equal(p.slowMode,true);
 assert.deepEqual(p.accountPool,job.accountPool);assert.equal(p.profileId,'account1');
 assert.equal(p.pages,undefined);assert.equal(job.state,'error');
});
test('cannot retry active or finished jobs or jobs missing their original destination',()=>{
 for(const state of ['running','queued','done','rerouted'])assert.throws(()=>retrySearchPayload({...job,state}));
 for(const field of ['searchUrl','sheetUrl','profileId'])assert.throws(()=>retrySearchPayload({...job,[field]:''}));
});

import { findSearchRetry } from '../public/js/scrape-retry.mjs';
test('original failed row finds current retry after reload, scoped to its sheet and search',()=>{
 const original={...job,createdAt:100};
 const newer={...job,id:'retry',state:'running',createdAt:200,profiles:249};
 const campaign={id:'rerun',name:'APHI_GUES_CHI',sheetUrl:'sheet',jobs:[newer]};
 assert.equal(findSearchRetry(original,[campaign],'sheet').job.profiles,249);
 assert.equal(findSearchRetry(original,[{...campaign,sheetUrl:'other'}],'sheet'),null);
 assert.equal(findSearchRetry(original,[{...campaign,jobs:[{...newer,tabName:'Results 7'}]}],'sheet'),null);
 assert.equal(findSearchRetry(original,[{...campaign,jobs:[{...newer,createdAt:50}]}],'sheet'),null);
});

import {latestSearchAttempts} from '../public/js/scrape-board.mjs';
test('same-campaign retry replaces the old attempt once without hiding other searches or launches',()=>{
 const failed={...job,id:'old',userId:'owner',runId:'run_original',createdAt:100};
 const retry={...failed,id:'retry',state:'running',createdAt:200};
 const other={...failed,id:'other',searchUrl:'other-url'};
 const separateRun={...failed,id:'other-run',runId:'run_other'};
 assert.deepEqual(latestSearchAttempts([retry,failed,other,separateRun]).map(j=>j.id),['retry','other','other-run']);
 assert.equal(retrySearchPayload(failed).runId,'run_original');
});
