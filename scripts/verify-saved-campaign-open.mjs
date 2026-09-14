import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.ORTUS_VERIFY_URL || 'http://127.0.0.1:7847';
const email = process.env.ORTUS_VERIFY_EMAIL || 'info@ortus.solutions';
const campaignName = process.env.ORTUS_VERIFY_CAMPAIGN || 'TEST_24/08_cc+ic_a';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const pageErrors = [];
  const historyResponses = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/history/') && response.url().endsWith('/log')) {
      historyResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(`${base}/electron-login.html`);
  const login = await page.evaluate(async ({ email }) => {
    const r = await fetch('/api/auth/electron-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    return { ok: r.ok, body: await r.json() };
  }, { email });
  assert.equal(login.ok, true, login.body?.error || 'local test login failed');
  const logProbe = await page.evaluate(async () => {
    const r = await fetch('/api/history/37/log');
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, total: body.total, lines: body.lines };
  });
  console.log('Authenticated history-log probe:', JSON.stringify({
    ok: logProbe.ok, status: logProbe.status, total: logProbe.total,
    first: logProbe.lines?.[0], last: logProbe.lines?.at(-1),
  }));

  await page.goto(`${base}/#/`);
  await page.waitForSelector('#campaigns-board', { state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => typeof window.toggleBoardGroup === 'function', null, { timeout: 20_000 });
  await page.evaluate(() => { window.location.hash = '#/dashboard'; });
  await page.waitForFunction(() => document.body.classList.contains('route-dashboard'), null, { timeout: 20_000 });
  await page.evaluate(() => document.getElementById('op-tz-modal')?.remove());
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

  try {
    await page.waitForFunction((name) => {
      const target = [...document.querySelectorAll('.sn-strip')]
        .find((el) => el.textContent.includes(name));
      const text = target?.querySelector('.sn-logbox')?.textContent || '';
      return text.includes('Campaign ended') && !text.includes('No stored log lines');
    }, campaignName, { timeout: 20_000 });
  } catch (error) {
    const debug = await page.evaluate((name) => {
      const el = [...document.querySelectorAll('.sn-strip')]
        .find((node) => node.textContent.includes(name));
      const box = el?.querySelector('.sn-logbox');
      return { hash: location.hash, bodyClass: document.body.className,
        cardFound: !!el, cardVisible: !!el && el.offsetParent !== null,
        classes: el?.className, text: box?.textContent, histlog: box?.dataset.histlog,
        boxDisplay: box ? getComputedStyle(box).display : null };
    }, campaignName);
    throw new Error(`${error.message}\nDashboard log debug: ${JSON.stringify(debug)}\nHistory responses: ${JSON.stringify(historyResponses)}\nPage errors: ${pageErrors.join('; ')}`);
  }
  const dashboardState = await page.evaluate((name) => {
    const target = [...document.querySelectorAll('.sn-strip')]
      .find((el) => el.textContent.includes(name));
    return { campaignId: target?.dataset.cid || '', logText: target?.querySelector('.sn-logbox')?.textContent || '' };
  }, campaignName);
  const dashboardLogText = dashboardState.logText;
  const campaignId = dashboardState.campaignId;
  assert.ok(campaignId, 'saved Dashboard card has no campaign id');
  await page.evaluate(async (id) => window.openLocalHistoryCampaign(id), campaignId);
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
  result.dashboardLogRecovered = /Campaign ended/i.test(dashboardLogText || '');
  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.hash, '#/new');
  assert.equal(result.name, campaignName);
  assert.ok(result.sheet.includes('docs.google.com/spreadsheets'), 'saved sheet URL was not restored');
  assert.equal(result.activeAccountCount, '3', 'historical card lost the original GoLogin account count');
  assert.equal(result.dashboardLogRecovered, true, 'Dashboard card did not receive the recovered historical log');
  assert.match(result.activeCardText, new RegExp(campaignName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), pageErrors.join('; '));
  assert.match(result.activeCardText, /Campaign ended/i, 'campaign tab did not receive the recovered historical log');
  assert.doesNotMatch(result.activeCardText, /No campaign running/i);
  assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  console.log('PASS: saved local campaign restored and remained selected after idle polling.');
} finally {
  await browser.close();
}
