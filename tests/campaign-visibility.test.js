import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewCampaign, visibleCampaigns } from '../src/campaign-visibility.js';
test('ordinary operators see only their own campaigns, including after an identity change', () => {
  const rows=[{id:'own',owner:'SAM@ortusclub.com'},{id:'other',owner:'other@ortusclub.com'},{id:'unknown'}, {id:'device',operatorId:'device-1'}];
  const viewer={email:'sam@ortusclub.com',operatorId:'device-1'};
  assert.deepEqual(visibleCampaigns(rows,viewer).map(x=>x.id),['own','device']);
  assert.deepEqual(visibleCampaigns(rows,{email:'other@ortusclub.com'}).map(x=>x.id),['other']);
  assert.equal(canViewCampaign({owner:'other@ortusclub.com',operatorId:'device-1'},viewer),false);
  assert.equal(canViewCampaign({},{}),false);
  assert.equal(visibleCampaigns(rows,{admin:true}).length,4);
});
test('maturing is shared by creator company, including for admins', () => {
  const mature = owner => ({owner, name:'target@unrelated.example', config:{matureWarm:true}});
  const rows = [mature('sam@ortusclub.com'),mature('OTHER@ORTUSCLUB.COM'),mature('staff@linkedvelocity.com'),mature('outsider@example.com'),mature(''),mature('fake@ortusclub.com.evil')];
  for (const admin of [false,true]) {
    assert.deepEqual(visibleCampaigns(rows,{email:'sam@ortusclub.com',admin}), rows.slice(0,2));
    assert.deepEqual(visibleCampaigns(rows,{email:'person@linkedvelocity.com',admin}), [rows[2]]);
    assert.deepEqual(visibleCampaigns(rows,{email:'',admin}), []);
  }
  assert.equal(canViewCampaign(mature('outsider@example.com'),{email:'other@example.com'}),false);
  assert.equal(canViewCampaign(mature('outsider@example.com'),{email:'outsider@example.com'}),true);
});
test('saved maturing plans and board rows follow the same company rule', () => {
  for(const flag of [{mode:'mature_profile'},{maturing:true},{config:{matureWarm:true,matureKind:'cold'}}]) {
    assert(canViewCampaign({...flag,owner:'other@ortusclub.com'},{email:'sam@ortusclub.com'}));
    assert(!canViewCampaign({...flag,owner:'other@linkedvelocity.com'},{email:'sam@ortusclub.com',admin:true}));
  }
});
