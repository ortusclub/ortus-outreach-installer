// Real app markup/CSS + actual layout and gate functions. No live API or browser accounts.
import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../public/', import.meta.url);
const raw = fs.readFileSync(new URL('index.html', root), 'utf8');
const app = fs.readFileSync(new URL('js/app.js', root), 'utf8');
const functionBody = name => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  return app.slice(start, end + 2);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'automation.test') return route.abort();
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') });
    if (/^\/(css\/(style|dashboard-v0\.3|launch-review|automation-layout)\.css|js\/automation-layout\.mjs)$/.test(u.pathname)) {
      return route.fulfill({ contentType: u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(new URL(u.pathname.slice(1), root), 'utf8') });
    }
    return route.abort();
  });
  await page.goto('http://automation.test/');
  await page.evaluate(async () => {
    document.querySelectorAll('*').forEach(e => { for (const a of [...e.attributes]) if (a.name.startsWith('on')) e.removeAttribute(a.name); });
    document.body.classList.add('theme-light', 'route-wizard');
    document.querySelectorAll('.route-view').forEach(e => e.style.display = e.id === 'wizard-view' ? 'block' : 'none');
    window.layout = await import('/js/automation-layout.mjs');
    window.beforeControls = [...document.querySelectorAll('#manifest-auto-box input, #manifest-auto-box select')];
    window.beforeValues = beforeControls.map(e => [e.id, e.value, e.checked]);
    window.changeCount = 0;
    document.getElementById('check-cadence-select').addEventListener('change', () => window.changeCount++);
    layout.mountAutomationLayout();
    layout.mountAutomationLayout();
    document.getElementById('nav-templates').after(document.getElementById('nav-pace'));
    window.refreshPrimarySourceLabels = () => {};
    window.renderManifest = () => {};
    window.savePrimaryPersonFields = () => {};
  });
  await page.addScriptTag({ content: `${functionBody('refreshAutoAcceptGate')}\n${functionBody('toggleFollowUpFields')}\nconst syncFollowUpTiming = (...args) => layout.syncFollowUpTiming(...args);` });
  assert.equal(await page.locator('#nav-automation').count(), 1);
  assert.equal(await page.evaluate(() => beforeControls.every(e => document.getElementById('nav-automation').contains(e))), true);
  assert.deepEqual(await page.evaluate(() => beforeControls.map(e => [e.id, e.value, e.checked])), await page.evaluate(() => beforeValues));
  assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size; }), true);
  for (const mode of ['connect_and_introduce', 'connect_and_message', 'introduce_back', 'connect_only', 'message_only', 'check_status']) {
    await page.evaluate(mode => {
      document.getElementById('campaign-mode').value = mode;
      layout.syncAutomationLayout(mode);
      toggleFollowUpFields();
    }, mode);
    const active = ['connect_and_introduce', 'connect_and_message'].includes(mode);
    assert.equal(await page.locator('#nav-automation').isVisible(), active, mode);
    assert.equal(await page.locator('#primary-source-field').isVisible(), mode === 'connect_and_introduce', mode);
    assert.equal(await page.locator('#check-cadence-block').isVisible(), active, mode);
    assert.equal(await page.locator('#follow-up-block').isVisible(), mode === 'connect_and_introduce', mode);
  }
  await page.evaluate(() => {
    document.getElementById('campaign-mode').value = 'connect_and_introduce';
    layout.syncAutomationLayout('connect_and_introduce');
    document.getElementById('primary-person-url').value = '';
    refreshAutoAcceptGate();
  });
  assert.equal(await page.locator('#auto-accept-toggle').isDisabled(), true);
  await page.evaluate(() => { document.getElementById('primary-person-url').value = 'https://www.linkedin.com/in/antoniovarlese/'; refreshAutoAcceptGate(); });
  assert.equal(await page.locator('#auto-accept-toggle').isChecked(), true);
  assert.equal(await page.locator('#auto-accept-all-toggle').isDisabled(), false);
  await page.evaluate(() => { document.getElementById('auto-accept-toggle').checked = false; refreshAutoAcceptGate(); });
  assert.equal(await page.locator('#auto-accept-all-toggle').isDisabled(), true);
  await page.selectOption('#check-cadence-select', '240');
  assert.equal(await page.evaluate(() => changeCount), 1);
  for (const on of [true, false, true]) {
    await page.evaluate(on => { document.getElementById('follow-up-toggle').checked = on; toggleFollowUpFields(); }, on);
    assert.equal(await page.locator('#follow-up-fields').isVisible(), true);
    assert.equal(await page.locator('#follow-up-delay').isDisabled(), !on);
    assert.equal(await page.locator('#tpl-followup-section').evaluate(e => e.style.display !== 'none'), on);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.body.classList.toggle('theme-light', theme === 'light'); document.getElementById('nav-automation').scrollIntoView(); }, theme);
    await page.screenshot({ path: `/private/tmp/ortus-automation-a-${theme}.png` });
    assert.equal(await page.locator('#manifest-customize-btn').count(), 0);
    assert.equal(await page.locator('#manifest-drawer').isVisible(), true);
  }
  await page.setViewportSize({ width: 800, height: 1000 });
  assert.equal(await page.locator('#nav-automation').evaluate(e => e.scrollWidth > e.clientWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: real markup; no cloned/lost controls or values; idempotent mount; six modes; acceptance gates; follow-up on/off; existing change listener; light/dark; narrow layout. No live requests.');
} finally { await browser.close(); }
