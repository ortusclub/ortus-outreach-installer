import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { observeOpenInvitation } from '../src/invitation-observation.js';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/account-recovery.mjs') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(new URL('../public/js/account-recovery.mjs', import.meta.url), 'utf8') });
    return route.fulfill({ contentType: 'text/html', body: '<main><section><h1>Recipient</h1><button>Pending</button></section></main>' });
  });
  await page.goto('https://www.linkedin.com/in/recipient');
  await page.addStyleTag({ content: '* { margin: 0; padding: 0; box-sizing: border-box; } ' + fs.readFileSync(new URL('../public/css/account-recovery.css', import.meta.url), 'utf8') });
  assert.equal((await observeOpenInvitation({ browser: { pages: async () => [page] }, url: page.url() })).state, 'pending_observed');
  await page.evaluate(() => { document.querySelector('main button').remove(); document.body.insertAdjacentHTML('beforeend', '<aside><button>Pending</button></aside>'); });
  assert.equal((await observeOpenInvitation({ browser: { pages: async () => [page] }, url: page.url() })).state, 'unknown');
  await page.evaluate(async () => {
    window.module = await import('/account-recovery.mjs');
    window.calls = [];
    window.open = account => module.openRecoveryReview({ account,
      verify: async (id, url) => { calls.push(['verify', id, url]); return { message: 'Pending observed. Nothing sent.' }; },
      openLogin: async id => { calls.push(['login', id]); },
    });
    open({ profileId: 'exact-id', email: '<img src=x onerror=alert(1)>', verificationLeads: [{ name: 'Recipient', url: 'https://www.linkedin.com/in/recipient', detail: '429' }] });
  });
  const dialogPosition = await page.locator('dialog').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs(dialogPosition.x + dialogPosition.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(dialogPosition.y + dialogPosition.height / 2 - viewport.height / 2) < 2);
  // Exercise the real pill builder, not just the dialog in isolation.
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function _stageAcctPill(');
  const end = app.indexOf('\n}\n', start) + 2;
  await page.addScriptTag({ content: `
    const recoveryAction = module.recoveryAction;
    const _acctLabel = a => a.email;
    const acctPillCount = () => '0/2';
    const _fgCredits = () => null;
    const _benchWord = () => '';
    const escHtml = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    ${app.slice(start, end)}
    window.pillHtml = _stageAcctPill;
  ` });
  const pill = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = pillHtml({ profileId: 'exact-id', email: 'Sender', verificationLeads: [{ url: 'https://www.linkedin.com/in/recipient' }] }, false, null);
    return { actions: [...host.querySelectorAll('button')].map(b => b.textContent), nestedButtons: host.querySelectorAll('button button').length };
  });
  assert.equal(pill.nestedButtons, 0);
  assert.equal(pill.actions[1], 'Verify');
  const loginPill = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = pillHtml({ profileId: 'login-id', email: 'Sender', needsLogin: true }, false, null);
    return host.querySelectorAll('button').length;
  });
  assert.equal(loginPill, 1, 'login stays in the drawer, not beside the pill');
  assert.equal(await page.locator('dialog img').count(), 0);
  assert.deepEqual(await page.evaluate(() => calls), []);
  await page.getByRole('button', { name: 'Read invitation state' }).click();
  assert.deepEqual(await page.evaluate(() => calls), [['verify', 'exact-id', 'https://www.linkedin.com/in/recipient']]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await page.evaluate(() => open({ profileId: 'login-id', email: 'Sender', needsLogin: true }));
  await page.getByRole('button', { name: 'Open exact profile for login' }).click();
  assert.match(await page.locator('dialog').innerText(), /No campaign has been resumed/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.equal(await page.locator('dialog').count(), 0);
  assert.deepEqual(await page.evaluate(() => calls), [['verify', 'exact-id', 'https://www.linkedin.com/in/recipient'], ['login', 'login-id']]);
  await page.evaluate(() => {
    window.launchCount = 0;
    module.openRecoveryReview({ account: { profileId: 'slow-id', needsLogin: true },
      openLogin: () => { window.launchCount++; return new Promise((resolve, reject) => { window.finishLogin = resolve; window.failLogin = reject; }); } });
  });
  await page.getByRole('button', { name: 'Open exact profile for login' }).click();
  assert.equal(await page.getByRole('progressbar').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Opening profile…' }).isDisabled(), true);
  assert.match(await page.locator('dialog [role=status]').innerText(), /Please wait/);
  assert.equal(await page.evaluate(() => launchCount), 1);
  await page.evaluate(() => window.failLogin(new Error('Connection lost')));
  await page.waitForFunction(() => document.querySelector('dialog progress').hidden);
  assert.match(await page.locator('dialog [role=status]').innerText(), /Opening was not confirmed/);
  assert.equal(await page.getByRole('button', { name: 'Open exact profile for login' }).isEnabled(), true);
  await page.getByRole('button', { name: 'Open exact profile for login' }).click();
  await page.evaluate(() => window.finishLogin());
  await page.waitForFunction(() => document.querySelector('dialog progress').hidden);
  assert.match(await page.locator('dialog [role=status]').innerText(), /Browser opened/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const browserOpenStart = app.indexOf('const _openingProfileBrowsers = new Set();');
  const browserOpenEnd = app.indexOf('window.stopProfileBrowserOpening = stopProfileBrowserOpening;', browserOpenStart)
    + 'window.stopProfileBrowserOpening = stopProfileBrowserOpening;'.length;
  await page.addScriptTag({ content: `
    const showCampaignToast = line => window.profileToasts.push(line);
    window.profileToasts = []; window.profileRequests = 0;
    window.fetch = () => { window.profileRequests++; return new Promise(resolve => { window.finishProfileOpen = () => resolve({ ok: true, json: async () => ({ action: 'launched' }) }); }); };
    ${app.slice(browserOpenStart, browserOpenEnd)}
    window.openProfileBrowser = openProfileBrowser;
  ` });
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button data-open-profile-id="exact-id" onclick="openProfileBrowser(\'exact-id\',\'campaign-id\')">Open GoLogin profile</button><button data-stop-profile-id="exact-id" onclick="stopProfileBrowserOpening(\'exact-id\')" hidden>Stop opening</button><div role="status" data-profile-opening-id="exact-id" hidden></div>'); });
  await page.getByRole('button', { name: 'Open GoLogin profile' }).click();
  assert.equal(await page.getByRole('button', { name: 'Profile is opening…' }).isDisabled(), true);
  assert.match(await page.locator('[data-profile-opening-id]').innerText(), /Profile is opening · 0s elapsed/);
  await page.waitForFunction(() => document.querySelector('[data-profile-opening-id]').textContent.includes('1s elapsed'));
  await page.evaluate(() => openProfileBrowser('exact-id', 'campaign-id'));
  assert.equal(await page.evaluate(() => profileRequests), 1);
  await page.evaluate(() => finishProfileOpen());
  await page.getByRole('button', { name: 'Open GoLogin profile' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open GoLogin profile' }).isEnabled(), true);
  assert.equal(await page.locator('[data-profile-opening-id]').isHidden(), true);
  await page.evaluate(() => {
    window.fetch = url => {
      if (url.includes('cancel-open-browser')) {
        window.abortOpen();
        return Promise.resolve({ json: async () => ({ ok: true, cancelled: true, browserClosed: true }) });
      }
      return new Promise(resolve => { window.abortOpen = () => resolve({ ok: false, json: async () => ({ cancelled: true, browserClosed: true }) }); });
    };
  });
  await page.getByRole('button', { name: 'Open GoLogin profile' }).click();
  await page.getByRole('button', { name: 'Stop opening' }).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-opening-id]').textContent.includes('Manual profile opening stopped'));
  assert.equal(await page.getByRole('button', { name: 'Open GoLogin profile' }).isEnabled(), true);
  console.log('PASS: scoped Pending DOM read; sidebar Pending ignored; dialog opens without actions; exact recipient dispatch; login separate; escaped text; Escape/Close cleanup. All requests intercepted.');
} finally { await browser.close(); }
