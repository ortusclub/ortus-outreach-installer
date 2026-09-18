import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { continuationPolicy, requestConfirmedResume } from '../public/js/continuation-policy.mjs';
import { usesMonitoringCadence } from '../public/js/campaign-modes.mjs';

for (const mode of ['connect_and_introduce', 'connect_and_message']) {
  test(`${mode} distinguishes one check from ongoing monitoring and describes sends`, () => {
    const policy = continuationPolicy(mode);
    assert.equal(policy.acceptance, true);
    assert.match(policy.checkLabel, /One acceptance check/);
    assert.match(policy.monitoringDetail, /not read-only/);
    assert.match(policy.monitoringDetail, mode === 'connect_and_message' ? /direct messages/ : /introductions/);
    assert.match(policy.scopeDetail, /all matching senders in the current sheet tab/);
  });
}
for (const mode of ['connect_only', 'open_profile_only', 'introduce_back', 'follower_growth', 'post_amplification', 'unknown']) {
  test(`${mode} does not offer an invented acceptance-monitoring phase`, () => {
    assert.equal(continuationPolicy(mode).acceptance, false);
  });
}
for (const response of [{ ok: false, body: { error: 'Pause pending' } }, { ok: true, body: { ok: false, reason: 'superseded' } }]) {
  test(`Resume rejects ${JSON.stringify(response)}`, async () => {
    await assert.rejects(requestConfirmedResume(async () => ({ ok: response.ok, json: async () => response.body }), 'fixture'));
  });
}

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const decision = app.slice(app.indexOf('window.openCampaignResumeDecision = async function'), app.indexOf('// Which campaign is this card actually showing?'));
function harness(mode, choices = []) {
  const calls = { checks: 0, resumes: 0, prompts: [], fetches: [], toasts: [] };
  const window = {};
  vm.runInNewContext(decision, {
    window, _resumeDecisionInFlight: new Set(), continuationPolicy,
    fetch: async url => { calls.fetches.push(url); return { ok: true, json: async () => ({ mode, paused: true, running: true, state: 'running' }) }; },
    appConfirm: async (text, options) => { calls.prompts.push({ text, options }); return choices.shift(); },
    _resumeAcceptanceCheckNow: async () => { calls.checks++; return true; },
    onResumeClicked: async () => { calls.resumes++; return false; },
    showCampaignToast: text => calls.toasts.push(text),
  });
  return { calls, run: (phase = 'sending', btn = null, current = 'local') => window.openCampaignResumeDecision(current === 'vm' ? 'fixture' : 'local-active', phase, current, btn) };
}
test('paused CC+DM one-check choice dispatches a check, never Resume', async () => {
  const h = harness('connect_and_message', [false]);
  assert.equal(await h.run(), true);
  assert.equal(h.calls.checks, 1);
  assert.equal(h.calls.resumes, 0);
  assert.match(h.calls.prompts[0].text, /direct messages/);
});

test('VM paused CC+IC uses the same one-check choice without sending Resume', async () => {
  const h = harness('connect_and_introduce', [false]);
  assert.equal(await h.run('sending', null, 'vm'), true);
  assert.equal(h.calls.checks, 1);
  assert.equal(h.calls.resumes, 0);
  assert.equal(h.calls.fetches[0], '/api/campaign/cloud/fixture');
});
test('dismissed phase choice performs no mutation', async () => {
  const h = harness('connect_and_introduce', [null]);
  await h.run();
  assert.equal(h.calls.checks + h.calls.resumes, 0);
});
test('non-monitoring mode offers ordinary continuation without acceptance choices', async () => {
  const h = harness('open_profile_only', [null]);
  await h.run();
  assert.equal(h.calls.prompts.length, 1);
  assert.doesNotMatch(h.calls.prompts[0].text, /acceptance check/i);
});
test('non-monitoring mode refuses a monitoring action even through a stale card', async () => {
  const h = harness('open_profile_only');
  assert.equal(await h.run('monitoring'), false);
  assert.equal(h.calls.checks + h.calls.resumes, 0);
  assert.match(h.calls.toasts[0], /no supported acceptance-monitoring/);
});
test('failed Resume keeps the originating button usable', async () => {
  const h = harness('open_profile_only', [true]);
  const button = { isConnected: true, disabled: false, setAttribute() {}, removeAttribute() {} };
  assert.equal(await h.run('sending', button), false);
  assert.equal(h.calls.resumes, 1);
  assert.equal(button.disabled, false);
});
test('failed preview never falls through to confirm Resume', async () => {
  const start = app.indexOf('async function onResumeClicked()');
  const end = app.indexOf("document.getElementById('resume-keep-editing')", start);
  let confirms = 0;
  const run = vm.runInNewContext(app.slice(start, end) + '\nonResumeClicked;', {
    requestConfirmedResume: async () => { throw new Error('review unavailable'); },
    fetch() {}, confirmResume: async () => { confirms++; }, showCampaignToast() {},
  });
  assert.equal(await run(), false);
  assert.equal(confirms, 0);
});

test('cloud keep-monitoring uses its own campaign mode and opens the scope choice', async () => {
  const start = app.indexOf('async function stopAndKeepMonitoring()');
  const end = app.indexOf('async function _finishStopAndKeepMonitoring(', start);
  const target = { cloud: true, id: 'fixture' };
  let opened = false;
  const run = vm.runInNewContext(app.slice(start, end) + '\nstopAndKeepMonitoring;', {
    window: {},
    _stopChoiceTarget: target, closeStopChoiceModal() {}, continuationPolicy,
    _cloudDetailCache: new Map([['fixture', { campaign: { mode: 'connect_and_message' } }]]),
    fetch: async () => ({ json: async () => ({ scraperEngineSourceSha: 'bd87927758bfed7611d72d210bf5efeac2e64a83' }) }),
    document: { getElementById: () => ({ classList: { remove() { opened = true; } } }) },
  });
  assert.equal(await run(), true);
  assert.equal(opened, true);
});

