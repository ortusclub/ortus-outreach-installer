import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const css = ['style.css', 'dashboard-v0.3.css', 'recovery-panel.css', 'visibility-theme.css']
  .map(name => fs.readFileSync(new URL('../public/css/' + name, import.meta.url), 'utf8')).join('\n');
function luminance(color) {
  const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
    const c = n / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><body data-dashboard="v3"><div class="vj-card"><div class="vj-stage is-sending">
    ${['', 'ok', 'warn', 'bad'].map(state => `<button class="stg-acct"><span class="cap-badge ${state}"><span class="nm">Account</span><span class="n">8/50</span></span></button>`).join('')}
    <div class="stg-drawer"><div class="acts"><button class="stg-login-btn">Log in</button></div></div>
    </div></div></body>`);
  for (const theme of ['theme-light', 'theme-dark']) {
    await page.evaluate(theme => document.body.className = theme, theme);
    // Existing name-color transitions need to settle after switching themes.
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => ({
      gradient: getComputedStyle(document.querySelector('.vj-stage')).backgroundImage,
      pills: [...document.querySelectorAll('.cap-badge')].map(el => ({
        bg: getComputedStyle(el).backgroundColor,
        text: [...el.children].map(child => ({ color: getComputedStyle(child).color, opacity: getComputedStyle(child).opacity }))
      }))
    }));
    assert.match(result.gradient, /linear-gradient/);
    for (const pill of result.pills) for (const text of pill.text) {
      const values = [luminance(pill.bg), luminance(text.color)].sort((a, b) => b - a);
      assert.ok((values[0] + .05) / (values[1] + .05) >= 4.5, `${theme}: pill contrast below 4.5:1`);
      assert.equal(text.opacity, '1');
    }
  }
  console.log('PASS: both themes retain strip gradient; every pill name/count passes 4.5:1 contrast.');
} finally { await browser.close(); }
