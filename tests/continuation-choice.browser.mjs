import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    if (['/js/continuation-choice.mjs','/js/continuation-policy.mjs','/js/campaign-modes.mjs'].includes(path)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../public' + path, import.meta.url), 'utf8') });
    if (['/css/style.css', '/css/dashboard-v0.3.css', '/css/launch-review.css'].includes(path)) return route.fulfill({ contentType: 'text/css', body: readFileSync(new URL('../public' + path, import.meta.url), 'utf8') });
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/dashboard-v0.3.css"><link rel="stylesheet" href="/css/launch-review.css"><main></main>' });
    return route.abort();
  });
  await page.goto('http://continuation-choice.test/');
  await page.evaluate(async () => {
    const { chooseContinuation } = await import('/js/continuation-choice.mjs');
    window.openChoice = (mode, extra = {}) => {
      window.answer = 'waiting';
      chooseContinuation({ name: 'QA', mode, ...extra }, { monitoringAvailable: true }).then(value => window.answer = value);
    };
  });
  for (const [label, answer] of [['Continue remaining sending', 'sending'], ['Run one check now','check'], ['Resume automatic monitoring','monitoring']]) {
    await page.evaluate(() => openChoice('connect_and_introduce'));
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(() => window.answer !== 'waiting');
    assert.equal(await page.evaluate(() => answer), answer);
    assert.equal(await page.locator('dialog').count(), 0);
  }
  await page.evaluate(() => openChoice('connect_only'));
  assert.equal(await page.getByRole('button', { name: 'Run one check now' }).count(), 0);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => window.answer !== 'waiting');
  assert.equal(await page.evaluate(() => answer), null);
  await page.evaluate(() => openChoice('connect_and_message', { state: 'monitoring', autoChecksEnabled: true }));
  assert.equal(await page.getByRole('button', { name: 'Automatic monitoring is already active' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.answer !== 'waiting');
  assert.equal(await page.evaluate(() => answer), null);
  for (const theme of ['', 'theme-light']) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(theme => { document.body.className = theme; }, theme);
      for (const mode of ['connect_only', 'connect_and_introduce']) {
        await page.evaluate(mode => openChoice(mode), mode);
        const layout = await page.locator('dialog').evaluate(d => {
          const r = d.getBoundingClientRect();
          const cancel = d.querySelector('footer button').getBoundingClientRect();
          const last = d.querySelector('section:last-of-type').getBoundingClientRect();
          return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, overflow: d.scrollWidth > d.clientWidth, cancelHeight: cancel.height, footerBelow: cancel.top >= last.bottom };
        });
        assert.ok(Math.abs(layout.cx - width / 2) < 2, 'dialog horizontally centred');
        assert.ok(Math.abs(layout.cy - 400) < 2, 'dialog vertically centred');
        assert.equal(layout.overflow, false);
        assert.ok(layout.cancelHeight < 50, 'Cancel must not stretch');
        assert.equal(layout.footerBelow, true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.answer !== 'waiting');
      }
    }
  }
  console.log('PASS: three distinct choices, unsupported monitoring absent, active monitoring disabled, Escape/Cancel close without selection. All requests intercepted.');
} finally { await browser.close(); }
