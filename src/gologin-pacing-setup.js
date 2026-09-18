import policy from './gologin-request-policy.cjs';
import admissionClient from './gologin-admission-client.cjs';
import { SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';
import { appendFileSync, statSync } from 'node:fs';
import { dataPath } from './paths.js';

let configured = false;
const PREVIEW_PORTS = Object.freeze({ '19': '3119', '40': '3140' });

export function pacingTarget(env = process.env) {
  const previewPr = String(env.ORTUS_PREVIEW_PR || '');
  const expectedPort = PREVIEW_PORTS[previewPr];
  let base;
  try { base = new URL(env.SCRAPER_ENGINE_URL || 'invalid:'); } catch { /* invalid target */ }
  if (env.ORTUS_ENGINE_ENVIRONMENT !== 'preview' || !expectedPort || !base ||
      base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) ||
      base.port !== expectedPort || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('GoLogin pacing requires the matching isolated PR-19:3119 or DEV-40:3140 preview tunnel');
  }
  return { base, namespace: `preview-pr-${previewPr}` };
}

export function setupPacing() {
  if (configured || process.env.GOLOGIN_REQUEST_PACING !== '1') return;
  const { base, namespace } = pacingTarget();
  async function call(action, body, signal) {
    const response = await fetch(new URL(`/api/gologin/admission/${action}`, base), {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = admissionClient.admissionError('Preview coordinator is unavailable');
      error.coordinatorHttpStatus = response.status;
      throw error;
    }
    const result = await response.json();
    if (result.namespace !== namespace || result.scope !== 'pilot-fleet') {
      const error = admissionClient.admissionError('Coordinator identity does not match isolated preview');
      error.coordinatorIdentityMismatch = true;
      throw error;
    }
    return result;
  }
  policy.configureAdmission(admissionClient.createAdmissionClient({
    reserve: (body, signal) => call('reserve', body, signal),
    cooldown: (body, signal) => call('cooldown', body, signal),
    workspaceForToken: token => token && token === process.env.GOLOGIN_API_TOKEN ? 'ortus'
      : token && token === process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY ? 'linkedvelocity' : null,
    onWait: reason => console.info(`[gologin-request] Waiting for shared request allowance (${reason})`),
    onFailure: detail => {
      const line = JSON.stringify({ at: new Date().toISOString(), ...detail });
      console.warn('[gologin-admission-diagnostic]', line);
      try {
        const file = dataPath('gologin-admission-diagnostics.ndjson');
        if ((statSync(file, { throwIfNoEntry: false })?.size || 0) < 512 * 1024) appendFileSync(file, line + '\n');
      } catch { /* diagnostics must never affect request safety */ }
    },
  }));
  configured = true;
}
