/**
 * GoLogin accounts registry — the app talks to MORE THAN ONE GoLogin account.
 *
 * Until 2026-08-07 there was exactly one: a single `GOLOGIN_API_TOKEN` read
 * straight out of the environment at ~30 call sites, with nothing anywhere
 * recording which account a profile came from. Linked Velocity is a separate
 * GoLogin plan whose profiles cannot be shared into the Ortus workspace, so
 * "which account owns this profile" had to become a real, tracked fact.
 *
 * The model, deliberately kept small:
 *   - Accounts are declared HERE, hard-coded, exactly like the sheet config in
 *     sheets-webapp-url.js — every operator's build must agree on the roster.
 *     Only the secrets come from the environment.
 *   - A profile belongs to whichever account's API listed it
 *     (see gologin-launcher.getProfiles, which tags every profile).
 *   - An OPERATOR belongs to whichever account matches their login email
 *     domain. That is the whole access rule: an @ortusclub.com login can use
 *     Ortus profiles, an @linkedvelocity.com login can use Linked Velocity
 *     profiles. Everyone still SEES both — the other account's profiles render
 *     in the picker marked unavailable, so the roster stays legible to all.
 *
 * There is no runtime switcher and no per-operator override. Domain is the
 * single source of truth precisely because it cannot be silently mis-set: a
 * shared server with two operators signed in at once still resolves each one's
 * account correctly, which a global "active account" toggle could not.
 */

// Hard-coded roster. `env` names the variable holding that account's API
// token; an account with no token configured is simply absent at runtime
// (see configuredAccounts) — the app degrades to whatever IS configured
// rather than erroring, so a build shipped before the Linked Velocity token
// exists behaves exactly like the old single-account app.
// A pseudo-mode for Post Amplification. It is not a campaign mode — it runs
// through /api/post-amplification/start, not the campaign wizard — but the
// account rules have to talk about it, so it gets a name alongside the real
// modes rather than a parallel boolean.
export const POST_AMPLIFICATION_MODE = 'post_amplification';

export const GL_ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'ortus',
    label: 'Ortus',
    env: 'GOLOGIN_API_TOKEN',
    domains: Object.freeze(['ortusclub.com', 'ortus.solutions']),
    modes: null,      // no restriction — every mode
    openToAll: false, // domain-gated
  }),
  Object.freeze({
    id: 'linkedvelocity',
    label: 'Linked Velocity',
    env: 'GOLOGIN_API_TOKEN_LINKEDVELOCITY',
    domains: Object.freeze(['linkedvelocity.com']),
    modes: null,
    openToAll: false,
  }),
  // The marketing team's workspace (added 2026-08-07). Unlike the other two, it
  // is restricted by WHAT it may do rather than WHO owns it (operator decision:
  // "it's okay if others who are not marketing people use those accounts"):
  //
  //   openToAll: true  → no domain gate. Any operator may drive these accounts.
  //                      They claim no email domain, so nobody ever resolves
  //                      INTO this workspace either — it is never somebody's
  //                      "own" account set, just a shared pool.
  //   modes: [...]     → the only protection, and it holds against everyone:
  //                      these accounts refuse every mode except Follower
  //                      Growth and Post Amplification.
  Object.freeze({
    id: 'marketing',
    label: 'Marketing',
    env: 'GOLOGIN_API_TOKEN_MARKETING',
    domains: Object.freeze([]),
    modes: Object.freeze(['follower_growth', POST_AMPLIFICATION_MODE]),
    openToAll: true,
  }),
]);

// The account every unknown domain falls back to, and the account whose token
// keeps the legacy `process.env.GOLOGIN_API_TOKEN` meaning. Must stay 'ortus':
// falling back to a DIFFERENT account would hand an unrecognised login the
// wrong workspace instead of the one it has always had.
export const DEFAULT_ACCOUNT_ID = 'ortus';

export function accountById(id) {
  return GL_ACCOUNTS.find((a) => a.id === id) || null;
}

export function accountLabel(id) {
  const acc = accountById(id);
  return acc ? acc.label : String(id || '');
}

/**
 * The token for an account, read from the environment at CALL time — never
 * cached. dotenv loads late in some entry points and the Electron wrapper
 * rewrites the environment before importing the server; a token captured at
 * module load would be stale or empty in both cases.
 */
