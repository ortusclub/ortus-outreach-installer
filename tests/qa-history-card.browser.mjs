import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../public/', import.meta.url);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'qa.test') return route.abort();
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, running: false, state: 'idle', profiles: [], campaigns: [], queue: [], history: [], accounts: [],
      email: 'fixture@ortusclub.com', operatorEmail: 'fixture@ortusclub.com', logs: [],
    }) });
    const path = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = new URL(path, root);
    if (!file.href.startsWith(root.href) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    let body = fs.readFileSync(file);
    if (path === 'js/app.js') body = body.toString() + '\nwindow.__qa = { vjCardSkeleton, fillVjCard, statusFromItem, renderLiveStage, _vjControlsHtml, renderUnifiedStrip, vjCardControlsFor, seedItem: it => _boardItemsById.set(it.id, it), clearAccounts: () => _cloudAccountsById.clear(), visibility: (s, force = false) => { Object.assign(__cockpit, { running: false, state: "idle", paused: false, hasLogs: false, endNotice: null }, s); liveStatusForcedOpen = force; syncLiveStatusVisibility(); return document.getElementById("nav-status").style.display; } };';
    return route.fulfill({ contentType: /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream', body });
  });
  await page.goto('http://qa.test/');
  await page.waitForFunction(() => window.__qa, { timeout: 10000 }).catch(error => { throw new Error(`${error.message}; ${errors.join('; ')}`); });
  const result = await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'qa-cards'; document.body.append(host);
    const make = (id, item) => {
      host.insertAdjacentHTML('beforeend', __qa.vjCardSkeleton(id));
      const card = host.lastElementChild;
      const status = __qa.statusFromItem({ id, name: id, where: 'local', bucket: 'done', mode: 'connect_only', total: 2, ...item });
      __qa.fillVjCard(card, status);
      // Do not let fillVjCard's cosmetic catch hide a broken stage renderer.
      __qa.renderLiveStage(card, status);
      return { text: card.innerText, headline: card.querySelector('[data-f="stageName"]').textContent,
        outcome: card.querySelector('[data-f="stageSideValue"]').textContent,
        log: card.querySelector('[data-f="active-log"]').textContent,
        buttons: [...card.querySelectorAll('button')].map(b => b.textContent.trim()) };
    };
    return {
      a: make('A', { sent: 1, endReason: 'needs_review', needsOutcomeReview: true,
        logs: ['[2026-09-09T13:17:11Z] A: HTTP 429', '[2026-09-09T13:17:38Z] === Campaign ended ==='],
        recoveryAccounts: [{ profileId: '686690d57fb4a4e8c8430165', email: 'sender-a', verificationLeads: [{ name: 'Recipient', url: 'https://www.linkedin.com/in/recipient', detail: '429' }] }] }),
      b: make('B', { sent: 0, endReason: 'blocked', endNotice: { reason: 'all_parked', detail: 'Needs login' },
        logs: ['[2026-09-09T13:18:09Z] B: session expired', '[2026-09-09T13:18:17Z] === Campaign ended ==='],
        recoveryAccounts: [{ profileId: '686637d18c8015107a639ef6', email: 'sender-b', needsLogin: true }] }),
      primary: make('Primary recovery', { bucket: 'running', mode: 'connect_and_introduce',
        executionId: 'primary-fixture', phase: 'preflight',
        primaryRecovery: { state: 'logged-out', source: 'local-browser' },
        logs: ['Primary browser is logged out. Sending is waiting.'],
      }),
    };
  });
  assert.equal(result.a.outcome.toLowerCase(), 'needs verification'); assert.equal(result.b.outcome.toLowerCase(), 'blocked');
  assert.equal(result.a.headline.toLowerCase(), 'needs verification'); assert.equal(result.b.headline.toLowerCase(), 'blocked');
  assert.match(result.a.log, /A: HTTP 429/); assert.doesNotMatch(result.a.log, /B: session expired/);
  assert.match(result.b.log, /B: session expired/); assert.doesNotMatch(result.b.log, /A: HTTP 429/);
  assert.ok(result.a.buttons.includes('Verify'));
  assert.ok(!result.b.buttons.includes('Log in'), 'login action is in the account drawer, not next to the pill');
  assert.match(result.primary.headline, /Primary needs login/i);
  assert.equal(result.primary.outcome, 'Waiting for you');
  assert.doesNotMatch(result.primary.text, /about 2 minutes|First sender browser opens|Workers sleep/i);
  assert.ok(result.primary.buttons.includes('Open primary & log in'));
  assert.ok(result.primary.buttons.includes('I’ve logged in — retry'));
  const recoveryLayout = await page.evaluate(() => {
    const card = document.querySelector('[data-campaign-id="Primary recovery"]');
    const actions = card.querySelector('[data-primary-recovery]');
    const button = actions.querySelector('button');
    const readings = [];
    for (const theme of ['', 'theme-light']) {
      document.body.className = theme;
      const style = getComputedStyle(button);
      readings.push({ background: style.backgroundColor, color: style.color, weight: style.fontWeight, height: button.getBoundingClientRect().height });
    }
    return { readings, count: card.querySelectorAll('[onclick*="localPrimaryRecovery"]').length,
      inside: !!actions.closest('.vj-stage'), timer: card.querySelectorAll('.vj-stage-secs').length };
  });
  assert.equal(recoveryLayout.count, 2, 'no duplicate footer actions');
  assert.equal(recoveryLayout.inside, true);
  assert.equal(recoveryLayout.timer, 0, 'no ticking timer while waiting for login');
  for (const reading of recoveryLayout.readings) {
    assert.notEqual(reading.background, reading.color);
    assert.ok(Number(reading.weight) >= 700);
    assert.ok(reading.height >= 48);
  }
  const restartLabels = await page.evaluate(() => {
    const c = { restart: { onclick: 'void(0)' }, extra: [] };
    const holder = document.createElement('div');
    holder.innerHTML = __qa._vjControlsHtml(c, { running: true });
    return [...holder.querySelectorAll('button')].map(button => button.textContent.trim());
  });
  assert.ok(restartLabels.includes('Restart campaign'), 'a running campaign recovery action must not be mislabeled Continue');
  const coldStoppedCard = await page.evaluate(() => {
    __qa.clearAccounts();
    window.renderActiveCard({ id: 'legacy-singleton', executionId: 'local-su02', running: false,
      state: 'idle', stopReason: 'operator-stopped', name: 'SU-02', mode: 'connect_only',
      totalTargets: 2, totalProcessed: 0, profileIds: ['sender'], accountPanel: [],
      logs: ['Stop requested', '=== Campaign ended ==='] });
    const card = document.getElementById('active-card');
    // Mount independently of the fixture's dashboard route, which otherwise
    // hides the entire Campaign tab (including correctly rendered controls).
    document.body.append(card);
    card.hidden = false;
    card.style.display = 'block';
    const stage = card.querySelector('[data-f="active-stage"], #active-stage');
    return { unified: card.classList.contains('has-unified-stage'), stageHidden: stage?.hidden,
      legacyHidden: document.getElementById('active-live').hidden,
      buttons: [...card.querySelectorAll('button')].filter(b => b.getClientRects().length && getComputedStyle(b).display !== 'none').map(b => b.textContent.trim() || b.getAttribute('aria-label')) };
  });
  assert.equal(coldStoppedCard.unified, true);
  assert.equal(coldStoppedCard.stageHidden, false);
  assert.equal(coldStoppedCard.legacyHidden, true);
  assert.ok(coldStoppedCard.buttons.includes('Continue campaign'));
  assert.ok(!coldStoppedCard.buttons.includes('Stop campaign'));
  assert.ok(!coldStoppedCard.buttons.includes('Pause'));
  const dashboardParity = await page.evaluate(() => {
    const item = { id: 'h-su02', where: 'local', bucket: 'done', name: 'SU-02', mode: 'connect_only',
      sent: 0, total: 2, bad: true, mine: true, accounts: 1,
      hist: { endReason: 'stopped', endNotice: { reason: 'operator_stopped', detail: 'Stopped by operator.' }, totalTargets: 2, totalProcessed: 0 },
      srcSettings: { profileIds: ['sender'], sheetUrl: 'fixture' }, logs: ['=== Campaign ended ==='] };
    const state = __qa.statusFromItem(item);
    const controls = __qa.vjCardControlsFor(state);
    const compact = document.createElement('div'); compact.innerHTML = __qa.renderUnifiedStrip(item);
    const expanded = document.createElement('div'); expanded.innerHTML = __qa.vjCardSkeleton('qa-expanded-restart');
    __qa.fillVjCard(expanded.firstElementChild, state);
    document.body.append(expanded);
    const stage = expanded.querySelector('[data-f="active-stage"]');
    const retry = expanded.querySelector('[data-f="active-retry"]');
    const actions = node => [...node.querySelectorAll('button')]
      .filter(b => /openCampaignContinuation/.test(b.getAttribute('onclick') || ''))
      .map(b => [b.textContent.trim(), b.getAttribute('onclick')]);
    return { compact: actions(compact), expanded: actions(expanded), pause: controls.pause, stop: controls.stop,
      stageVisible: !!stage && getComputedStyle(stage).display !== 'none' && !stage.hidden,
      retryHidden: retry.hidden, text: expanded.textContent };
  });
  assert.deepEqual(dashboardParity.compact, dashboardParity.expanded);
  assert.equal(dashboardParity.compact.length, 1);
  assert.equal(dashboardParity.pause, null); assert.equal(dashboardParity.stop, null);
  assert.equal(dashboardParity.stageVisible, true, 'stopped dashboard must show shared terminal stage');
  assert.equal(dashboardParity.retryHidden, true, 'legacy retry panel must not hide terminal stage');
  assert.doesNotMatch(dashboardParity.text, /\[object Object\]/);
  const compactReview = await page.evaluate(() => __qa.renderUnifiedStrip({
    id: 'review-fixture', where: 'local', bucket: 'done', name: 'Review fixture',
    mode: 'connect_only', total: 2, sent: 1, needsOutcomeReview: true,
    endReason: 'needs_review', mine: true,
  }));
  assert.match(compactReview, /Needs verification/);
  const draftVisibility = await page.evaluate(() => {
    history.replaceState(null, '', '#/new');
    localStorage.setItem('ortus.activeDraftId', 'new-draft-fixture');
    document.getElementById('campaign-mode').value = 'connect_and_introduce';
    const ended = { running: false, state: 'idle', hasLogs: true, endNotice: { reason: 'operator_stopped' } };
    const results = {
      stopped: __qa.visibility(ended),
      completed: __qa.visibility({ ...ended, endNotice: { reason: 'completed' } }),
      monitoring: __qa.visibility({ running: false, state: 'monitoring' }),
      running: __qa.visibility({ running: true }),
      explicitlyOpened: __qa.visibility(ended, true),
    };
    localStorage.removeItem('ortus.activeDraftId');
    results.ownFinishedRun = __qa.visibility(ended);
    return results;
  });
  for (const key of ['stopped', 'completed', 'monitoring', 'running']) assert.equal(draftVisibility[key], 'none', key + ' must not leak into unrelated draft');
  assert.equal(draftVisibility.explicitlyOpened, '');
  assert.equal(draftVisibility.ownFinishedRun, '');
  await page.evaluate(() => {
    const item = { id: 'h-selected-fixture', name: 'Selected historical campaign', where: 'local', bucket: 'done',
      mode: 'connect_and_introduce', bad: true, total: 2, sent: 0,
      hist: { executionId: 'selected-execution', endReason: 'stopped' },
      srcSettings: { profileIds: ['sender'], sheetUrl: 'https://docs.google.com/spreadsheets/d/fixture/edit' },
      logs: ['Selected historical log entry'],
    };
    __qa.seedItem(item);
    const action = __qa.vjCardControlsFor(__qa.statusFromItem(item)).open.onclick;
    if (action !== "openFinishedLocalCampaign('h-selected-fixture')") throw new Error('Expanded card must target selected history');
    window.openFinishedLocalCampaign(item.id);
  });
  await page.waitForFunction(() => document.getElementById('active-card').dataset.campaignId === 'h-selected-fixture');
  const selectedView = await page.evaluate(() => {
    window.renderActiveCard({ id: 'legacy-singleton', state: 'idle', name: 'Unrelated poll', logs: [] });
    const card = document.getElementById('active-card');
    return { id: card.dataset.campaignId, text: card.textContent, display: document.getElementById('nav-status').style.display };
  });
  assert.equal(selectedView.id, 'h-selected-fixture');
  assert.match(selectedView.text, /Selected historical log entry/);
  assert.equal(selectedView.display, '');
  await page.evaluate(() => window.startNewCampaign());
  const afterNew = await page.evaluate(() => {
    localStorage.setItem('ortus.activeDraftId', 'fresh-fixture');
    window.renderActiveCard({ id: 'legacy-singleton', running: false, state: 'idle', logs: [] });
    return { id: document.getElementById('active-card').dataset.campaignId,
      display: __qa.visibility({ state: 'idle', hasLogs: true }) };
  });
  assert.notEqual(afterNew.id, 'h-selected-fixture');
  assert.equal(afterNew.display, 'none');
  console.log('PASS: actual expanded-card renderer preserves separate logs, blocked/review outcomes and exact-account recovery buttons. All requests intercepted.');
} finally { await browser.close(); }
