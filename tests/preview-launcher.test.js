import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('preview launcher is PR-scoped and cannot name production', () => {
  const source = fs.readFileSync(new URL('../scripts/electron-preview-vm.sh', import.meta.url), 'utf8');
  assert.match(source, /preview-pr-\$\{PR_NUMBER\}-salesnav-scraper/);
  assert.match(source, /ORTUS_ENGINE_ENVIRONMENT="preview"/);
  assert.match(source, /ORTUS_ENGINE_NAMESPACE="salesnav-previews"/);
  assert.doesNotMatch(source, /salesnav-scraper-prod/);
  assert.doesNotMatch(source, /electron:build|release:mac|\.dmg/i);
});

test('ordinary development command remains the default shared engine', () => {
  const source = fs.readFileSync(new URL('../scripts/electron-dev-vm.sh', import.meta.url), 'utf8');
  assert.match(source, /ORTUS_ENGINE_NAMESPACE:-salesnav-dev/);
  assert.match(source, /ORTUS_ENGINE_DEPLOYMENT:-salesnav-scraper/);
});
