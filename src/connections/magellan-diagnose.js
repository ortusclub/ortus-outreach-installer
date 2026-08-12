// Turn a raw error into something an operator can act on.
//
// At 300+ accounts most of the work is understanding failures, not successes.
// A stack trace ending in "Invalid header: Does not start with Cr24" tells the
// operator nothing; "GoLogin's extension cache is corrupt — clear it" tells
// them exactly what to do. Every entry answers three questions: what happened,
// why, and what to do about it.
//
// Codes are stable strings so the UI can group by them and the log stays
// greppable.
//
// `phases` scopes a rule to the part of the account it can actually happen in:
// 'launch' (opening the browser) or 'read' (walking the connections list). A
// rule with no `phases` applies to both. Without this, a network-ish word in a
// Voyager error matched the GoLogin-unreachable rule and the operator was told
// "The browser never opened" one line after being told it had signed in.

const RULES = [
  // These two are raised by the sweep itself (magellan-run.js), not by the
  // browser, and they must come first: "stalled" would otherwise fall through
  // to the generic unknown rule and be marked retryable, buying a dead browser
  // another full stall window.
  {
    code: 'stopped_by_operator',
    match: /^stopped-by-operator/,
    what: 'It was stopped',
    why: 'You pressed Stop while this account was being read.',
    fix: 'Nothing to fix — tick it again to collect it.',
    retryable: false,
  },
  {
    code: 'stalled',
    match: /^stalled:/,
    what: 'The account stopped responding',
    why: 'The browser went quiet mid-read — usually it was closed, crashed, or GoLogin ended the session.',
    fix: 'Check the profile opens in GoLogin, then tick this account again.',
    retryable: false,
  },
  {
    code: 'gologin_extension_cache',
    phases: ['launch'],
    match: /Cr24|crxToZip|extensions-manager/i,
    what: 'The browser never opened',
    why: "GoLogin's cached copy of a Chrome extension is corrupt.",
    fix: 'Quit GoLogin, delete the extensions cache folder, then retry. It re-downloads on the next launch.',
    retryable: true,
  },
  {
    code: 'profile_missing',
    phases: ['launch'],
    match: /profile not found|no such profile|404/i,
    what: 'The browser never opened',
    why: 'GoLogin has no profile with this id — it was probably deleted or moved to another workspace.',
    fix: 'Check the account still exists in GoLogin, then refresh the account list.',
    retryable: false,
  },
  {
    // ECONNREFUSED on a loopback port is NOT "GoLogin is unreachable" — that
    // port is the browser's own debugging port on this machine. GoLogin
    // answered; the browser it started refused the connection or was gone by
    // the time we knocked.
    code: 'browser_died_on_start',
    phases: ['launch'],
    match: /ECONNREFUSED\s+(127\.0\.0\.1|localhost|::1)/i,
    what: 'The browser started and died immediately',
    why: 'GoLogin answered, but the browser it launched was already gone when we connected to it. Usually the profile belongs to a different GoLogin account than the one this app is signed in with, or it is already open somewhere else.',
    fix: 'Open this profile in GoLogin by hand. If it is not in the same GoLogin account as the app, it cannot be collected from here. If it opens fine, close it and retry.',
    retryable: true,
  },
  {
    code: 'gologin_unreachable',
    phases: ['launch'],
    match: /ECONNREFUSED|ENOTFOUND|socket hang up|network|fetch failed/i,
    what: 'The browser never opened',
    why: 'Could not reach GoLogin.',
    fix: 'Check GoLogin is running and you are online, then retry.',
    retryable: true,
  },
  {
    code: 'launch_timeout',
    phases: ['launch'],
    match: /timeout|timed out|Navigation/i,
    what: 'The browser opened but never got going',
    why: 'LinkedIn or the browser took too long to respond.',
    fix: 'Usually a slow machine or connection. Retry — it often works second time.',
    retryable: true,
  },
  {
    code: 'not_logged_in',
    match: /no-csrf|login|authwall|checkpoint/i,
    what: 'The account is not signed in to LinkedIn',
    why: 'The session has expired, or LinkedIn is asking for a security check.',
    fix: 'Open this account in GoLogin by hand, sign in, clear any checkpoint, then retry.',
    retryable: false,
  },
  {
    code: 'rate_limited',
    match: /http-429|429/,
    what: 'LinkedIn refused to hand over the list',
    why: 'Too many requests from this account — LinkedIn is throttling it.',
    fix: 'Leave this account for a few hours and collect it later. The others are unaffected.',
    retryable: true,
  },
  {
    code: 'linkedin_blocked',
    match: /http-999|999|restricted|blocked/i,
    what: 'LinkedIn refused to hand over the list',
    why: 'LinkedIn has restricted this account.',
    fix: 'Nothing to do here — the account has to be unblocked in LinkedIn first.',
    retryable: false,
  },
  {
    code: 'endpoint_changed',
    match: /no-endpoint-ok|empty-after-3-strategies/i,
    what: 'The connections list came back empty',
    why: "LinkedIn's connections page did not return data in any shape we recognise. Either this account genuinely has no connections, or LinkedIn changed the page.",
    fix: 'Open the account and check it has connections. If it does, this needs a developer.',
    retryable: false,
  },
  {
    code: 'browser_closed',
    match: /Target closed|Session closed|browser has disconnected|Protocol error/i,
    what: 'The browser closed part-way through',
    why: 'The browser window was closed, or it crashed.',
    fix: "Don't close the browser while a collection is running. Retry this account.",
    retryable: true,
  },
];

/**
 * @param {Error|string} err
 * @param {{phase?: 'launch'|'read'}} [opts] which part of the account failed
 * @returns {{code:string, what:string, why:string, fix:string, retryable:boolean, raw:string}}
 */
export function diagnose(err, { phase = null } = {}) {
  const raw = String((err && err.message) || err || '').trim();
  for (const r of RULES) {
    if (phase && r.phases && !r.phases.includes(phase)) continue;
    if (r.match.test(raw)) {
      const { match, phases, ...rest } = r;
      return { ...rest, raw };
    }
  }
  return {
    code: 'unknown',
    what: phase === 'read' ? 'The connections list could not be read' : "The account didn't finish",
    why: raw || 'No reason was reported.',
    fix: 'Retry it. If it keeps happening, send this line to Antonio.',
    retryable: true,
    raw,
  };
}

/**
 * One-line log entry. Reads like the campaign log's own lines, and always ends
 * with the raw error — when the explanation is wrong, that raw text is the only
 * thing that says so.
 */
export function logLine(account, d) {
  const line = `✗ ${account}: ${d.what} — ${d.why} ${d.fix}`;
  return d.raw && !line.includes(d.raw) ? `${line} [${d.raw}]` : line;
}

/** Group finished accounts by failure code so 300 rows collapse to a few causes. */
export function summarise(perAccount = []) {
  const byCode = new Map();
  for (const a of perAccount) {
    if (!a || !a.error) continue;
    const code = (a.diagnosis && a.diagnosis.code) || 'unknown';
    if (!byCode.has(code)) {
      byCode.set(code, { code, count: 0, accounts: [], ...(a.diagnosis || {}) });
    }
    const g = byCode.get(code);
    g.count += 1;
    if (g.accounts.length < 20) g.accounts.push(a.account);
  }
  return [...byCode.values()].sort((x, y) => y.count - x.count);
}
