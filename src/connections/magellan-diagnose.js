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

const RULES = [
  {
    code: 'gologin_extension_cache',
    match: /Cr24|crxToZip|extensions-manager/i,
    what: 'The browser never opened',
    why: "GoLogin's cached copy of a Chrome extension is corrupt.",
    fix: 'Quit GoLogin, delete the extensions cache folder, then retry. It re-downloads on the next launch.',
    retryable: true,
  },
  {
    code: 'profile_missing',
    match: /profile not found|no such profile|404/i,
    what: 'The browser never opened',
    why: 'GoLogin has no profile with this id — it was probably deleted or moved to another workspace.',
    fix: 'Check the account still exists in GoLogin, then refresh the account list.',
    retryable: false,
  },
  {
    code: 'gologin_unreachable',
    match: /ECONNREFUSED|ENOTFOUND|socket hang up|network|fetch failed/i,
    what: 'The browser never opened',
    why: 'Could not reach GoLogin.',
    fix: 'Check GoLogin is running and you are online, then retry.',
    retryable: true,
  },
  {
    code: 'launch_timeout',
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
 * @returns {{code:string, what:string, why:string, fix:string, retryable:boolean, raw:string}}
 */
export function diagnose(err) {
  const raw = String((err && err.message) || err || '').trim();
  for (const r of RULES) {
    if (r.match.test(raw)) {
      const { match, ...rest } = r;
      return { ...rest, raw };
    }
  }
  return {
    code: 'unknown',
    what: "The account didn't finish",
    why: raw || 'No reason was reported.',
    fix: 'Retry it. If it keeps happening, send this line to Antonio.',
    retryable: true,
    raw,
  };
}

/** One-line log entry. Reads like the campaign log's own lines. */
export function logLine(account, d) {
  return `✗ ${account}: ${d.what} — ${d.why} ${d.fix}`;
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
