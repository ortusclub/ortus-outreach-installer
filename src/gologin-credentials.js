/**
 * src/gologin-credentials.js — operator-entered GoLogin workspace tokens.
 *
 * Ported from Ortus Basics 1.0. Tokens are saved to the app's data directory
 * (ORTUS_DATA_DIR) so they survive app updates — the .env inside the bundle is
 * no longer the only source. A saved token takes precedence over the .env value;
 * an .env value still works as a fallback so existing installs don't break.
 *
 * tokenForAccount() in gologin-accounts.js reads process.env at call time, so
 * applying a saved token is a live mutation: no restart needed.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dataPath } from './paths.js';
import { GL_ACCOUNTS } from './gologin-accounts.js';

const FILE = () => dataPath('gologin-credentials.json');

/** Every token this app understands, in the order Settings should show them. */
export function credentialFields() {
  return GL_ACCOUNTS.map((a) => ({
    id: a.id,
    label: a.label,
    env: a.env,
    required: a.id === 'ortus',
  }));
}

export function readCredentials() {
  try {
    const p = FILE();
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn(`[credentials] could not read: ${err.message}`);
    return {};
  }
}

/** Push saved tokens into process.env. Never clobbers a value already set by
 *  the environment — the dev launcher injects tokens that must win. */
export function applyCredentials(creds = readCredentials()) {
  const applied = [];
  for (const f of credentialFields()) {
    const v = String(creds[f.env] || '').trim();
    if (v && !process.env[f.env]) { process.env[f.env] = v; applied.push(f.id); }
  }
  return applied;
}

export function saveCredentials(input) {
  const creds = readCredentials();
  for (const f of credentialFields()) {
    if (!(f.env in input)) continue;
    const v = String(input[f.env] ?? '').trim();
    if (v) creds[f.env] = v; else delete creds[f.env];
    // Apply immediately, overwriting whatever was live — this IS the operator
    // changing the answer, so the environment must not win here.
    if (v) process.env[f.env] = v; else delete process.env[f.env];
  }
  const p = FILE();
  writeFileSync(p, JSON.stringify(creds, null, 2), 'utf8');
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
  return creds;
}

/** Settings needs to show WHICH tokens are set without ever echoing them. */
export function credentialStatus() {
  const creds = readCredentials();
  return credentialFields().map((f) => {
    const v = String(process.env[f.env] || creds[f.env] || '').trim();
    return {
      id: f.id,
      label: f.label,
      env: f.env,
      required: f.required,
      set: !!v,
      hint: v ? `••••${v.slice(-4)}` : '',
      fromEnvironment: !!process.env[f.env] && !creds[f.env],
    };
  });
}
