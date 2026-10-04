import test from 'node:test';
import assert from 'node:assert/strict';
import { findActiveCampaign, withCampaignLaunch } from '../src/cloud-campaign-identity.js';
test('active runs match permanent identity and legacy name, scoped to their owner', async () => {
 const runs=[{id:'r',name:'Old name',owner:'sam',status:'running',config:{campaignId:'saved'}}];
 assert.equal((await findActiveCampaign(runs,{campaignId:'saved',name:'Renamed'},'sam',async()=>null)).id,'r');
 assert.equal(await findActiveCampaign(runs,{campaignId:'saved',name:'Renamed'},'other',async()=>null),null);
 assert.equal((await findActiveCampaign([{...runs[0],name:' Test ',config:{}}],{campaignId:'saved',name:'test'},'sam',async()=>null)).id,'r');
 assert.equal(await findActiveCampaign([{...runs[0],status:'cancelled'}],{campaignId:'saved',name:'Old name'},'sam',async()=>null),null);
});
test('simultaneous starts cannot both pass the active-run check',async()=>{
 let active=false,started=0;
 const launch=()=>withCampaignLaunch('saved',async()=>{if(active)return false;await new Promise(r=>setTimeout(r,5));active=true;started++;return true;});
 assert.deepEqual(await Promise.all([launch(),launch()]),[true,false]);assert.equal(started,1);
});
