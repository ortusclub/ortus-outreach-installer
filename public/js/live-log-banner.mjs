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

function relativeDay(raw, now = new Date()) {
  const parsed = new Date(String(raw).trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+UTC$/i, '$1T$2:00Z'));
  if (Number.isNaN(parsed.getTime())) return String(raw).trim().toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const days = Math.round((target - today) / 86400000);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  return parsed.toLocaleDateString([], { weekday: 'long' });
}

function actionOnlyHeadline(raw) {
  return String(raw || '')
    .replace(/\[\s*[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\s*\]/gi, '')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T\S+\b/g, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    .replace(/^[📡🖥️\s·•—–:-]+/u, '')
    .replace(/[·•]\s*[·•]/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function readablePresentation(line, phase = '', now = new Date()) {
  const clean = line.replace(/^[◷↻⟳⏱]\s*/u, '').trim();
  let m;
  if ((m = clean.match(/^Check finished with an error\s*[—–-]\s*(?:Action required:\s*)?(.+)$/i))) {
    return {
      kind: 'check-error', eyebrow: 'Check incomplete',
      headline: 'Not every account could be checked',
      detail: m[1].trim(),
      explanation: 'Monitoring remains active. Fix the named account before the next check.',
    };
  }
  // Older engine rows included a raw UTC timestamp and repeated the entire
  // explanation. Keep those forensic rows intact in the log, but present the
  // same state in the compact human language used by current engine rows.
  if ((m = clean.match(/^🌙?\s*No account can send until\s+(.+?)\s+[—–]\s+sending stops here and acceptance checks carry on\.\s*(\d+)\s+leads?\s+left/i))) {
    const when = relativeDay(m[1], now);
    return {
      kind: 'sending-paused-monitoring', eyebrow: 'Monitoring is active',
      headline: `Sending pauses until ${when}`,
      detail: `${m[2]} leads remain · acceptance checks continue · resumes automatically ${when}`,
      explanation: 'Nothing needs to be done.',
    };
  }
  if ((m = clean.match(/^🌙?\s*Sending pauses until\s+([^—–]+?)\s+[—–]\s+acceptance checks continue\.\s*(\d+)\s+leads?\s+remain/i))) {
    const when = m[1].trim().toLowerCase();
    return {
      kind: 'sending-paused-monitoring', eyebrow: 'Monitoring is active',
      headline: `Sending pauses until ${when}`,
      detail: `${m[2]} leads remain · acceptance checks continue · resumes automatically ${when}`,
      explanation: 'Nothing needs to be done.',
    };
  }
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Check now\s+[—–]\s+bulk check pass starting/i))) {
    return {
      kind: 'local-browser-starting', account: m[1], eyebrow: 'Starting this Mac',
      headline: 'Starting the local browser',
      detail: `${m[1]} · Browser not open yet`,
      explanation: 'The check begins when the browser reports that it is open.',
    };
  }
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Launching browser/i))) return {
    kind: 'account-browser-opening', account: m[1], eyebrow: 'Starting account check',
    headline: 'Opening the sender browser', detail: m[1], explanation: '',
  };
  if ((m = clean.match(/^🖥️?\s*Opening\s+([^'\s]+)'s browser on the VM\s*[—–]\s*(\d+)\s*\/\s*(\d+)\s*sent today/i))) return {
    kind: 'sender-browser-opening', account: m[1], eyebrow: 'Opening sender account',
    headline: 'Opening the sender browser',
    detail: `${m[1]} · ${m[2]} of ${m[3]} sent today`, explanation: '',
  };
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Sweeping recent connections/i))) return {
    kind: 'account-checking', account: m[1], eyebrow: 'Checking acceptances',
    headline: 'Checking recent connections', detail: m[1], explanation: '',
  };
  if ((m = clean.match(/^Nobody has accepted\s+([^'\s]+)'s\s+(\d+)\s+outstanding invitations yet\.\s*(\d+)\s+rows refreshed/i))) return {
    kind: 'account-checked', account: m[1], eyebrow: 'Account checked',
    headline: 'Account check finished', detail: `${m[1]} · 0 newly accepted · ${m[3]} rows refreshed`, explanation: '',
  };
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Bulk check:\s*(\d+)\s+marked Connected/i))) return {
    kind: 'account-checked', account: m[1], eyebrow: 'Account checked',
    headline: 'Account check finished', detail: `${m[1]} · ${m[2]} newly accepted`, explanation: '',
  };
  if (/^📡?\s*Manual bulk check complete/i.test(clean)) return {
    kind: 'check-complete', eyebrow: 'Acceptance check complete',
    headline: 'Finished checking all available accounts',
    detail: clean.replace(/^📡?\s*Manual bulk check complete\s*[—–]?\s*/i, ''), explanation: '',
  };
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
  if ((m = clean.match(/^Monitoring active\s*[·•]\s*next check at\s+(\d{1,2}:\d{2})/i))) {
    return {
      kind: 'check-waiting', eyebrow: 'Monitoring is active',
      headline: 'Waiting for the next acceptance check',
      detail: `Today at ${m[1]}`,
      explanation: 'Nothing needs to be done now.',
    };
  }
  // Sending progress is deliberately verbose in the forensic log. Its prefix
  // can repeat the sender twice, followed by lead, step, detail and batch turn.
  // The banner shows each fact once and translates internal verbs into plain
  // operator language without weakening the underlying log.
  if ((m = clean.match(/^(.*?)\s+[—–]\s+([^·•]+)(?:\s*[·•]\s*(.*))?$/i))
      && /@/.test(m[1]) && /sending batch|Profile opened|Stamping the result/i.test(clean)) {
    const context = m[1].split(/\s*[·•]\s*/).map((s) => s.trim()).filter(Boolean);
    const account = context.find((s) => /@/.test(s)) || '';
    const lead = [...context].reverse().find((s) => !/@/.test(s)) || 'this lead';
    const step = m[2].trim();
    const tail = (m[3] || '').trim();
    const turn = clean.match(/(\d+)\s+of\s+(\d+)\s+(?:this\s+)?sending batch/i);
    let headline = `${step} — ${lead}`;
    let action = tail.split(/\s*[·•]\s*/)[0] || '';
    let kind = 'sending-progress';
    if (/Profile opened\s+[—–]\s+preparing the page/i.test(step)) {
      kind = 'profile-loading';
      headline = `Opening ${lead} on LinkedIn`;
      action = 'Waiting for the profile page';
    } else if (/Stamping the result to the sheet/i.test(step)) {
      kind = 'saving-result';
      headline = `Saving ${lead}’s result`;
      action = 'Writing to the campaign sheet';
    } else if (/Profile ready/i.test(step)) {
      headline = `${lead}’s profile is ready`;
      action = 'Checking available actions';
    }
    return {
      kind, account,
      eyebrow: kind === 'saving-result' ? 'Recording the result' : 'Working on the next lead',
      headline,
      detail: [account, action, turn ? `Lead ${turn[1]} of ${turn[2]}` : ''].filter(Boolean).join(' · '),
      explanation: '',
    };
  }
  if (/check complete/i.test(clean)) return { kind: 'check-complete', eyebrow: 'Acceptance check complete', headline: 'Every available account has finished this check', explanation: clean };
  if ((m = clean.match(/^Checking\s+(.+?)(?:\.{3}|\s*[·•]|$)/i))) return { kind: 'account-checking', account: m[1], eyebrow: 'Checking acceptances', headline: 'Checking recent connections', detail: m[1], explanation: 'The app is reading this account’s recent LinkedIn connections now.' };
  if (/identity restricted/i.test(clean)) {
    const who = clean.split(/\s+[—–]\s+/)[0];
    return { kind: 'account-skipped', account: who, eyebrow: 'Account unavailable', headline: 'Account skipped safely', detail: `${who} · Identity Restricted`, explanation: 'Other available accounts continue.' };
  }
  if ((m = clean.match(/^(.+?)\s+[—–]\s+(\d+) newly accepted/i))) return { kind: 'account-checked', account: m[1], eyebrow: 'Account checked', headline: 'Account check finished', detail: clean, explanation: '' };
  if (/browser (?:opened|opening)|opening .+browser/i.test(clean)) return { eyebrow: phase === 'checking' ? 'Starting acceptance check' : 'Opening sender account', headline: clean, explanation: 'The browser is opening. The next verified action will appear here and in the log.' };
  if (/\b(?:CC|connection request) sent\b/i.test(clean)) return { eyebrow: 'Connection request confirmed', headline: clean, explanation: 'The result was confirmed and recorded before moving to the next lead.' };
  if (/introduc(?:ed|tion)|message sent/i.test(clean)) return { eyebrow: 'Introduction confirmed', headline: clean, explanation: 'The message result was confirmed and recorded in the campaign sheet.' };
  if (/check stopped|stop requested|stopping/i.test(clean)) return { kind: 'check-stopping', eyebrow: 'Stopping check', headline: 'Closing the current browser now', explanation: 'Unconfirmed work will be checked again next time. Monitoring remains active.' };
  return { eyebrow: phase === 'monitoring' ? 'Monitoring update' : phase === 'checking' ? 'Acceptance-check update' : 'Campaign update', headline: clean, explanation: 'This is the newest verified campaign event.' };
}

