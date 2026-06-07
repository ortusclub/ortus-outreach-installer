import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = 'file://' + resolve(__dirname, '..', 'public', 'sketches', 'past-row-chips.html');
const out = resolve(__dirname, '..', 'dist-shots', 'past-row-chips.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 360 }, deviceScaleFactor: 2 });
await page.goto(file);
await page.waitForTimeout(300);

// Report computed font-size of each chip vs the stopped badge, so I can verify.
const sizes = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { fontSize: cs.fontSize, fontFamily: cs.fontFamily.split(',')[0], width: Math.round(r.width), height: Math.round(r.height) };
  };
  return {
    stopped: pick('.pa-stopped'),
    solo: pick('.mon-chip.is-solo'),
    off: pick('.mon-chip.is-off'),
    on: pick('.mon-chip.is-on'),
    stopSolo: pick('.mon-chip.is-stop-solo'),
  };
});
console.log(JSON.stringify(sizes, null, 2));

await page.screenshot({ path: out });
console.log('shot →', out);
await browser.close();
