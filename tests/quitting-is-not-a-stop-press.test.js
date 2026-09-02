import { test } from 'node:test';
import assert from 'node:assert';
import { _setTestState, stopCampaign, getCampaignState } from '../src/campaign.js';

// Quitting the app calls stopCampaign() too (server.js gracefulShutdown), and it
// used to borrow the operator wording — so every quit ended the log with "Stop
// pressed, but nothing is running", which nobody had pressed (Sam's log, 1 Sep).

const lastLine = () => {
  const logs = getCampaignState().logs || [];
  const last = logs[logs.length - 1];
  return String((last && (last.message || last.text)) || last || '');
};

test('quitting the app never claims Stop was pressed', async () => {
  _setTestState({ state: 'idle', running: false, logs: [] });
  stopCampaign({ quitting: true });
  const line = lastLine();
  assert.doesNotMatch(line, /Stop pressed/, 'a quit is not a Stop press');
  assert.match(line, /app is closing/i, 'it should say what actually happened');
});

test('pressing Stop with nothing running still says so, unchanged', async () => {
  _setTestState({ state: 'idle', running: false, logs: [] });
  stopCampaign();
  assert.match(lastLine(), /Stop pressed, but nothing is running/);
});

test('pressing Stop on a running campaign still reads as a stop request', async () => {
  _setTestState({ state: 'running', running: true, logs: [] });
  stopCampaign();
  assert.match(lastLine(), /Stop requested/);
});

test('quitting with a campaign running says the Cloud VM keeps going', async () => {
  _setTestState({ state: 'running', running: true, logs: [] });
  stopCampaign({ quitting: true });
  const line = lastLine();
  assert.doesNotMatch(line, /Stop requested/);
  assert.match(line, /Cloud VM keeps going/i);
});
