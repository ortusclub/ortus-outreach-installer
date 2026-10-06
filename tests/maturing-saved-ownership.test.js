import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'maturing-ownership-'));
const { saveNamedCampaign, listConfigs, getConfigById } = await import('../src/campaign-configs.js');
const { addDraft, updateDraft, getDrafts, trashAllDrafts } = await import('../src/drafts.js');
const { canAccessSavedCampaign } = await import('../src/campaign-visibility.js');
const ortus = {admin:true,email:'sam@ortusclub.com'};
const lv = {email:'staff@linkedvelocity.com'};
test('creator persists across saves and cannot be changed by config data or another saver', () => {
  const first=saveNamedCampaign('saved',{mode:'mature_profile',owner:'fake@ortusclub.com'},undefined,'info@linkedvelocity.com');
  const edited=saveNamedCampaign('saved',{mode:'mature_profile'},first.campaignId,'sam@ortusclub.com');
  assert.equal(edited.owner,'info@linkedvelocity.com');
  const row=listConfigs().find(x=>x.campaignId===first.campaignId);
  assert.equal(canAccessSavedCampaign(row,ortus),false);
  assert.equal(canAccessSavedCampaign(row,lv),true);
});
test('draft creator carries into saved registry and bulk trash excludes other companies', async () => {
  const a=await addDraft({name:'LV draft',owner:'info@linkedvelocity.com',config:{mode:'mature_profile'}});
  const b=await addDraft({name:'Ortus draft',owner:'sam@ortusclub.com',config:{mode:'mature_profile'}});
  await updateDraft(a.id,{owner:'sam@ortusclub.com',config:{mode:'mature_profile'}});
  assert.equal(getConfigById(a.campaignId).owner,'info@linkedvelocity.com');
  assert.equal((await getDrafts()).find(d=>d.id===a.id).owner,'info@linkedvelocity.com');
  assert.equal(await trashAllDrafts(d=>canAccessSavedCampaign(d,ortus)),1);
  assert.ok((await getDrafts()).some(d=>d.id===a.id));
  assert.ok(!(await getDrafts()).some(d=>d.id===b.id));
});
test('unowned maturing records fail closed while regular local campaigns retain access', () => {
  assert.equal(canAccessSavedCampaign({config:{mode:'mature_profile'}},ortus),false);
  assert.equal(canAccessSavedCampaign({config:{mode:'connections'}},lv),true);
});
