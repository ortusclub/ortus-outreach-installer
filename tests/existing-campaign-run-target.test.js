import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
const start=source.indexOf('window.launchStartNow = async function() {');const end=source.indexOf('\n};',start)+3;
async function launch(target,capable=true){const calls=[];const ctx=vm.createContext({window:{location:{}},_readOnlyBlocksLaunch:()=>false,_editingCampaignId:'saved-campaign',getRunTarget:()=>target,isCloudRunOn:()=>capable,_closeLaunchMenu(){},_boardItemsById:new Map([['saved-campaign',{bucket:'saved'}]]),_snItemsById:new Map(),restartLocalFromItem:async()=>{calls.push('local');return true;},startCampaign:async()=>calls.push('normal-launch'),flushAutosaveImmediate:async()=>{},showCampaignToast:()=>calls.push('error'),console});vm.runInContext(source.slice(start,end),ctx);await ctx.window.launchStartNow();return calls;}
test('existing campaign with Cloud VM selected never uses the local restart shortcut',async()=>assert.deepEqual(await launch('cloud'),['normal-launch']));
test('existing campaign on This machine keeps its local resume path',async()=>assert.deepEqual(await launch('local'),['local']));
test('unsupported cloud mode is rejected rather than silently running locally',async()=>assert.deepEqual(await launch('cloud',false),['error']));
