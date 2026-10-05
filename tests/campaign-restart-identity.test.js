import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const identity = source.slice(source.indexOf('function openedWizardCampaign()'), source.indexOf('// Queue it — semantically'));
const nameGuard = source.slice(source.indexOf('async function _nameIsTaken(name)'), source.indexOf('/** Write the wizard'));
function fixture(name = 'Same campaign') {
  const calls = [];
  const context = vm.createContext({
    window: {}, _currentWizardName: () => name, _editingCampaignId: null,
    _viewingCloudId: 'cloud-run-id', _boardItemsById: new Map([['cloud-run-id', {id:'cloud-run-id', name:'Same campaign', where:'cloud'}]]),
    _snItemsById: new Map(), _openedCampaignId:null, _editingExistingCampaign:false,
    _openedCampaignName:'', _knownCampaignNames:['same campaign'], refreshKnownCampaignNames:async()=>{},
    _readOnlyBlocksLaunch:()=>false, getRunTarget:()=> 'cloud', _closeLaunchMenu:()=>{},
    restartCloudCampaignUI:async(...args)=>calls.push(args), isCloudRunOn:()=>true,
    flushAutosaveImmediate:async()=>{}, startCampaign:async()=>calls.push(['NEW']),
  });
  vm.runInContext(identity + '\n' + nameGuard, context);
  return { context, calls };
}
test('Start on the bound cloud campaign reuses its run and does not launch a new campaign', async()=>{
  const {context,calls}=fixture();
  assert.equal(await vm.runInContext("_nameIsTaken('Same campaign')",context),false);
  await context.window.launchStartNow();
  assert.deepEqual(calls,[['cloud-run-id',false]]);
});
test('a genuinely new wizard still rejects an existing name',async()=>{
  const {context}=fixture();context._viewingCloudId=null;
  assert.equal(await vm.runInContext("_nameIsTaken('Same campaign')",context),true);
});
test('changing the wizard name does not reuse the previously viewed cloud run',async()=>{
  const {context,calls}=fixture('Different campaign');
  await context.window.launchStartNow();assert.deepEqual(calls,[['NEW']]);
});
