import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dataPath } from '../src/paths.js';
import { tokenForAccount } from '../src/gologin-accounts.js';

const FILE = dataPath('gologin-tokens.json');

test('ORTUS_DATA_DIR override wins over the baked env token; blank falls back', () => {
  const prevEnv = process.env.GOLOGIN_API_TOKEN;
  let backup = null;
  try { backup = readFileSync(FILE, 'utf8'); } catch { /* no existing override */ }
  process.env.GOLOGIN_API_TOKEN = 'env-token';
  try {
    // No override file → env is used.
    rmSync(FILE, { force: true });
    assert.equal(tokenForAccount('ortus'), 'env-token');
    // Override present → it wins (this is the self-serve fix: a Save takes effect
    // with no restart/reinstall).
    writeFileSync(FILE, JSON.stringify({ ortus: 'override-token' }));
    assert.equal(tokenForAccount('ortus'), 'override-token');
    // A blank override never blanks a working env token.
    writeFileSync(FILE, JSON.stringify({ ortus: '   ' }));
    assert.equal(tokenForAccount('ortus'), 'env-token');
    // Override for a different workspace doesn't leak into ortus.
    writeFileSync(FILE, JSON.stringify({ marketing: 'mkt-tok' }));
    assert.equal(tokenForAccount('ortus'), 'env-token');
  } finally {
    if (backup !== null) writeFileSync(FILE, backup); else rmSync(FILE, { force: true });
    if (prevEnv === undefined) delete process.env.GOLOGIN_API_TOKEN; else process.env.GOLOGIN_API_TOKEN = prevEnv;
  }
});
