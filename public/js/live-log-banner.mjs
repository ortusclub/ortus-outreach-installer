// The live log is the operator-visible event stream. The stage must never tell
// a second, independently reconstructed story. Pick its newest operational
// line and remove only renderer metadata (level/time), leaving the engine's
// actual words intact.
function relativeSchedule(raw, now = new Date()) {
  const parsed = new Date(String(raw).trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+UTC$/i, '$1T$2:00Z'));
  if (Number.isNaN(parsed.getTime())) return String(raw).trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const days = Math.round((target - today) / 86400000);
  const time = parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  return `${parsed.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

function readablePresentation(line, phase = '', now = new Date()) {
  const clean = line.replace(/^[◷↻⟳⏱]\s*/u, '').trim();
  let m;
  if (/^Check now\b/i.test(clean)) return {
    kind: 'check-queued', eyebrow: 'Waiting for the VM worker',
    headline: 'Acceptance check queued',
    explanation: 'The VM is waking and has not selected an account yet. A cold start normally takes about two minutes.',
  };
  // The engine has used both "nothing happens until then" and "monitoring
  // stays active" over time. The schedule is the state; trailing narration is
  // log detail and must never become a giant permanent headline.
  if ((m = clean.match(/^Next check\s+(.+?)\s*[·•](?:\s|$)/i))) {
    return {
      kind: 'check-waiting', eyebrow: 'Monitoring is active',
      headline: 'Waiting for the next acceptance check',
      detail: relativeSchedule(m[1], now),
      explanation: 'Nothing needs to be done now.',
    };
  }
  if (/check complete/i.test(clean)) return { kind: 'check-complete', eyebrow: 'Acceptance check complete', headline: 'Every available account has finished this check', explanation: clean };
  if ((m = clean.match(/^Checking\s+(.+?)(?:\.{3}|\s*[·•]|$)/i))) return { kind: 'account-checking', account: m[1], eyebrow: 'Checking acceptances', headline: `Checking ${m[1]}`, explanation: 'The app is reading this account’s recent LinkedIn connections now.' };
  if (/identity restricted/i.test(clean)) {
    const who = clean.split(/\s+[—–]\s+/)[0];
    return { kind: 'account-skipped', account: who, eyebrow: 'Account unavailable', headline: `${who} was skipped safely`, explanation: 'The account is Identity Restricted. Other available accounts continue.' };
  }
  if ((m = clean.match(/^(.+?)\s+[—–]\s+(\d+) newly accepted/i))) return { kind: 'account-checked', account: m[1], eyebrow: 'Account checked', headline: `Finished checking ${m[1]}`, explanation: `${m[2]} newly accepted connection${Number(m[2]) === 1 ? '' : 's'} found on this account.` };
  if (/browser (?:opened|opening)|opening .+browser/i.test(clean)) return { eyebrow: phase === 'checking' ? 'Starting acceptance check' : 'Opening sender account', headline: clean, explanation: 'The browser is opening. The next verified action will appear here and in the log.' };
  if (/\b(?:CC|connection request) sent\b/i.test(clean)) return { eyebrow: 'Connection request confirmed', headline: clean, explanation: 'The result was confirmed and recorded before moving to the next lead.' };
  if (/introduc(?:ed|tion)|message sent/i.test(clean)) return { eyebrow: 'Introduction confirmed', headline: clean, explanation: 'The message result was confirmed and recorded in the campaign sheet.' };
  if (/check stopped|stop requested|stopping/i.test(clean)) return { kind: 'check-stopping', eyebrow: 'Stopping check', headline: 'Closing the current browser now', explanation: 'Unconfirmed work will be checked again next time. Monitoring remains active.' };
  return { eyebrow: phase === 'monitoring' ? 'Monitoring update' : phase === 'checking' ? 'Acceptance-check update' : 'Campaign update', headline: clean, explanation: 'This is the newest verified campaign event.' };
}

export function latestBannerEvent(logs = [], { phase = '', now = new Date() } = {}) {
  if (!Array.isArray(logs)) return null;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    let line = String(logs[i] && logs[i].line != null ? logs[i].line : logs[i] || '').trim();
    if (!line) continue;
    // Totals and divider rows are pinned to the bottom of merged logs, so they
    // are not chronological activity and must not permanently own the banner.
    if (/^(?:SUM\b|Σ\s*Total\b|[-—–_─━═]{3,})/iu.test(line)) continue;
    line = line
      .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/^(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/\s+[·•]\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/i, '')
      .replace(/^[✓✔⚠■▶⏰⚡●○□▪︎▫︎\s]+/u, '')
      .trim();
    // A row made only from glyphs/rules is presentation, not an event. Unicode
    // letter/number detection also keeps names in every supported locale.
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue;
    const parts = line.split(/\s+[—–]\s+/, 2);
    const first = parts[0].trim();
    if (!/[\p{L}\p{N}]/u.test(first)) continue;
    const presentation = readablePresentation(line, phase, now);
    return {
      line,
      headline: presentation.headline || first,
      eyebrow: presentation.eyebrow,
      kind: presentation.kind || 'event',
      account: presentation.account || '',
      explanation: presentation.explanation,
      detail: presentation.detail || line,
    };
  }
  return null;
}
