import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../public/', import.meta.url);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('ortus.activeDraftId', 'handover-draft');
    localStorage.setItem('currentDraftId', 'handover-draft');
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'qa.test') return route.abort();
    if (url.pathname === '/api/drafts/handover-draft') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        id: 'handover-draft', name: 'CC+DM moving to VM', config: {
          mode: 'connect_and_message', sheetUrl: 'https://docs.google.com/spreadsheets/d/test/edit',
          profileIds: ['saved-sender'], dailyLimit: 7,
          templates: { connectionNote: 'Saved note', ccDmBody: 'Saved DM body' },
        },
      }) });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = new URL(path, root);
    if (!file.href.startsWith(root.href) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    let body = fs.readFileSync(file);
    if (path === 'js/app.js') body = body.toString() + '\nwindow.__handoverQaControls = _vjControlsHtml; window.__handoverQaWhere = whereBlockHtml;';
    return route.fulfill({ contentType: /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream', body });
  });
  await page.goto('http://qa.test/#/new');
  await page.waitForFunction(() => document.getElementById('tpl-cc-dm-body')?.value === 'Saved DM body');
  const before = await page.evaluate(() => ({
    name: document.getElementById('campaign-name-input')?.value,
    sheet: document.getElementById('sheet-url')?.value,
    note: document.getElementById('tpl-note')?.value,
    dm: document.getElementById('tpl-cc-dm-body')?.value,
  }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('tpl-cc-dm-body')?.value === 'Saved DM body');
  const after = await page.evaluate(() => ({
    name: document.getElementById('campaign-name-input')?.value,
    sheet: document.getElementById('sheet-url')?.value,
    note: document.getElementById('tpl-note')?.value,
    dm: document.getElementById('tpl-cc-dm-body')?.value,
  }));
  assert.deepEqual(after, before);
  assert.equal(after.name, 'CC+DM moving to VM');
  assert.equal(after.note, 'Saved note');
  const stopActions = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = window.__handoverQaControls({}, {
      _cloud: true, id: 'vm-stopping', engineStatus: 'stopping', state: 'stopping',
    });
    return [...host.querySelectorAll('button')].map(button => button.textContent.trim());
  });
  assert.deepEqual(stopActions, ['Stop & remove']);
  const switchStates = await page.evaluate(() => {
    const inspect = status => {
      const host = document.createElement('div');
      host.innerHTML = window.__handoverQaWhere({ _cloud: true, id: 'vm-1', runsOn: 'vm', ...status });
      return { disabled: [...host.querySelectorAll('.wh-seg button')].map(b => b.disabled),
        text: host.textContent, confirm: !!host.querySelector('.wh-confirm') };
    };
    const local = (() => {
      const host = document.createElement('div');
      host.innerHTML = window.__handoverQaWhere({ id: 'local-1', runsOn: 'local', running: true,
        currentAction: { phase: 'starting' } });
      return [...host.querySelectorAll('.wh-seg button')].map(b => b.disabled);
    })();
    return [inspect({ queued: true, state: 'queued' }),
      inspect({ running: true, currentAction: { phase: 'starting' } }),
      inspect({ running: true, currentAction: { phase: 'sending' } }), { disabled: local }];
  });
  assert.deepEqual(switchStates.map(x => x.disabled), [[true, true], [true, true], [true, false], [true, true]]);
  assert.match(switchStates[0].text, /switch available after a sender browser opens/);
  assert.equal(switchStates[1].confirm, false);
} finally {
  await browser.close();
}
