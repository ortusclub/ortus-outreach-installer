function lineOf(row) {
  return String(row && row.line != null ? row.line : row || '');
}

export function summarizeLatestMonitoringSweep(logs = [], expectedAccounts = []) {
  const lines = Array.isArray(logs) ? logs.map(lineOf) : [];
  let start = -1;
  lines.forEach((line, index) => {
    if (/\bCheck started\b/i.test(line)) start = index;
  });
  if (start < 0) return null;
  const run = lines.slice(start);
  const byAccount = new Map();
  const ensure = (email) => {
    const key = String(email || '').toLowerCase();
    if (!byAccount.has(key)) byAccount.set(key, { account: email, checked: false, accepted: 0, action: '' });
    return byAccount.get(key);
  };
  expectedAccounts.forEach((account) => ensure(account));
  let terminalError = '';
  let introduced = 0;
  for (const line of run) {
    let m = line.match(/([\w.%+-]+@[\w.-]+)\s+[—–-]\s+(\d+) newly accepted/i);
    if (m) {
      const result = ensure(m[1]);
      result.checked = true;
      result.accepted = Number(m[2]);
    }
    m = line.match(/Nobody has accepted\s+([\w.%+-]+@[\w.-]+)'s/i);
    if (m) ensure(m[1]).checked = true;
    m = line.match(/([\w.%+-]+@[\w.-]+)\s+[—–-]\s+(?:needs re-login|Identity Restricted)/i);
    if (m) {
      const result = ensure(m[1]);
      result.checked = false;
      result.action = /needs re-login/i.test(line) ? 'Log back in, then Retry' : 'Review account access, then Retry';
    }
    m = line.match(/Check finished with an error\s*[—–-]\s*(?:Action required:\s*)?(.+)/i);
    if (m) terminalError = m[1].replace(/\s+[·•]\s+\d{1,2}:\d{2}.*$/, '').trim();
    if (/\s[·•]\s*introduced(?:\s*[·•]|\s*$)/i.test(line)) introduced += 1;
  }
  const accounts = [...byAccount.values()];
  const checked = accounts.filter((account) => account.checked).length;
  const accepted = accounts.reduce((total, account) => total + account.accepted, 0);
  // Expected accounts may be profile IDs while the log identifies the same
  // accounts by email. Do not add those two identifier sets together: a
  // three-account sweep was incorrectly presented as "2 of 6".
  const expected = expectedAccounts.length || accounts.length;
  return {
    expected, checked, accepted, introduced,
    incomplete: !!terminalError || checked < expected,
    error: terminalError, accounts,
  };
}