export function tokenForAccount(id) {
  const acc = accountById(id);
  if (!acc) return '';
  return process.env[acc.env] || '';
}

/**
 * Accounts that actually have a token right now. Everything that enumerates
 * accounts goes through this, so an unconfigured second account costs exactly
 * one skipped iteration rather than a failed API call per refresh.
 */
export function configuredAccounts() {
  return GL_ACCOUNTS.filter((a) => !!tokenForAccount(a.id));
}

/**
 * Which GoLogin account an operator's login email grants access to.
 * Unknown/blank domains get the default account — the pre-2026-08-07
 * behaviour for every existing login.
 */
export function accountForEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (!domain) return DEFAULT_ACCOUNT_ID;
  const hit = GL_ACCOUNTS.find((a) => a.domains.includes(domain));
  return hit ? hit.id : DEFAULT_ACCOUNT_ID;
}

/**
 * Per-profile grants — the escape hatch the domain rule deliberately lacks.
 *
 * The domain gate is right for the roster as a whole and wrong for the handful
 * of accounts two workspaces genuinely share (2026-08-17: milee.mel and
 * matt.adcock, owned by Ortus, driven by Linked Velocity). GoLogin's own
 * profile-sharing cannot express this — a shared profile still tags its owning
 * workspace (see getProfiles' first-wins rule), which is exactly what keeps a
 * shared profile out of the marketing mode restriction and must not change.
 *
 * So the grant lives beside the token it overrides, in the environment:
 *
 *   GOLOGIN_PROFILE_GRANTS=linkedvelocity:686696205c3c6094e10f461c,linkedvelocity:686698b83d9568f25c44b0fe
 *
 * Read at call time, never cached, for the same reason tokenForAccount is: the
 * Electron wrapper rewrites the environment before importing the server.
 *
 * A grant widens WHO may drive a profile. It never changes who OWNS it, so
 * tokenForProfile still hands the launcher the owning workspace's token and a
 * granted profile still answers to its owner's mode rules.
 */
export function grantsForProfile(profileId) {
  const id = String(profileId || '').trim();
  if (!id) return [];
  const out = [];
  for (const entry of String(process.env.GOLOGIN_PROFILE_GRANTS || '').split(/[,\s]+/)) {
    const [accId, profId] = entry.split(':');
    if (!accId || !profId) continue;
    if (profId.trim() === id) out.push(accId.trim().toLowerCase());
  }
  return out;
}

/**
 * The access rule in one place, so the picker's greying, the launch guard and
 * any future caller can never disagree about it.
 *
 * A profile with no recorded account is treated as the default account's —
 * that is what every profile was before this file existed.
 *
 * `profileId` is optional only so the pre-grant call signature keeps working;
 * a caller that omits it simply cannot benefit from a grant.
 */
export function canOperatorUseProfile(email, profileAccountId, profileId) {
  const id = profileAccountId || DEFAULT_ACCOUNT_ID;
  const acc = accountById(id);
  if (acc && acc.openToAll) return true;
  const mine = accountForEmail(email);
  if (mine === id) return true;
  return grantsForProfile(profileId).includes(mine);
}

/**
 * The modes an account is allowed to run, or null when it is unrestricted.
 * Returned to the client so the picker can grey a tile the moment the operator
 * switches campaign type, without another round trip.
 */
export function accountModes(profileAccountId) {
  const acc = accountById(profileAccountId || DEFAULT_ACCOUNT_ID);
  return (acc && acc.modes) ? acc.modes.slice() : null;
}

/**
 * Whether an account may run this mode. An account with no `modes` list runs
 * everything, which is every workspace except marketing.
 *
 * A blank mode answers true deliberately: callers that have no mode in hand
 * (the account list, a status poll) must not be told the account is unusable.
 * The launch endpoints always pass a real mode, and they are the ones that
 * matter.
 */
export function accountAllowsMode(profileAccountId, mode) {
  const modes = accountModes(profileAccountId);
  if (!modes) return true;
  if (!mode) return true;
  return modes.includes(mode);
}

/**
 * The single question the launch guards ask: may THIS operator run THIS mode on
 * an account from THIS workspace? Both axes in one place so a caller cannot
 * check one and forget the other.
 */
export function profileUsableFor(email, profileAccountId, mode, profileId) {
  return canOperatorUseProfile(email, profileAccountId, profileId) && accountAllowsMode(profileAccountId, mode);
}
