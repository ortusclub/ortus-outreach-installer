// Run explicitly with the installed Chrome; every request is intercepted.
import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/health') return route.fulfill({ json: {
      scraperEngineVersion: 'preview-pr-19-dfd2d4e7e099', scraperEngineUrl: 'http://127.0.0.1:3119',
    } });
    if (path === '/review.mjs') return route.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(new URL('../public/js/launch-review.mjs', import.meta.url), 'utf8') });
    return route.fulfill({ contentType: 'text/html', body: `<button id="launch">Launch</button>
      <script type="module">import {reviewLaunch} from '/review.mjs';
      document.querySelector('button').onclick=async()=>{window.result=await reviewLaunch({
        name:'Test',mode:'connect_only',runTarget:'local',sheetUrl:'test-sheet',profileIds:['B']
      },{accountName:id=>id});};</script>` });
  });
  await page.goto('http://review.test/');
  await page.click('#launch');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog').innerText(), /preview-pr-19-dfd2d4e7e099/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === false);
  await page.click('#launch');
  await page.click('.launch-review-confirm');
  await page.waitForFunction(() => window.result === true);
  assert.equal(await page.locator('dialog').count(), 0);
  console.log('PASS: engine shown; Escape cancels; confirmation resolves; dialog cleaned up.');
} finally { await browser.close(); }
