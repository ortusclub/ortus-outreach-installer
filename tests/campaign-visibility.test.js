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
