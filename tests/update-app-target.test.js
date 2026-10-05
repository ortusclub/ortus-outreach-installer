import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAppTarget } from '../src/update-app-target.js';
const product='The Ortus Outreach';
const installed=`/Applications/${product}.app`;
const disk={exists:()=>true,read:()=>JSON.stringify({name:'ortus-outreach',productName:product})};
test('packaged update keeps the installed app path',()=>assert.equal(updateAppTarget(`${installed}/Contents/MacOS/${product}`,product),installed));
test('source Electron updates the actual installed product, never Electron',()=>assert.equal(updateAppTarget('/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',product,disk),installed));
test('mounted DMG updates the installed product, not the read-only volume',()=>assert.equal(updateAppTarget(`/Volumes/Update/${product}.app/Contents/MacOS/${product}`,product,disk),installed));
test('missing or unrelated installed applications are not replaced',()=>{
 assert.equal(updateAppTarget('/dev/Electron.app/Contents/MacOS/Electron',product,{exists:()=>false}),null);
 assert.equal(updateAppTarget('/dev/Electron.app/Contents/MacOS/Electron',product,{exists:()=>true,read:()=>'{"name":"other"}'}),null);
});
