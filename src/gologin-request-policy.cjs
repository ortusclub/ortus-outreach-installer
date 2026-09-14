// Narrow adapter for the public Request constructor seam in requestretry 4.1.2.
// No node_modules edits, global fetch interception, or LinkedIn/CDP retry changes.
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const INSTALLED = Symbol.for('ortus.gologin-request-policy.v1');
const { AsyncLocalStorage } = require('node:async_hooks');
const contexts = new AsyncLocalStorage();
let admission = null;
function configureAdmission(client) { admission = client; }
function withRequestContext(context, fn) { return contexts.run(context, fn); }
function tokenFrom(headers = {}) {
  const value = typeof headers.get === 'function' ? headers.get('authorization')
    : Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  return String(value || '').replace(/^Bearer /, '') || contexts.getStore()?.token;
}
async function pacedFetch(url, options = {}) {
  if (!/(^|\.)gologin\.(com|co)$/.test(new URL(url).hostname)) return fetch(url, options);
  const client = admission;
  const token = tokenFrom(options.headers);
  const signal = options.signal || contexts.getStore()?.signal;
  if (client) await client.acquire({ token, signal });
  signal?.throwIfAborted();
  const response = await fetch(url, { ...options, signal });
  if (client && response.status === 429) {
    const error = providerError(429, response.headers);
    await client.limited({ token, retryAfterMs: error.retryAfterMs }).catch(() => {});
  }
  return response;
}

