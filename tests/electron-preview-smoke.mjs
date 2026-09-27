// Manual test against the isolated Electron preview; no real credentials are read or changed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0];
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const fixture={ok:true,credentials:[{id:'ortus',label:'Test workspace',env:'GOLOGIN_API_TOKEN',set:false}],others:[]};
let scenario='success';
await page.route('**/api/credentials',route=>route.fulfill({json:route.request().method()==='POST'?{...fixture,changedAccounts:['ortus']}:fixture}));
await page.route('**/api/credentials/check',route=>route.fulfill({json:{checks:[scenario==='rejected'?{id:'ortus',label:'Test workspace',ok:false,error:'GoLogin rejected this token (401).'}:{id:'ortus',label:'Test workspace',ok:true,profileCount:2}]}}));
await page.route('**/api/profiles',route=>route.fulfill(scenario==='roster-failed'?{status:503,json:{error:'Test account-list timeout'}}:{json:[{id:'synthetic-1',name:'Synthetic One',account:'ortus',available:true},{id:'synthetic-2',name:'Synthetic Two',account:'ortus',available:true}]}));
try {
  await page.reload();
  await page.waitForFunction(()=>typeof window.openCredentialsModal==='function');
  for(scenario of ['success','rejected','roster-failed']) {
    await page.evaluate(()=>window.openCredentialsModal());
    await page.locator('#cred-ortus').waitFor();
    await page.locator('#cred-ortus').fill('synthetic-token-for-mocked-test');
    await page.locator('#cred-save').click();
    await page.waitForFunction(()=>document.querySelector('#cred-save')?.disabled===false);
    const result=await page.locator('#cred-msg').textContent();
    assert.match(result,scenario==='success'?/Done\./:scenario==='rejected'?/rejected.*401/:/verified.*did not finish/);
    console.log(JSON.stringify({scenario,passed:true,saveButtonEnabled:await page.locator('#cred-save').isEnabled()}));
  }
  assert.deepEqual(errors,[]);console.log('No renderer errors');
} finally {
  await page.unrouteAll({behavior:'wait'});
  await page.reload();
  await browser.close();
}
