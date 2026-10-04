import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {isDeletedCampaign} from '../public/js/campaign-board-deletions.mjs';
const dir=mkdtempSync(join(tmpdir(),'ortus-deletions-'));process.env.ORTUS_DATA_DIR=dir;
const store=await import('../src/campaign-board-deletions.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('deletion survives reading from disk and hides saved campaign and all grouped runs',()=>{
 store.deleteCampaignFromBoard({owner:'mine',campaignId:'c',runIds:['old','new'],legacyName:'test'});
 const entries=store.getCampaignDeletions();
 for(const item of [{id:'saved-c',campaignId:'c',mine:true},{id:'old',mine:true},{id:'other-old',name:'Test',mine:true}])assert.equal(isDeletedCampaign(item,entries),true);
 assert.equal(isDeletedCampaign({id:'new-campaign',campaignId:'different',name:'Test',mine:true},entries),false);
 assert.equal(isDeletedCampaign({id:'old',owner:'someone-else'},entries),false);
});

test('deleting one run preserves other runs and the saved campaign',()=>{
 const entries=[{owner:'mine',campaignId:null,runIds:['old'],legacyName:''}];
 assert.equal(isDeletedCampaign({id:'old',campaignId:'c',mine:true},entries),true);
 assert.equal(isDeletedCampaign({id:'new',campaignId:'c',mine:true},entries),false);
 assert.equal(isDeletedCampaign({id:'saved-c',campaignId:'c',mine:true},entries),false);
});
