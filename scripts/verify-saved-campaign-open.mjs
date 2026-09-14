import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.ORTUS_VERIFY_URL || 'http://127.0.0.1:7847';
const email = process.env.ORTUS_VERIFY_EMAIL || 'info@ortus.solutions';
const campaignName = process.env.ORTUS_VERIFY_CAMPAIGN || 'TEST_24/08_cc+ic_a';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${base}/electron-login.html`);
  const login = await page.evaluate(async ({ email }) => {
    const r = await fetch('/api/auth/electron-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    return { ok: r.ok, body: await r.json() };
  }, { email });
  assert.equal(login.ok, true, login.body?.error || 'local test login failed');

  await page.goto(`${base}/#/dashboard`);
  await page.waitForSelector('#campaigns-board', { state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => typeof window.toggleBoardGroup === 'function', null, { timeout: 20_000 });
  // Exercise the same sidebar Dashboard action the Electron operator uses.
  await page.evaluate(() => { window.location.hash = '#/'; window.dispatchEvent(new Event('hashchange')); });
  await page.waitForFunction(() => document.body.classList.contains('route-dashboard'), null, { timeout: 20_000 });
  await page.evaluate(() => window.toggleBoardGroup('sub:mine:cancelled', true));
  try {
    await page.waitForFunction((name) => document.body.innerText.includes(name), campaignName, { timeout: 20_000 });
  } catch (error) {
    const body = (await page.locator('body').innerText()).slice(0, 4_000);
    const state = await page.evaluate(() => ({ hash: location.hash, bodyClass: document.body.className,
      board: document.getElementById('campaigns-board')?.innerText || '',
      boardDisplay: getComputedStyle(document.getElementById('dashboard-view')).display }));
    throw new Error(`${error.message}\nState: ${JSON.stringify(state)}\nDashboard text:\n${body}\nPage errors: ${pageErrors.join('; ')}`);
  }

  const strip = page.locator('.sn-strip', { hasText: campaignName }).first();
  await strip.getByRole('button', { name: 'Open', exact: true }).evaluate(async (button) => {
    const id = (button.getAttribute('onclick') || '').match(/openLocalHistoryCampaign\('([^']+)'\)/)?.[1];
    if (!id) throw new Error('Open button is not bound to a saved campaign id');
    await window.openLocalHistoryCampaign(id);
  });
  await page.waitForFunction(() => location.hash === '#/new');
  await page.waitForTimeout(3_000); // prove the ordinary idle poll cannot erase the selected history
  await page.waitForFunction(() => document.querySelectorAll('.profile-item').length > 0, null, { timeout: 20_000 });

  const result = await page.evaluate(() => ({
    hash: location.hash,
    name: document.getElementById('campaign-name-input')?.value || '',
    sheet: document.getElementById('sheet-url')?.value || '',
    activeAccountCount: document.getElementById('activeAccounts')?.textContent || '',
    activeCampaignId: document.getElementById('active-card')?.dataset.campaignId || '',
    activeCardText: document.getElementById('active-card')?.innerText || '',
  }));
  result.pageErrors = pageErrors.slice();
  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.hash, '#/new');
  assert.equal(result.name, campaignName);
  assert.ok(result.sheet.includes('docs.google.com/spreadsheets'), 'saved sheet URL was not restored');
  assert.equal(result.activeAccountCount, '3', 'historical card lost the original GoLogin account count');
  assert.match(result.activeCardText, new RegExp(campaignName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), pageErrors.join('; '));
  assert.doesNotMatch(result.activeCardText, /No campaign running/i);
  assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  console.log('PASS: saved local campaign restored and remained selected after idle polling.');
} finally {
  await browser.close();
}