function providerError(status, headers = {}, body = '') {
  const cloudflare = typeof body === 'string' && /(?:error code[:\s]*1015|rate limited.*cloudflare)/i.test(body);
  const kind = status === 429 || cloudflare ? 'rate_limit'
    : status === 401 || status === 403 ? 'access'
      : status >= 500 ? 'unavailable' : 'request_rejected';
  const detail = kind === 'rate_limit' ? 'GoLogin is limiting requests; do not repeatedly reopen the profile.'
    : kind === 'access' ? 'GoLogin access was refused; check workspace permissions and API credentials. This is not a LinkedIn logout.'
      : kind === 'unavailable' ? 'GoLogin is temporarily unavailable.' : 'GoLogin rejected the request.';
  const error = new Error(`GoLogin HTTP ${status}: ${detail}`);
  error.name = 'GoLoginRequestError';
  error.provider = 'gologin';
  error.code = `GOLOGIN_${kind.toUpperCase()}`;
  error.statusCode = status;
  error.retryable = false; // caller must not blindly repeat the whole launch
  error.responseHeaders = {};
  for (const name of ['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    // Only numeric values / HTTP dates are useful here. Never retain arbitrary
    // bodies, cookies, Authorization headers, URLs or server-provided prose.
    if (value != null && (/^\d+(?:\.\d+)?$/.test(String(value)) ||
      (name === 'retry-after' && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(String(value))))) {
      error.responseHeaders[name] = String(value);
    }
  }
  const retryAfter = error.responseHeaders['retry-after'];
  if (retryAfter) error.retryAfterMs = /^\d/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
  return error;
}

function installRequestPolicy(factory, { sdkVersion, requestVersion, report = () => {} } = {}) {
  if (sdkVersion !== '2.2.8' || requestVersion !== '4.1.2') {
    throw new Error('GoLogin request policy requires reviewed SDK 2.2.8 / requestretry 4.1.2; verify versions before launching.');
  }
  if (factory[INSTALLED]) return;
  const Base = factory.Request;
  class ProviderRequest extends Base {
    constructor(url, options, callback, config) {
      super(url, options, callback, config);
      let host;
      try { host = new URL(this.options.url || this.options.uri).hostname; } catch { return; }
      const headers = this.options.headers || {};
      const agent = Object.entries(headers).find(([key]) => key.toLowerCase() === 'user-agent')?.[1];
      if (!/^gologin-nodejs-sdk\//.test(String(agent)) ||
        !/(^|\.)gologin\.(com|co)$/.test(host)) return;
      // Exactly one HTTP attempt: even a failed response to a write can follow
      // a successful remote action. Scheduling subsequent work is a separate
      // decision, not an invisible request-library loop.
      this.maxAttempts = 1;
      this.retryStrategy = () => false;
      this.options.timeout ??= 30000;
      const method = String(this.options.method || 'GET').toUpperCase();
      const token = tokenFrom(headers);
      const client = admission;
      const contextSignal = contexts.getStore()?.signal;
      const pendingController = new AbortController();
      const onContextAbort = () => pendingController.abort(contextSignal.reason);
      contextSignal?.addEventListener('abort', onContextAbort, { once: true });
      if (contextSignal?.aborted) onContextAbort();
      // The SDK also has a secondary-domain fallback outside requestretry.
      // Reads can use it; writes must not be replayed after a lost response.
      if (host === 'api.gologin.co' && !['GET', 'HEAD'].includes(method)) {
        this._tryUntilFail = () => queueMicrotask(() => this.reply(Object.assign(
          new Error('GoLogin write outcome is unknown; automatic secondary-domain replay was blocked. Review before retrying.'),
          { provider: 'gologin', code: 'GOLOGIN_WRITE_OUTCOME_UNKNOWN', retryable: false },
        )));
      } else if (client) {
        const dispatch = this._tryUntilFail;
        this._tryUntilFail = () => {
          Promise.resolve().then(() => client.acquire({ token, signal: pendingController.signal,
            priority: /\/(?:upload|update_after_close)(?:[/?]|$)/.test(this.options.url || this.options.uri)
              ? 'maintenance' : 'ordinary',
          })).then(() => {
            pendingController.signal.throwIfAborted();
            dispatch.call(this);
          }).catch(error => this.reply(error));
        };
      }
      const abort = this.abort;
      this.abort = () => { pendingController.abort(new Error('GoLogin request cancelled')); return abort.call(this); };
      const started = Date.now();
      const reply = this.reply;
      let replied = false;
      this.reply = (error, response, body) => {
        if (replied) return;
        replied = true;
        contextSignal?.removeEventListener('abort', onContextAbort);
        const status = Number(response?.statusCode) || null;
        if (status >= 400) error = providerError(status, response.headers, response.body ?? body);
        else if (error && !error.provider && error.message !== 'Aborted' && !pendingController.signal.aborted) {
          const code = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)
            ? error.code : 'REQUEST_FAILED';
          error = Object.assign(new Error(
            `GoLogin connection failed (${code}); no automatic whole-launch retry. A remote write may have completed before the response was lost.`
          ), { provider: 'gologin', code: 'GOLOGIN_TRANSPORT_ERROR', retryable: false });
        }
        try { report({ provider: 'gologin', method: this.options.method || 'GET',
          host, status, durationMs: Date.now() - started, attempts: this.attempts,
          outcome: error ? 'failed' : 'ok' }); } catch { /* diagnostics never break requests */ }
        if (client && error?.code === 'GOLOGIN_RATE_LIMIT') {
          return Promise.resolve().then(() => client.limited({ token, retryAfterMs: error.retryAfterMs }))
            .catch(() => {}).then(() => reply.call(this, error, response, body));
        }
        return reply.call(this, error, response, body);
      };
    }
  }
  factory.Request = ProviderRequest;
  factory[INSTALLED] = true;
}

function packageInfo(entry) {
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot resolve GoLogin dependency version');
    dir = parent;
  }
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function installSdkRequestPolicy() {
  const sdkEntry = require.resolve('gologin');
  const sdkRequire = createRequire(sdkEntry);
  const factory = sdkRequire('requestretry');
  installRequestPolicy(factory, {
    sdkVersion: packageInfo(sdkEntry).version,
    requestVersion: packageInfo(sdkRequire.resolve('requestretry')).version,
    report(event) {
      if (event.outcome === 'failed' || process.env.GOLOGIN_REQUEST_DIAGNOSTICS === '1') {
        console.info('[gologin-request]', JSON.stringify(event));
      }
    },
  });
}
module.exports = { providerError, installRequestPolicy, installSdkRequestPolicy,
  configureAdmission, withRequestContext, pacedFetch };
