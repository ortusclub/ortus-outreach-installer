import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
const a=app.indexOf("let _openedCampaignName = '';");
const b=app.indexOf("\nif (typeof window !== 'undefined')",a);
test('latest campaign selection wins even when saved configurations arrive out of order',async()=>{
 let name='',applied;const requests=new Map();
 const context=vm.createContext({wizardDirty:false,document:{getElementById:()=>({get value(){return name},set value(v){name=v}})},_currentWizardName:()=>name,bindWizardTo(){},applyPresetConfig:c=>applied=c,
  fetch:url=>new Promise(resolve=>requests.set(url,resolve))});
 vm.runInContext(app.slice(a,b)+';this.load=loadCampaignConfigByName;',context);
 const first=context.load('A','a'),second=context.load('B','b');
 requests.get('/api/campaign-configs/by-id/a')({ok:true,json:async()=>({ok:true,name:'A',campaignId:'a',config:{campaignId:'a',sheetUrl:'sheet-a'}})});
 assert.equal(await first,false);
 requests.get('/api/campaign-configs/by-id/b')({ok:true,json:async()=>({ok:true,name:'B',campaignId:'b',config:{campaignId:'b',sheetUrl:'sheet-b'}})});
 assert.equal(await second,true);assert.equal(name,'B');assert.equal(applied.sheetUrl,'sheet-b');
});
