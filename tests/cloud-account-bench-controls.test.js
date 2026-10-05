import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { acctRowState } from '../public/js/vjcard.mjs';
const source=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
test('account drawer switches between Bench and Unbench without removing the account',()=>{
 const start=source.indexOf('function _capDetailHtml(');
 const ctx=vm.createContext({escHtml:String,_acctBatchTip:()=>'',dailyResetText:()=>''});
 vm.runInContext(source.slice(start,source.indexOf('function renderCloudAccountsPanel(',start)),ctx);
 for(const benched of [false,true]){
  const a={profileId:'account',manuallyBenched:benched};
  const state=acctRowState(a);const html=ctx._capDetailHtml('campaign',a,state);
  assert.ok(html.includes(benched?'Unbench account':'Bench account'));
  assert.ok(html.includes(`benchCloudCampaignAccount('campaign','account',${!benched},this)`));
  assert.equal(html.includes('Remove from campaign'),false);
  if(benched)assert.match(state.status,/Benched for this campaign/);
 }
});
