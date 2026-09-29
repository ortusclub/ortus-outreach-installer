/**
 * src/engine-target.js — choose which cloud engine the app talks to: prod or dev.
 *
 * Both engines have FIXED public URLs (scraper-engine-url.js: SCRAPER_ENGINE_URL,
 * DEV_ENGINE_URL) and share one token, so the toggle is a plain Prod/Dev choice —
 * nothing to type. Resolution precedence (highest first):
 *   1. SCRAPER_ENGINE_URL env var — the explicit dev/CI override, unchanged
 *      (still lets you point at a port-forward / localhost by hand).
 *   2. the stored { engine } choice (this feature).
 *   3. prod default.
 *
 * Applied live: scraper-client + campaigns-client resolve per request, so a
 * switch takes effect on the next call — no restart. Per-operator, on-machine.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dataPath } from './paths.js';
import { SCRAPER_ENGINE_URL, SCRAPER_ENGINE_TOKEN, DEV_ENGINE_URL } from './scraper-engine-url.js';

const FILE = () => dataPath('engine-target.json');
const strip = (u) => String(u || '').trim().replace(/\/+$/, '');
export const PROD_URL = strip(SCRAPER_ENGINE_URL);
export const DEV_URL = strip(DEV_ENGINE_URL);
export const DEV_TOKEN = SCRAPER_ENGINE_TOKEN; // dev uses the same shared token as prod

/** The stored choice: { engine: 'prod' | 'dev' }. */
export function readEngineTarget() {
  try {
    const p = FILE();
    if (!existsSync(p)) return { engine: 'prod' };
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return { engine: parsed && parsed.engine === 'dev' ? 'dev' : 'prod' };
  } catch (err) {
    console.warn(`[engine-target] could not read: ${err.message}`);
    return { engine: 'prod' };
  }
}

/** Persist the choice atomically (tmp+rename, 0600), like gologin-credentials. */
export function saveEngineTarget(next = {}) {
  const t = { engine: next.engine === 'dev' ? 'dev' : 'prod' };
  const p = FILE();
  writeFileSync(`${p}.tmp`, JSON.stringify(t, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return t;
}

/**
 * The engine every scraper/campaign call resolves to right now.
 * @returns {{ url: string, token: string, environment: 'production'|'development', source: 'env'|'stored'|'default' }}
 */
export function resolveEngine(env = process.env, stored = readEngineTarget()) {
  // 1. explicit env override — unchanged behaviour, always wins.
  const envUrl = strip(env.SCRAPER_ENGINE_URL);
  if (envUrl) {
    return {
      url: envUrl,
      token: env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN,
      environment: envUrl === PROD_URL ? 'production' : 'development',
      source: 'env',
    };
  }
  // 2. stored dev choice → the fixed dev engine.
  if (stored.engine === 'dev' && DEV_URL) {
    return { url: DEV_URL, token: DEV_TOKEN, environment: 'development', source: 'stored' };
  }
  // 3. prod default.
  return { url: PROD_URL, token: SCRAPER_ENGINE_TOKEN, environment: 'production', source: 'default' };
}

export function resolvedEngineUrl() { return resolveEngine().url; }
export function resolvedEngineToken() { return resolveEngine().token; }

/** True when a SCRAPER_ENGINE_URL env var is pinning the target (toggle disabled). */
export function engineTargetLockedByEnv(env = process.env) {
  return !!strip(env.SCRAPER_ENGINE_URL);
}
