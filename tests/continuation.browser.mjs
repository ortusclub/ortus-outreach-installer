// Exercise actual dialog/decision functions in Chrome; every request is
// intercepted, with no app server, account, sheet or LinkedIn access.
import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const confirm = source.slice(source.indexOf('function appConfirm('), source.indexOf('window.appConfirm ='));
const decision = source.slice(source.indexOf('window.openCampaignResumeDecision = async function'), source.indexOf('// Which campaign is this card actually showing?'));
const resume = source.slice(source.indexOf('async function confirmResume()'), source.indexOf("document.getElementById('resume-keep-editing')"));
const fixture = `import {continuationPolicy,requestConfirmedResume} from '/js/continuation-policy.mjs';
const _resumeDecisionInFlight=new Set();
const escHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
window.checks=0; window.toasts=[]; window.finished=false;
const showCampaignToast=s=>{window.toasts.push(s);document.querySelector('#notice').textContent=s;};
const _resumeAcceptanceCheckNow=async()=>{window.checks++;return true;};
const pollStatus=async()=>{};
${confirm}\n${resume}\n${decision}
document.querySelector('#resume').onclick=async()=>{window.finished=false;window.result=await window.openCampaignResumeDecision('local-active','sending','local',document.querySelector('#resume'));window.finished=true;};`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let mode = 'connect_and_message', confirmations = 0;
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/campaign/status') return route.fulfill({ json: { running: true, paused: true, state: 'running', mode } });
    if (path === '/api/campaign/resume/preview') return route.fulfill({ status: 409, json: { ok: false, error: 'Pause not confirmed' } });
    if (path === '/api/campaign/resume/confirm') { confirmations++; return route.fulfill({ json: { ok: true } }); }
    if (path === '/fixture.mjs') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (['/js/continuation-policy.mjs','/js/campaign-modes.mjs'].includes(path)) return route.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(new URL('../public' + path, import.meta.url), 'utf8') });
    if (path !== '/') return route.abort();
    return route.fulfill({ contentType: 'text/html', body: `<button id="resume">Resume</button><p id="notice"></p>
      <style>.modal-backdrop{position:fixed;inset:0;background:#ddd;padding:50px}.modal-card{background:white;padding:20px}button{padding:12px;margin:8px}</style>
      <script type="module" src="/fixture.mjs"></script>` });
  });
  await page.goto('http://continuation.test/');
  await page.click('#resume');
  await page.waitForSelector('[role=dialog]');
  assert.match(await page.locator('.modal-body').innerText(), /direct messages/);
  await page.locator('.ac-cancel').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.finished);
  assert.equal(await page.evaluate(() => window.checks), 1);
  assert.equal(confirmations, 0);
  assert.equal(await page.locator('[role=dialog]').count(), 0);

  await page.reload(); await page.click('#resume');
  await page.waitForSelector('[role=dialog]'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.finished);
  assert.equal(await page.evaluate(() => window.checks), 0);
  assert.equal(await page.locator('#resume').isEnabled(), true);

  mode = 'open_profile_only';
  await page.reload(); await page.click('#resume');
  await page.waitForSelector('[role=dialog]');
  assert.doesNotMatch(await page.locator('.modal-body').innerText(), /acceptance check/i);
  await page.click('.ac-ok'); await page.waitForFunction(() => window.finished);
  assert.match(await page.locator('#notice').innerText(), /Resume review unavailable/);
  assert.equal(confirmations, 0, 'failed preview must not start sending');
  assert.equal(await page.locator('#resume').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: Enter follows focused choice; Escape does nothing; unsupported monitoring absent; failed preview blocks Resume and leaves button usable.');
} finally { await browser.close(); }
