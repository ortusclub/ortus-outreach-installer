// Every way an import row can fail, said in the words the people who fix it
// actually use. HubSpot answers in status codes and vids; Abygael works in
// "this person is in the system twice". This module is the translation, and it
// is the only place that translation lives.
//
// Same shape and same rules as magellan-diagnose.js, which does this for the
// collect half: the raw text is ALWAYS carried through, because the day the
// explanation is wrong the raw line is the only thing that says so.

const RULES = [
  {
    code: 'duplicate_contact',
    // "Email X is associated with a different vid 33062650786"
    match: /associated with a different vid\s*(\d+)/i,
    what: 'This person is in HubSpot twice',
    why: (m) => 'Their LinkedIn address is already on another contact record — '
      + `contact ${m[1]} — so it cannot be put on this one as well. HubSpot allows `
      + 'one email address on one person only.',
    fix: (m) => `Open contact ${m[1]} in HubSpot, and the record we just updated, and merge `
      + 'them (Actions → Merge). Their connection has been recorded either way — only the '
      + 'extra email address was skipped.',
  },
  {
    code: 'email_taken',
    match: /\b409\b|already has that email|EMAIL_EXISTS/i,
    what: 'That email address is already used by someone else',
    why: () => 'HubSpot keeps one email address to one contact. Another record already has it.',
    fix: () => 'Find who holds the address in HubSpot. If it is the same person twice, merge them; '
      + 'if it is genuinely someone else, leave it — their connection is still recorded.',
  },
  {
    code: 'not_an_option',
    match: /not one of the allowed|PROPERTY_DOESNT_EXIST|enumeration|invalid option/i,
    what: 'This account is not on the "Linkedin 1st Connections" list',
    why: () => 'That field only accepts Ortus account emails that have been added to it as options. '
      + 'This account is not one of them, so its connections cannot be marked.',
    fix: () => 'Add the account email as an option on the Linkedin 1st Connections property in '
      + 'HubSpot, then run the import for that account again.',
  },
  {
    code: 'rate_limited',
    match: /\b429\b|rate limit|too many requests/i,
    what: 'HubSpot asked us to slow down',
    why: () => 'Too many calls in a short window. The import retries on its own, so this only '
      + 'appears when the retries were used up too.',
    fix: () => 'Run this account again in a few minutes. Nothing was lost — people already written '
      + 'are skipped on the second run.',
  },
  {
    code: 'not_allowed',
    match: /\b403\b|scopes|forbidden/i,
    what: 'The app is not allowed to do this',
    why: () => 'The HubSpot key is missing a permission it needs for this call.',
    fix: () => 'In HubSpot → Settings → Integrations → Private Apps, open the Ortus app and tick the '
      + 'missing scope, then run the import again.',
  },
  {
    code: 'bad_key',
    match: /\b401\b|unauthorized|invalid token/i,
    what: 'HubSpot did not accept the key',
    why: () => 'The key in the app is wrong, expired, or was rotated.',
    fix: () => 'Get a fresh key from HubSpot → Settings → Integrations → Private Apps and put it in '
      + 'the app\'s .env as HUBSPOT_TOKEN.',
  },
  {
    code: 'hubspot_down',
    match: /\b5\d\d\b|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i,
    what: 'HubSpot did not answer',
    why: () => 'A network or HubSpot-side failure, not something in the data.',
    fix: () => 'Run this account again. People already written are skipped, so a repeat run is safe.',
  },
];

/**
 * Turn one import failure into something a person can act on.
 * Unrecognised failures are NOT dressed up — they say so, and carry the raw
 * text, which is what makes a wrong explanation visible.
 *
 * @param {string} raw   HubSpot's own words
 * @param {{stage?: string}} ctx  which call failed: create | update | email
 */
export function explainProblem(raw, { stage = '' } = {}) {
  const text = String(raw || '');
  for (const rule of RULES) {
    const m = rule.match.exec(text);
    if (!m) continue;
    return {
      code: rule.code,
      what: rule.what,
      why: rule.why(m),
      fix: rule.fix(m),
      stage,
      raw: text,
    };
  }
  return {
    code: 'unknown',
    what: 'Something HubSpot would not accept',
    why: 'This one is not a failure we recognise, so the message below is HubSpot\'s own, unedited.',
    fix: 'Send this line to Antonio. The people in this account are unaffected unless the log says otherwise.',
    stage,
    raw: text,
  };
}

/** One log line: what happened, then what to do, then the raw text. */
export function problemLine(account, p) {
  return `⚠ ${account}: ${p.what} — ${p.fix} [${p.raw}]`;
}

/**
 * The end-of-run roll-up. A hundred identical 409s are one job to do, not a
 * hundred, so group by cause and count.
 *
 * @param {Array<{account: string, stage?: string, error: string}>} errors
 */
export function summariseProblems(errors) {
  const byCode = new Map();
  for (const e of errors || []) {
    const p = explainProblem(e.error, { stage: e.stage });
    const hit = byCode.get(p.code) || { code: p.code, what: p.what, fix: p.fix, count: 0, accounts: new Set() };
    hit.count += 1;
    if (e.account) hit.accounts.add(e.account);
    byCode.set(p.code, hit);
  }
  return [...byCode.values()]
    .map((h) => ({ ...h, accounts: [...h.accounts] }))
    .sort((a, b) => b.count - a.count);
}
