const root=require('node:path').resolve(__dirname,'..');
const express=require(root+'/node_modules/express');
const {chromium}=require(root+'/node_modules/playwright');
const fs=require('fs');const assert=require('node:assert/strict');
(async()=>{
 const app=express();app.use(express.static(root+'/public'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({...(process.env.TEST_CHROME_PATH ? {executablePath:process.env.TEST_CHROME_PATH} : {}),headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('ortusTourCompleted','1'));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let data={ok:true};
  if(/\/(history|drafts|queue|schedules|profiles)$/.test(path))data=[];
  if(path==='/api/operator-identity')data={email:'test@ortusclub.com',ok:true};
  if(path==='/api/operator-prefs')data={prefs:{tz:'Europe/Rome'}};
  if(path==='/api/me')data={user:'test@ortusclub.com',email:'test@ortusclub.com',isAdmin:false};
  if(path==='/api/campaign-configs')data={ok:true,campaigns:[],configs:[]};
  if(/campaign\/status/.test(path))data={running:false,state:'idle',logs:[],profileNames:[],totalLeads:0};
  if(/cloud|scrape/.test(path))data={campaigns:[],jobs:[],enabled:true,configured:true};
  if(/soo/.test(path))data={accounts:[],profiles:[],ok:true};
  if(path==='/api/engine-target')data={ok:true,engine:'dev',active:'development',canDev:true,lockedByEnv:false,activeUrl:'https://dev-scraper.ortusclub.com'};
  if(path==='/api/health')data={version:'3.1.67',scraperConfigured:true,scraperEngineEnvironment:'development'};
  await route.fulfill({json:data});
 });
 await page.route('**/js/app.js*',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(root+'/public/js/app.js','utf8')+`\nwindow.__ortusTest={
 setView(id,name,status){_openedCampaignId=id;_openedCampaignName=name;document.getElementById('campaign-name-input').value=name;document.getElementById('campaign-mode').value='connect_only';_viewingCloudId=null;_viewingLocalCampaign=id?{id,campaignId:id,name,status}:null;liveStatusForcedOpen=true;Object.assign(__cockpit,status);renderActiveCard(status);syncLiveStatusVisibility();},
 sync:syncLiveStatusVisibility,scope:localCampaignViewStatus,save:saveWizardState,restore:restoreWizardState,key:_wizScopedKey,cap:_capDetailHtml,
 roster:renderProfiles,collect:collectCurrentConfig,apply:applyPresetConfig,cloud:isCloudRunOn,preview:showPreLaunchPreview,load:loadCampaignConfigByName};` }));
 try {
  await page.goto('http://127.0.0.1:'+server.address().port+'/#/dashboard');
  await page.waitForFunction(()=>!!window.__ortusTest);await page.waitForTimeout(1800);
  assert.equal(await page.locator('#nav-status').isVisible(),false);
  assert.equal(await page.locator('#active-card').isVisible(),false);
  await page.evaluate(()=>{location.hash='#/new'});await page.waitForTimeout(100);
  await page.evaluate(()=>window.__ortusTest.setView(null,'',{name:'',state:'idle',running:false,logs:[]}));
  assert.equal(await page.locator('#nav-status').isVisible(),false);
  await page.evaluate(()=>window.__ortusTest.setView('a','Campaign A',{campaignId:'a',name:'Campaign A',state:'done',hasRun:true,running:false,logs:['A completed'],totalLeads:12,totalProcessed:4}));
  assert.equal(await page.locator('#nav-status').isVisible(),true);
  assert.equal(await page.locator('#live-console').count(),0);
  await page.evaluate(()=>{window.__confirmResult=null;window.appConfirm('Test deletion confirmation',{okLabel:'Delete'}).then(value=>window.__confirmResult=value);});
  await page.locator('.ac-ok').click({timeout:5000});
  assert.equal(await page.evaluate(()=>window.__confirmResult),true);
  const isolation=await page.evaluate(()=>{
   const t=window.__ortusTest;
   const before=t.scope({campaignId:'b',name:'Campaign B',running:true,logs:['B private log']});
   document.getElementById('sheet-url').value='https://docs.google.com/spreadsheets/d/a/edit';t.save();
   const ka=t.key('template');
   t.setView('b','Campaign B',{campaignId:'b',name:'Campaign B',state:'done',hasRun:true,running:false,logs:['B completed']});
   document.getElementById('sheet-url').value='';
   return {name:before.name,log:before.logs[0],differentKey:ka!==t.key('template'),restored:t.restore(),sheet:document.getElementById('sheet-url').value,
    retry:t.cap('c',{profileId:'p',needsLogin:true},{status:'Logged out',blocked:true}).includes('Retry account — check login')};
  });
  assert.deepEqual(isolation,{name:'Campaign A',log:'A completed',differentKey:true,restored:false,sheet:'',retry:true});
  const targetRoundTrip = await page.evaluate(() => {
    const t=window.__ortusTest;
    window.setRunTarget('cloud');
    const saved=t.collect();
    window.setRunTarget('local');
    t.apply(saved);
    const restored={saved:saved.runTarget,target:window.getRunTarget(),dispatch:t.cloud()};
    t.apply({...saved,runTarget:'local'});
    return {...restored,otherCampaignTarget:window.getRunTarget(),otherDispatch:t.cloud()};
  });
  assert.deepEqual(targetRoundTrip,{saved:'cloud',target:'cloud',dispatch:true,otherCampaignTarget:'local',otherDispatch:false});
  const preservedRoster=await page.evaluate(()=>{
    const t=window.__ortusTest;
    t.apply({...t.collect(),profileIds:['saved-account']});
    t.roster([{id:'saved-account',name:'Saved sender',available:false}]);
    return t.collect().profileIds;
  });
  assert.deepEqual(preservedRoster,['saved-account']);

  await page.locator('#nav-status').scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/ortus-campaign-status.png',fullPage:false});
  await page.evaluate(()=>{location.hash='#/dashboard'});await page.waitForTimeout(100);await page.evaluate(()=>window.__ortusTest.sync());
  assert.equal(await page.locator('#nav-status').isVisible(),false);assert.equal(await page.locator('#active-card').isVisible(),false);
  await page.screenshot({path:'/tmp/ortus-dashboard.png',fullPage:false});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,isolation,targetRoundTrip,rendererErrors:errors}));
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
