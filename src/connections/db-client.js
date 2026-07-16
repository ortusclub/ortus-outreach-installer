// Local-or-central bridge for the DB-backed connections reads.
//
// The connections DB (data/connections/* + data/connections-cache.json, ~152MB)
// lives ONLY on the machine that ingested it (Antonio's). It is gitignored AND
// excluded from the DMG, so every other operator has no local DB. dbCall() runs
// the read locally when the DB is present and otherwise delegates to the central
// roster service (services/fg-roster), which runs THIS SAME search-service code.
// One copy of the match logic — no drift.
import * as searchService from './search-service.js';
import { hasLocalDb } from './search-service.js';
import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from '../fg-roster-url.js';

// The only functions the central /rpc will run — pure reads over the DB.
export const ROSTER_FNS = [
  'listFgColleaguesMatched',
  'getConnectionsStats',
  'searchConnections',
  'exportConnections',
  'buildLeadRows',
];

// Whitelist guard + call. The service's trust boundary: an untrusted `fn` never
// reaches the impl.
export function rpcDispatch(fn, args, impl) {
  if (!ROSTER_FNS.includes(fn)) throw new Error(`unknown roster fn: ${fn}`);
  return impl[fn](...(args || []));
}

// Run a whitelisted read locally (DB present) or against the central service.
// Fail-closed: a non-2xx central response throws — callers surface their existing
// "try again" error rather than a silent-empty result.
export async function dbCall(fn, args, {
  hasLocal = hasLocalDb,
  local = searchService,
  rosterUrl = FG_ROSTER_URL,
  rosterToken = FG_ROSTER_TOKEN,
  fetchImpl = fetch,
  timeoutMs = 30000,
} = {}) {
  if (hasLocal()) return local[fn](...(args || []));
  // Fail-fast on a WEDGED service: without a timeout a hung roster pod would spin
  // the operator's picker forever instead of surfacing "try again". 30s clears the
  // first-request cold annotate over the 152MB DB. Abort → throw → fail-closed.
  const r = await fetchImpl(`${rosterUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rosterToken}` },
    body: JSON.stringify({ fn, args: args || [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`roster ${fn} failed: ${r.status}`);
  const j = await r.json();
  return j.result;
}
