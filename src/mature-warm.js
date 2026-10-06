// Linked Velocity account identities for Mature Profile campaigns.
//
// The SoO only lists Ortus accounts, so the LinkedIn name and URL of a Linked
// Velocity profile come from Linked Velocity's own read-only feed (name, URL,
// GoLogin profile id and login email only — no credentials).

const DEFAULT_URL = 'https://linkedvelocity.com/api/outreach/accounts';
const TTL_MS = 10 * 60 * 1000;
let cache = null; // { at, accounts }

export function lvAccountsConfigured() {
  return !!String(process.env.LV_ACCOUNTS_KEY || '').trim();
}

/** Linked Velocity accounts, cached for ten minutes. Throws with a plain reason. */
export async function fetchLvAccounts({ force = false, fetchImpl = fetch } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.accounts;
  const key = String(process.env.LV_ACCOUNTS_KEY || '').trim();
  if (!key) throw new Error('The Linked Velocity account list is not set up on this build (LV_ACCOUNTS_KEY).');
  const url = String(process.env.LV_ACCOUNTS_URL || '').trim() || DEFAULT_URL;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.accounts)) {
    throw new Error(`Could not load the Linked Velocity account list (HTTP ${response.status}).`);
  }
  cache = { at: Date.now(), accounts: data.accounts };
  return cache.accounts;
}

export function _resetLvAccountsCache() { cache = null; }
