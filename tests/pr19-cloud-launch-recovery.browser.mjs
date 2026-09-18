import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../public/', import.meta.url);
const launchId = 'test-cloud-1234';
const draftId = 'test-draft-1234';
let engineAccepted = false;
let draftDeleted = false;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(({ launchId, draftId }) => {
    localStorage.setItem('ortus.activeDraftId', draftId);
    localStorage.setItem('ortus.pr19.cloudLaunchPending.v1', JSON.stringify({
      launchId, draftId, name: 'Saved VM draft', mode: 'connect_and_message',
      profileIds: ['sender-1'], startedAt: Date.now() - 30000,
      phase: 'dispatching', logs: ['Reading saved lead sheet · 10:24'],
    }));
  }, { launchId, draftId });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'qa.test') return route.abort();
    if (url.pathname === `/api/campaign/cloud/${launchId}`) {
      return route.fulfill({ status: engineAccepted ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(engineAccepted ? { campaign: { id: launchId, status: 'queued', name: 'Saved VM draft' } } : { error: 'Not found' }) });
    }
    if (url.pathname === `/api/drafts/${draftId}` && route.request().method() === 'DELETE') {
      draftDeleted = true;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === '/api/drafts') return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ drafts: draftDeleted ? [] : [{ id: draftId, name: 'Saved VM draft', createdAt: Date.now() }] }) });
    if (url.pathname === '/api/campaign/cloud-board-summary') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ campaigns: [] }) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = new URL(path, root);
    if (!file.href.startsWith(root.href) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    return route.fulfill({ contentType: /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('http://qa.test/#/');
  await page.waitForFunction(() => document.querySelector('.sn-strip.launching .sn-launch-evidence'));
  assert.match(await page.locator('.sn-strip.launching .sn-launch-evidence').innerText(), /Reading saved lead sheet/);
  assert.match(await page.locator('.sn-strip.launching').innerText(), /Checking VM receipt/);
  assert.equal(await page.locator('.sn-strip.draft').count(), 0, 'active launch hides its duplicate draft');
  assert.equal(draftDeleted, false, 'draft remains safe until the engine confirms');
  engineAccepted = true;
  await page.waitForFunction(() => !localStorage.getItem('ortus.pr19.cloudLaunchPending.v1'), { timeout: 12000 });
  assert.equal(draftDeleted, true, 'the exact saved draft is consumed after engine receipt');
  assert.equal(await page.evaluate(() => localStorage.getItem('ortus.activeDraftId')), null);
} finally {
  await browser.close();
}
