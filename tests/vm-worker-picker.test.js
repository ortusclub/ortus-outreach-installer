import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('cloud target exposes a numbered 20-worker chooser in the campaign wizard', () => {
  assert.match(html, /id="vm-worker-picker"/);
  assert.match(html, /id="vm-worker-grid"/);
  assert.match(app, /Array\.from\(\{ length: 20 \}/);
  assert.match(app, /choose one to continue/i);
});

test('chosen worker survives configuration and reaches cloud launch', () => {
  assert.match(app, /vmWorkerNumber: typeof getVmWorkerNumber/);
  assert.match(app, /vmWorkerNumber: getRunTarget\(\) === 'cloud'/);
  assert.match(server, /Choose a VM worker from 01 to 20/);
  assert.match(server, /vmWorkerNumber: vmSlot/);
});

test('new and duplicated campaigns cannot inherit a stale worker reservation', () => {
  assert.match(app, /const duplicateConfig = \{ \.\.\.config, vmWorkerNumber: null \}/);
  assert.match(app, /selectedProfileIds = \[\];\s*setVmWorkerNumber\(null\)/);
  assert.match(app, /Draft loaded\. Choose an available VM worker/);
});

test('cloud launch without a worker explains both available recovery choices', () => {
  assert.match(app, /Choose an available VM worker 01–20 before starting, or select This Mac/);
  assert.match(app, /All 20 Cloud VM workers are in use\. Select This Mac or wait for a VM worker to become available/);
  assert.match(app, /if \(getRunTarget\(\) === 'cloud' && !getVmWorkerNumber\(\)\)/);
});