test('older isolated VM engine only offers its supported campaign scope', async () => {
  const start = app.indexOf('async function stopAndKeepMonitoring()');
  const end = app.indexOf('function closeStopMonitoringScope()', start);
  const target = { cloud: true, id: 'fixture' };
  let sent;
  const run = vm.runInNewContext(app.slice(start, end) + '\nstopAndKeepMonitoring;', {
    _stopChoiceTarget: target, closeStopChoiceModal() {}, continuationPolicy,
    _cloudDetailCache: new Map([['fixture', { campaign: { mode: 'connect_and_message' } }]]),
    fetch: async () => ({ json: async () => ({ scraperEngineSourceSha: 'ee138dbe7982' }) }),
    appConfirm: async () => true,
    _finishStopAndKeepMonitoring: async (...args) => { sent = args; return true; },
  });
  assert.equal(await run(), true);
  assert.equal(sent[1], 'campaign');
});

test('local CC+DM Stop between leads offers the monitoring choice before any stop request', () => {
  const start = app.indexOf('function confirmStopCampaign()');
  const end = app.indexOf('function closeStopModal()', start);
  const choice = { hidden: true, classList: { remove() { choice.hidden = false; } } };
  const sub = { textContent: '' };
  let immediateStops = 0;
  const run = vm.runInNewContext(app.slice(start, end) + '\nconfirmStopCampaign;', {
    cancelCloudLaunch: () => false, _viewingCloudId: null,
    __cockpit: { running: true, state: 'running', mode: 'connect_and_message', currentAction: { lead: '' } },
    _stopChoiceTarget: {}, usesMonitoringCadence,
    document: { getElementById: id => id === 'stop-choice-modal' ? choice : id === 'stop-choice-sub' ? sub : null },
    confirmStopCampaignNow: () => { immediateStops++; },
  });
  run();
  assert.equal(choice.hidden, false);
  assert.match(sub.textContent, /acceptance checks/);
  assert.equal(immediateStops, 0);
});

test('local tab-wide monitoring choice is confirmed and sent with tab scope', async () => {
  const start = app.indexOf('function closeStopMonitoringScope()');
  const end = app.indexOf('async function _finishStopAndKeepMonitoring(', start);
  let sent, prompt;
  const modal = { classList: { add() {} } };
  const target = { cloud: false, id: null };
  const run = vm.runInNewContext(app.slice(start, end) + '\nconfirmStopMonitoringScope;', {
    window: {}, _stopMonitoringScopeTarget: target,
    document: { getElementById: () => modal },
    __cockpit: { mode: 'connect_and_message' }, continuationPolicy,
    appConfirm: async text => { prompt = text; return true; },
    _finishStopAndKeepMonitoring: async (...args) => { sent = args; return true; },
  });
  assert.equal(await run('tab'), true);
  assert.match(prompt, /older requests/);
  assert.equal(sent[0], target);
  assert.equal(sent[1], 'tab');
});

test('VM tab-wide monitoring choice is confirmed and sent with tab scope', async () => {
  const start = app.indexOf('function closeStopMonitoringScope()');
  const end = app.indexOf('async function _finishStopAndKeepMonitoring(', start);
  let sent, prompt;
  const target = { cloud: true, id: 'cloud-a' };
  const run = vm.runInNewContext(app.slice(start, end) + '\nconfirmStopMonitoringScope;', {
    window: {}, _stopMonitoringScopeTarget: target,
    document: { getElementById: () => ({ classList: { add() {} } }) },
    _cloudDetailCache: new Map([['cloud-a', { campaign: { mode: 'connect_and_introduce' } }]]),
    continuationPolicy,
    appConfirm: async text => { prompt = text; return true; },
    _finishStopAndKeepMonitoring: async (...args) => { sent = args; return true; },
  });
  assert.equal(await run('tab'), true);
  assert.match(prompt, /the VM/);
  assert.equal(sent[0], target);
  assert.equal(sent[1], 'tab');
});

test('local endpoint rejects unsupported modes and invalid scope but accepts the tab scope', async () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = server.indexOf("app.post('/api/campaign/stop'");
  const start = server.indexOf("  if (req.body?.full === false", route);
  const end = server.indexOf('  const fullHalt', start);
  for (const [mode, scope, expected] of [['open_profile_only', 'campaign', 409], ['connect_and_message', 'sheet', 409], ['connect_and_message', 'tab', 200], ['connect_and_message', 'campaign', 200]]) {
    let handler, status = 200;
    const context = { handler: null, usesMonitoringCadence, campaign: { mode, running: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/fixture/edit#gid=19' },
      _manualSweepRunning: false, _manualSweepControl: null,
      _manualSweepAbort: false, _manualSweepController: null,
      checkDms: { running: false }, postAmp: { running: false },
      standaloneStopStatus: () => ({ stopping: false }) };
    vm.runInNewContext(`handler = async (req, res) => {${server.slice(start, end)}res.json({ok:true}); };`, context);
    handler = context.handler;
    await handler({ body: { full: false, monitoringScope: scope } }, { status(value) { status = value; return this; }, json() {} });
    assert.equal(status, expected);
  }
});
