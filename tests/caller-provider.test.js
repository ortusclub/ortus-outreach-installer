import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'caller-provider-test-'));process.env.ORTUS_DATA_DIR=dir;
const {saveCallerProvider,callerProviderStatus,listCallerProviderOptions}=await import('../src/caller-provider.js');
test('Vapi credentials stay private and company-scoped; option reads expose only IDs and labels',async()=>{
 try{
  await assert.rejects(listCallerProviderOptions('sam@ortusclub.com'),{status:409});
  assert.deepEqual(saveCallerProvider('sam@ortusclub.com',{vapiToken:'test-fake-private-key'}),{vapiConfigured:true});
  assert.equal(statSync(join(dir,'caller-provider-credentials.json')).mode&0o777,0o600);
  assert.deepEqual(callerProviderStatus('info@linkedvelocity.com'),{vapiConfigured:false});
  await assert.rejects(listCallerProviderOptions('info@linkedvelocity.com'),{status:409});
  const options=await listCallerProviderOptions('sam@ortusclub.com',async(url,opts)=>{
   assert.equal(opts.headers.Authorization,'Bearer test-fake-private-key');assert.equal(opts.redirect,'error');
   return {ok:true,json:async()=>url.includes('/assistant')?[{id:'assistant1',name:'Assistant',credential:'private'}]:[{id:'number1',number:'+441234567890',credential:'private'}]};
  });
  assert.deepEqual(options,{assistants:[{id:'assistant1',name:'Assistant'}],numbers:[{id:'number1',name:'+441234567890'}]});
  saveCallerProvider('sam@ortusclub.com',{vapiToken:''});assert.deepEqual(callerProviderStatus('sam@ortusclub.com'),{vapiConfigured:false});
  assert.throws(()=>saveCallerProvider('a@invalid.example',{vapiToken:'key'}),{status:403});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
