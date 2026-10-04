import test from 'node:test';import assert from 'node:assert/strict';
import {groupCampaignRuns} from '../public/js/campaign-board-identity.mjs';
test('one campaign card retains prior cloud runs, prefers active then newest',()=>{
 const base={mine:true,campaignId:'permanent',name:'Test',where:'cloud'};
 const out=groupCampaignRuns([{...base,id:'old',bucket:'done',createdAt:'2026-10-01'},{...base,id:'new',bucket:'done',createdAt:'2026-10-04'},{...base,id:'active',bucket:'running',createdAt:'2026-10-03'}]);
 assert.equal(out.length,1);assert.equal(out[0].id,'active');assert.deepEqual(out[0].previousRuns.map(r=>r.id),['new','old']);
});
test('legacy names are normalized; different owners and permanent IDs remain separate',()=>{
 const out=groupCampaignRuns([{id:'a',name:' Test ',owner:'one',bucket:'done'},{id:'b',name:'test',owner:'one',bucket:'done'},{id:'c',name:'test',owner:'two',bucket:'done'},{id:'d',name:'test',owner:'one',campaignId:'distinct',bucket:'done'}]);assert.equal(out.length,3);
});
test('multiple existing active runs remain accessible and counted',()=>{const [item]=groupCampaignRuns([{id:'a',name:'test',mine:true,bucket:'running'},{id:'b',name:'test',mine:true,bucket:'running'}]);assert.equal(item.activeRunCount,2);assert.equal(item.previousRuns.length,1);});
