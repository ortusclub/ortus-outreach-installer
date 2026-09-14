import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('campaign imports every atomic JSON helper used by startup state loading', async () => {
  const source = await readFile(new URL('../src/campaign.js', import.meta.url), 'utf8');
  const importMatch = source.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\/atomic-json-store\.js['"]/,
  );

  assert.ok(importMatch, 'campaign must import the atomic JSON store');
  const importedNames = new Set(
    importMatch[1].split(',').map((name) => name.trim()).filter(Boolean),
  );

  assert.ok(importedNames.has('readJson'), 'loadState requires readJson');
  assert.ok(importedNames.has('writeJsonAtomic'));
  assert.ok(importedNames.has('updateJsonAtomic'));
});
