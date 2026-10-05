import test from 'node:test';
import assert from 'node:assert/strict';
import { isLivePreviewUrl, previewWindowBounds } from '../electron/live-preview-window.mjs';
const origin='http://127.0.0.1:7848';
test('only local campaign and scrape preview URLs get native windows',()=>{
 assert.equal(isLivePreviewUrl(origin+'/live-preview.html?kind=campaign&id=abc',origin),true);
 assert.equal(isLivePreviewUrl(origin+'/live-preview.html?kind=scrape&id=abc',origin),true);
 for(const url of ['https://example.com/live-preview.html?kind=campaign&id=abc',origin+'/live-preview.html?kind=other&id=abc',origin+'/live-preview.html?kind=campaign',origin+'/']) assert.equal(isLivePreviewUrl(url,origin),false);
});
test('preview sits beside the app when space exists and stays onscreen otherwise',()=>{
 const work={x:0,y:25,width:2400,height:1100};
 assert.equal(previewWindowBounds({x:0,y:30,width:1400,height:900},work).x,1412);
 const b=previewWindowBounds({x:0,y:30,width:1400,height:900},{x:0,y:25,width:1440,height:900});
 assert.equal(b.x+b.width,1440);assert.ok(b.width<800);assert.ok(b.y>=25);
 const left=previewWindowBounds({x:-1400,y:50,width:1200,height:900},{x:-1440,y:25,width:1440,height:900});
 assert.ok(left.x>=-1440);assert.ok(left.x+left.width<=0);
});

test('eye restores a minimised preview without moving or resizing it', async()=>{
 const {restorePreviewWindow}=await import('../electron/live-preview-window.mjs');
 for(const minimized of [true,false]){
  const calls=[];
  restorePreviewWindow({isMinimized:()=>minimized,restore:()=>calls.push('restore'),show:()=>calls.push('show'),moveTop:()=>calls.push('raise'),focus:()=>calls.push('focus')});
  assert.deepEqual(calls,minimized?['restore','show','raise','focus']:['show','raise','focus']);
 }
});
