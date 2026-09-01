import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('cloud mutations require a successful HTTP response', () => {
  assert.match(app, /if \(!res\.ok \|\| data\.error\)/);
  assert.match(app, /_cloudMutationRequest\(`\/api\/campaign\/cloud\/\$\{encodeURIComponent\(id\)\}\/\$\{path\}`/);
  assert.match(app, /Stop was not confirmed by the VM/);
});

test('a failed first VM detail read is unknown, never fabricated as running', () => {
  assert.match(app, /state: 'connection-unknown'/);
  assert.match(app, /running: false, queued: true/);
  assert.doesNotMatch(app, /name: 'Cloud campaign', running: true, logs: \[\]/);
});

test('the rich live stage is rendered during the queued branch', () => {
  assert.match(app, /if \(!renderLiveStage\(card, status\)\) _hideStage\(card\);/);
});

test('local status transport failures preserve and visibly mark the last truth', () => {
  assert.match(app, /Local engine connection unavailable/);
  assert.match(app, /No campaign transition was inferred from this failed request/);
});
