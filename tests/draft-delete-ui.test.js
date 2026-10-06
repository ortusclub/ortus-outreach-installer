import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url),'utf8');
function setup({confirm=true,response={ok:true,status:200,json:async()=>({ok:true})}}={}) {
  const state={removed:0,cleared:0,requests:0,toasts:[]};
  const context={Set,encodeURIComponent,clearTimeout,appConfirm:async()=>confirm,
    fetch:async()=>{state.requests++;return response;},getActiveDraftId:()=> 'unnamed',clearActiveDraft:()=>state.cleared++,
    _autosaveTimer:null,document:{querySelectorAll:()=>[{dataset:{cid:'draft:unnamed'},remove:()=>state.removed++}]},
    refreshDashboardDrafts:async()=>{},renderCampaignsBoard:async()=>{},showCampaignToast:text=>state.toasts.push(text)};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const deletedDraftIds ='),source.indexOf('window.deleteDraftStrip =')),context);
  return {context,state};
}
test('unnamed drafts delete by ID and detach autosave after server success',async()=>{
  const {context,state}=setup();await context.deleteDraftStrip('unnamed');
  assert.equal(state.requests,1);assert.equal(state.removed,1);assert.equal(state.cleared,1);
  assert.equal(vm.runInContext('deletedDraftIds.has("unnamed")',context),true);
});
test('failed delete leaves draft and autosave intact and shows failure',async()=>{
  const {context,state}=setup({response:{ok:false,status:500,json:async()=>({error:'Disk unavailable'})}});
  await context.deleteDraftStrip('unnamed');assert.equal(state.removed,0);assert.equal(state.cleared,0);assert.match(state.toasts[0],/Disk unavailable/);
});
test('cancel does not send delete request',async()=>{
  const {context,state}=setup({confirm:false});await context.deleteDraftStrip('unnamed');assert.equal(state.requests,0);
});
