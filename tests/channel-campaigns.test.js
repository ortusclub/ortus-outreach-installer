import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'channel-drafts-'));process.env.ORTUS_DATA_DIR=dir;
const {saveChannelCampaign,listChannelCampaigns,deleteChannelCampaign}=await import('../src/channel-campaigns.js');
const user={email:'mara@ortusclub.com',admin:false};
const other={email:'info@linkedvelocity.com',admin:true};
const admin={email:'sam@ortusclub.com',admin:true};
const input={type:'sms',name:'A draft',sender:'',recipients:'+441234567890\n+441234567890',content:'Hello',templateName:'',language:''};
test('channel drafts validate recipients, persist edits and enforce company ownership',()=>{
 try {
  for(const type of ['automated_dialer','sms','automated_whatsapp']){
   const draft=saveChannelCampaign({...input,type,owner:other.email,status:'running'},user);
   assert.equal(draft.owner,user.email);assert.equal(draft.status,'draft');assert.equal(draft.recipients,'+441234567890');
   assert(listChannelCampaigns(admin).some(c=>c.id===draft.id));
   assert.equal(listChannelCampaigns(other).length,0);
   assert.throws(()=>saveChannelCampaign({...input,id:draft.id,type},other),{status:404});
   assert.throws(()=>deleteChannelCampaign(draft.id,other),{status:404});
   assert.equal(saveChannelCampaign({...input,id:draft.id,type,name:'Edited'},user).name,'Edited');
   deleteChannelCampaign(draft.id,admin);
  }
  assert.equal(listChannelCampaigns(user).length,0);
  assert.throws(()=>saveChannelCampaign({...input,recipients:'not-a-number'},user),/country code/);
  assert.throws(()=>saveChannelCampaign({...input,type:'connect_only'},user),/supported/);
  assert.throws(()=>saveChannelCampaign({...input,name:''},user),/name/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
