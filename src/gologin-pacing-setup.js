import policy from './gologin-request-policy.cjs';
import admissionClient from './gologin-admission-client.cjs';
import { SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';
import { appendFileSync, statSync } from 'node:fs';
import { dataPath } from './paths.js';

let configured = false;
export function setupPacing() {
  if (configured || process.env.GOLOGIN_REQUEST_PACING !== '1') return;
  // No production fallback. This desktop pilot uses the explicit PR-19 tunnel.
  const base = new URL(process.env.SCRAPER_ENGINE_URL || 'invalid:');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) ||
      base.port !== '3119' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('GoLogin pacing requires the explicit isolated PR-19 tunnel at http://127.0.0.1:3119');
  }
  async function call(action, body, signal) {
    const response = await fetch(new URL(`/api/gologin/admission/${action}`, base), {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = admissionClient.admissionError('PR-19 coordinator is unavailable');
      error.coordinatorHttpStatus = response.status;
      throw error;
    }
    const result = await response.json();
    if (result.namespace !== 'preview-pr-19' || result.scope !== 'pilot-fleet') {
      const error = admissionClient.admissionError('Coordinator identity does not match isolated PR-19');
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