export function latestBannerEvent(logs = [], { phase = '', now = new Date() } = {}) {
  if (!Array.isArray(logs)) return null;
  const candidates = [];
  for (let i = 0; i < logs.length; i += 1) {
    const rawEvent = logs[i];
    let line = String(rawEvent && rawEvent.line != null ? rawEvent.line : rawEvent || '').trim();
    if (!line) continue;
    const envelope = line.match(/^\[([^\]]+)\]/);
    const objectTime = rawEvent && typeof rawEvent === 'object'
      ? Number(rawEvent.t || rawEvent.at || new Date(rawEvent.ts || rawEvent.timestamp || 0))
      : 0;
    const envelopeTime = envelope ? Number(new Date(envelope[1])) : 0;
    const clock = line.match(/\s+[·•]\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
    const clockTime = clock
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)).getTime()
      : 0;
    // Totals and divider rows are pinned to the bottom of merged logs, so they
    // are not chronological activity and must not permanently own the banner.
    if (/^(?:SUM\b|Σ\s*Total\b|[-—–_─━═]{3,})/iu.test(line)) continue;
    line = line
      // Local engine rows can arrive with their original ISO envelope inside
      // the API log row. Strip transport timestamps before interpreting the
      // human event; they must never become part of an account name/headline.
      .replace(/^(?:\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*)+/, '')
      .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/^(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/\s+[·•]\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/i, '')
      .replace(/^[✓✔⚠■▶⏰⚡🛏●○□▪︎▫︎\s]+/u, '')
      .trim();
    // A row made only from glyphs/rules is presentation, not an event. Unicode
    // letter/number detection also keeps names in every supported locale.
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue;
    const parts = line.split(/\s+[—–]\s+/, 2);
    const first = parts[0].trim();
    if (!/[\p{L}\p{N}]/u.test(first)) continue;
    const presentation = readablePresentation(line, phase, now);
    candidates.push({
      line,
      headline: actionOnlyHeadline(presentation.headline || first),
      eyebrow: presentation.eyebrow,
      kind: presentation.kind || 'event',
      account: presentation.account || '',
      explanation: presentation.explanation,
      detail: presentation.detail || line,
      at: objectTime || envelopeTime || clockTime || 0,
      order: i,
    });
  }
  if (!candidates.length) return null;
  // Merged campaign logs contain both lifecycle rows and lead-derived rows.
  // Those sources can be appended out of chronological order, so array order
  // is only a fallback. A real event timestamp is authoritative.
  const timed = candidates.filter((event) => event.at > 0);
  if (timed.length) {
    const newest = timed.reduce((latest, event) => (
      event.at > latest.at || (event.at === latest.at && event.order > latest.order) ? event : latest
    ));
    // Scheduling the next sweep is bookkeeping, not resolution. Keep a fresh
    // incomplete result visible even though the engine writes "Next check"
    // immediately after it. A later successful sweep produces a newer terminal
    // result and naturally clears this warning.
    if (newest.kind === 'check-waiting') {
      const error = timed.filter((event) => event.kind === 'check-error')
        .reduce((latest, event) => (!latest || event.at > latest.at ? event : latest), null);
      if (error && newest.at - error.at <= 5 * 60 * 1000) return error;
    }
    return newest;
  }
  return candidates[candidates.length - 1];
}

// An idle monitoring snapshot may arrive one poll behind a freshly resumed
// sender. Hide only historical acceptance-check steps in that situation. The
// previous blanket `durableSweepIdle` guard also hid real sending events such
// as "Opening riccardo's browser on the VM", leaving the banner frozen on the
// next-check countdown while the campaign was visibly sending in the log.
export function bannerEventOwnsIdleMonitoring(event, durableSweepIdle = false) {
  if (!event) return false;
  if (!durableSweepIdle) return true;
  return ![
    'local-browser-starting',
    'account-browser-opening',
    'account-checking',
    'account-checked',
    'account-skipped',
    'check-complete',
    'check-waiting',
  ].includes(event.kind);
}
