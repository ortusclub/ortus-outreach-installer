import { credentialFields } from './gologin-credentials.js';
import { tokenForAccount } from './gologin-accounts.js';
import { resolveEngine } from './engine-target.js';

// The authenticated desktop operator selects a saved workspace, never supplies
// credentials in the request. The engine validates ownership and token health,
// and requires confirmation before replacing a working shared connection.
export async function pushSavedGoLoginToken({ workspace, confirmReplaceLive = false, operatorEmail }, deps = {}) {
  if (!operatorEmail) return { status: 401, body: { ok: false, error: 'Sign in before updating the cloud connection.' } };
  const fields = (deps.credentialFields || credentialFields)();
  if (!fields.some(f => f.id === workspace)) return { status: 400, body: { ok: false, error: 'unknown workspace' } };
  const token = (deps.tokenForAccount || tokenForAccount)(workspace);
  if (!token) return { status: 400, body: { ok: false, reason: 'no token saved for this workspace' } };
  const engine = (deps.resolveEngine || resolveEngine)();
  try {
    const response = await (deps.fetch || fetch)(`${engine.url}/api/gologin-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.token}`, 'x-operator': operatorEmail },
      body: JSON.stringify({ workspace, token, confirmReplaceLive: confirmReplaceLive === true }),
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => ({}));
    return { status: 200, body: { environment: engine.environment, httpStatus: response.status, ...body } };
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
    return { status: 502, body: { ok: false, environment: engine.environment,
      reason: timeout ? 'the engine did not respond' : 'engine unreachable' } };
  }
}
