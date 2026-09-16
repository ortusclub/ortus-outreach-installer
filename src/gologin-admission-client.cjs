function admissionError(message) {
  return Object.assign(new Error(message), { provider: 'gologin', code: 'GOLOGIN_ADMISSION_UNAVAILABLE', retryable: false });
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(signal.reason || admissionError('GoLogin request cancelled'));
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function boundedCall(fn, ms, signal) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { controller.abort(signal.reason); finish(signal.reason || admissionError('Request cancelled')); };
    const timer = setTimeout(() => {
      const error = admissionError('GoLogin coordinator did not respond in time; request not dispatched.');
      error.coordinatorTimeout = true;
      controller.abort(error); finish(error);
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return fn(controller.signal);
    }).then(result => finish(null, result), error => finish(error));
  });
}
function createAdmissionClient({ reserve, cooldown, workspaceForToken, maxWaitMs = 30000,
  now = Date.now, wait = sleep, onWait = () => {}, onFailure = () => {} }) {
  return {
    async acquire({ token, signal, priority = 'ordinary' }) {
      const workspace = workspaceForToken(token);
      if (!workspace) throw admissionError('GoLogin workspace cannot be identified; request not dispatched.');
      const deadline = now() + maxWaitMs;
      let announced = false;
      while (true) {
        signal?.throwIfAborted();
        if (now() >= deadline) throw admissionError('GoLogin request allowance is still unavailable; request not dispatched.');
        let result;
        const started = now();
        try { result = await boundedCall(s => reserve({ workspace, priority }, s), Math.min(2000, deadline - now()), signal); }
        catch (error) {
          signal?.throwIfAborted();
          const status = Number(error?.coordinatorHttpStatus);
          const rawCode = error?.cause?.code || error?.code;
          const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(rawCode) ? rawCode : null;
          const kind = error?.coordinatorTimeout ? 'client_timeout'
            : Number.isInteger(status) && status >= 400 && status <= 599 ? 'http_error'
              : error?.coordinatorIdentityMismatch ? 'identity_mismatch'
                : error?.name === 'TypeError' ? 'transport_error' : 'other';
          try { onFailure({ action: 'reserve', workspace, kind, status: kind === 'http_error' ? status : null,
            code, elapsedMs: Math.max(0, now() - started) }); } catch {}
          throw admissionError('GoLogin request coordinator unavailable; request not dispatched.');
        }
        signal?.throwIfAborted();
        if (now() >= deadline) throw admissionError('GoLogin request allowance expired; request not dispatched.');
        if (result?.allowed === true) return;
        if (result?.allowed !== false || !Number.isFinite(result.waitMs) || result.waitMs < 0) {
          throw admissionError('Invalid coordinator reply; GoLogin request not dispatched.');
        }
        if (!announced) { try { onWait(result.reason); } catch {} announced = true; }
        const remaining = deadline - now();
        if (remaining <= 0) throw admissionError('GoLogin request allowance is still unavailable; preparation stopped safely. Try again later.');
        await wait(Math.min(remaining, Math.max(25, result.waitMs) + 25), signal);
      }
    },
    async limited({ token, retryAfterMs }) {
      const workspace = workspaceForToken(token);
      if (!workspace) return;
      // No header means an explicit conservative pilot cooldown, not a claim
      // about the provider's recovery period or token validity.
      const delayMs = Number.isFinite(retryAfterMs) ? Math.min(7 * 86400000, Math.max(1000, retryAfterMs)) : 60000;
      await boundedCall(signal => cooldown({ workspace, delayMs }, signal), 2000);
    },
  };
}
module.exports = { createAdmissionClient, admissionError };
