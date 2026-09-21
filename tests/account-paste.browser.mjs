import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../public/', import.meta.url);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'qa.test') return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = new URL(path, root);
    if (!file.href.startsWith(root.href) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    return route.fulfill({ contentType: /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
  });
  await page.goto('http://qa.test/#/new');
  await page.waitForFunction(() => typeof window.openAccountPaste === 'function');
  assert.equal(await page.locator('.browse-bulk-row button').filter({ hasText: 'Paste account list' }).count(), 1);
  await page.evaluate(() => window.openAccountPaste());
  assert.equal(await page.locator('#account-paste-dialog[open]').count(), 1);
  const dialogBox = await page.locator('#account-paste-dialog').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(dialogBox && viewport);
  assert.ok(Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2) < 2, 'dialog is horizontally centered');
  assert.ok(Math.abs(dialogBox.y + dialogBox.height / 2 - viewport.height / 2) < 2, 'dialog is vertically centered');
  await page.fill('#account-paste-input', 'unknown@example.com\nsecond@example.com');
  await page.evaluate(() => window.previewAccountPaste());
  assert.match(await page.locator('#account-paste-results').innerText(), /2 need attention/);
  assert.equal(await page.locator('#account-paste-apply').isDisabled(), true);
} finally { await browser.close(); }
