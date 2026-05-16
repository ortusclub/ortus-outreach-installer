// Post-launch tips — central data + helpers.
//
// One source of truth for the modal (full text) and the sidebar card
// (one-liners). Mode-aware. Verified against the codebase (campaign.js,
// actions.js, post-amplification.js, check-dms.js). Made-up claims dropped
// per operator rule "dont guess ever".
//
// Dynamic tokens substituted at render time from `context`:
//   {dailyLimit} {delayMin} {delayMax} {checkIntervalMinutes} {primaryName}
//
// Imported by app.js. Pure module — testable with node --test.

const TIP_DATA = {
  connect_only: {
    modalTitle: "YOU'RE LIVE. A FEW THINGS TO KNOW.",
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open while sending.',
        full: '<b>Keep the lid open.</b> Sending pauses if the lid closes.',
      },
      {
        icon: '📤',
        short: 'Daily limit {dailyLimit}/profile · paced {delayMin}–{delayMax} s.',
        full: '<b>Daily limit: {dailyLimit}/profile.</b> Connects paced {delayMin}–{delayMax} s apart.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>To stop.</b> Press "Stop Campaign". Browsers force-close; leads already sent today stay saved.',
      },
      {
        icon: '📋',
        short: 'Watch sheet header typos.',
        full: '<b>Sheet column headers matter.</b> A trailing space like <code>"first name "</code> breaks substitution silently.',
      },
    ],
  },

  connect_and_introduce: {
    modalTitle: "YOU'RE LIVE. A FEW THINGS TO KNOW.",
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open while sending.',
        full: '<b>Keep the lid open.</b> Sending pauses if the lid closes — monitoring resumes when you reopen.',
      },
      {
        icon: '⏰',
        short: '15 s heads-up before each check.',
        full: '<b>15-second heads-up before each check.</b> macOS notification + cockpit ⏰ line fires 15 s before every auto-check.',
      },
      {
        icon: '🔁',
        short: 'Monitors 7 days · every {checkIntervalMinutes} min.',
        full: '<b>Monitoring runs for 7 days.</b> Once sending wraps, Ortus re-checks every {checkIntervalMinutes} min and fires the IC DM on each new acceptance.',
      },
      {
        icon: '⛔',
        short: '"Stop sending" ≠ "Stop everything".',
        full: '<b>Two ways to stop.</b> "Stop sending" halts new connects but keeps monitoring active. "Stop everything" ends both.',
      },
      {
        icon: '📋',
        short: 'Watch sheet header typos.',
        full: '<b>Sheet column headers matter.</b> A typo like <code>"first name "</code> (trailing space) breaks substitution silently.',
      },
      {
        icon: '📞',
        short: 'Bulk Check Connections fires anytime.',
        full: '<b>Click "Bulk Check Connections" anytime</b> in the cockpit to fire an off-schedule sweep + IC DMs.',
      },
    ],
  },

  check_status: {
    modalTitle: 'VERIFYING ACCEPTANCES.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open during the sweep.',
        full: "<b>Keep the lid open.</b> Ortus is sweeping LinkedIn's connections list — closing the lid pauses the check.",
      },
      {
        icon: '🔎',
        short: 'Bulk-first · ~80 leads per pass.',
        full: "<b>Bulk-first, ~80 leads per pass.</b> Each profile opens its <code>recent-connections</code> page once; older accepted invites that fell off LinkedIn's ~80-row list stay <i>Still Pending</i> until a fresh request lifts them.",
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign" — nothing\'s being sent, so there\'s no "keep monitoring" variant.',
      },
      {
        icon: '📞',
        short: 'Same as the cockpit\'s Bulk Check pill.',
        full: '<b>Same thing as the "Bulk Check Connections" pill</b> in the cockpit of a live CC+IC run. Just runnable from the wizard too.',
      },
    ],
  },

  message_only: {
    modalTitle: 'FOLLOW-UPS GOING OUT.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open while sending.',
        full: '<b>Keep the lid open.</b> DMs only fire while the screen is unlocked.',
      },
      {
        icon: '⚡',
        short: 'No daily limit · paced {delayMin}–{delayMax} s.',
        full: '<b>No daily limit on this mode.</b> Sends to every eligible row in the sheet, paced {delayMin}–{delayMax} s apart.',
      },
      {
        icon: '🤝',
        short: 'Connected leads only.',
        full: '<b>Connected leads only.</b> Filter picks rows where the sheet says the recipient is a 1st-degree connection. Rows that aren\'t connected get skipped — no silent failures.',
      },
      {
        icon: '📋',
        short: 'Watch sheet header typos.',
        full: '<b>Sheet column headers matter.</b> A typo like <code>"first name "</code> (trailing space) breaks substitution silently.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign".',
      },
    ],
  },

  introduce_back: {
    modalTitle: 'INTROS GOING OUT.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open during compose.',
        full: '<b>Keep the lid open.</b> The intro DM is composed in a real LinkedIn typeahead — needs page focus, which means an unlocked screen.',
      },
      {
        icon: '🧷',
        short: 'Primary person: {primaryName}.',
        full: '<b>Primary person locked.</b> <i>{primaryName}</i> is the third party on every intro. If the row\'s lead OR the primary can\'t be matched, that row is skipped — no DM sent to a wrong recipient.',
      },
      {
        icon: '⚡',
        short: 'No daily limit · paced {delayMin}–{delayMax} s.',
        full: '<b>No daily limit on this mode.</b> Sends to every eligible row, paced {delayMin}–{delayMax} s apart.',
      },
      {
        icon: '🤝',
        short: 'Connected leads only.',
        full: '<b>Connected leads only.</b> Rows that aren\'t connected get skipped and stamped.',
      },
      {
        icon: '📋',
        short: 'Hover chips to preview filled.',
        full: '<b>Variable check before launch.</b> Hover any chip in the Intro body to preview it filled. Empty trailing sheet columns can produce <code>{}</code> chips — those get filtered, typos with trailing spaces don\'t.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign".',
      },
    ],
  },

  inmail_only: {
    modalTitle: 'INMAILS GOING OUT.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open while sending.',
        full: '<b>Keep the lid open.</b> InMail compose needs an active window.',
      },
      {
        icon: '💳',
        short: 'Burns LinkedIn InMail credits.',
        full: '<b>Burns LinkedIn InMail credits.</b> Ortus reads the remaining-credit count from LinkedIn before every send. If it hits 0 mid-run, that profile halts cleanly and gets removed from the rotation.',
      },
      {
        icon: '⏱',
        short: 'Paced {delayMin}–{delayMax} s · no Ortus cap.',
        full: '<b>Paced {delayMin}–{delayMax} s between sends.</b> No daily cap from Ortus — LinkedIn\'s credit pool is the real limit.',
      },
      {
        icon: '📋',
        short: 'Variables work in subject + body.',
        full: '<b>Variables apply to both subject and body.</b> Same chip syntax as DMs.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign".',
      },
    ],
  },

  open_profile_only: {
    modalTitle: 'OPEN-PROFILE DMS GOING OUT.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open while sending.',
        full: '<b>Keep the lid open.</b> Compose flow is the same as a regular DM.',
      },
      {
        icon: '🆓',
        short: 'Open Profile leads only · no credit burn.',
        full: '<b>Free DM to non-connections — Open Profile leads only.</b> Profiles LinkedIn doesn\'t mark as "Open Profile" get skipped. No InMail credit burned in that case.',
      },
      {
        icon: '⏱',
        short: 'Paced {delayMin}–{delayMax} s between sends.',
        full: '<b>Paced {delayMin}–{delayMax} s between sends.</b>',
      },
      {
        icon: '📋',
        short: 'Watch sheet header typos.',
        full: '<b>Sheet column headers matter</b> — same substitution gotcha as DM.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign".',
      },
    ],
  },

  check_dms: {
    modalTitle: 'SCANNING INBOXES.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open during the scan.',
        full: '<b>Keep the lid open.</b> Ortus reads the LinkedIn inbox via the live browser — locked screen pauses the scan.',
      },
      {
        icon: '📥',
        short: 'Read-only on LinkedIn.',
        full: '<b>Read-only on LinkedIn.</b> Ortus doesn\'t send anything and doesn\'t click "mark as read" — just navigates to each lead\'s thread and scrapes the DOM.',
      },
      {
        icon: '📊',
        short: 'Replies land in the Replies tab.',
        full: '<b>Writes back to the sheet.</b> Replies land in the Replies tab (deduped). Rows with an inbound message get Stage = <i>Replied</i>.',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign". Partial results stay in the Replies tab.',
      },
    ],
  },

  post_amplification: {
    modalTitle: 'AMPLIFICATION RUNNING.',
    sidebarTitle: 'TIPS FOR THIS RUN',
    tips: [
      {
        icon: '💻',
        short: 'Keep the lid open during engagement.',
        full: '<b>Keep the lid open.</b> Each reaction + comment fires through the real LinkedIn feed — needs an unlocked screen.',
      },
      {
        icon: '👍',
        short: 'Reaction: 80% Like / 20% mix.',
        full: '<b>Reaction: 80% Like / 20% mix</b> (Celebrate, Support, Insightful, Funny, Love). Each profile reacts once per post — reactions are idempotent on LinkedIn\'s side.',
      },
      {
        icon: '💬',
        short: 'Comments are per-profile · not idempotent.',
        full: '<b>Comments are per-profile.</b> Whatever you typed in each account\'s comment box gets posted by that account. Comments are NOT idempotent — re-running fires another comment.',
      },
      {
        icon: '⏱',
        short: 'Profiles run sequentially · 1–5 min gap.',
        full: '<b>Profiles run sequentially with a 60–300 s gap between them.</b> Total runtime ≈ (1–5 min) × (number of profiles).',
      },
      {
        icon: '⛔',
        short: 'Press "Stop Campaign" to halt.',
        full: '<b>One way to stop.</b> Press "Stop Campaign". Profiles that already commented stay — reactions can\'t be unliked from here.',
      },
    ],
  },
};

// Pure: replace {token} occurrences in a template string with values from
// context. Missing tokens become '—' so the UI never shows the raw {token}
// literal. Whitelist-driven so a stray brace in copy doesn't get mangled.
const TOKEN_KEYS = ['dailyLimit', 'delayMin', 'delayMax', 'checkIntervalMinutes', 'primaryName'];

export function substituteTokens(template, context = {}) {
  if (typeof template !== 'string') return '';
  let out = template;
  for (const key of TOKEN_KEYS) {
    const re = new RegExp(`\\{${key}\\}`, 'g');
    if (!re.test(out)) continue;
    const raw = context[key];
    const val = (raw === undefined || raw === null || raw === '') ? '—' : String(raw);
    out = out.replace(re, val);
  }
  return out;
}

// Pure: returns the resolved tip-set for a mode, or null if unknown mode.
// Context shape: { dailyLimit, delayMin, delayMax, checkIntervalMinutes, primaryName }
export function getTipsForMode(mode, context = {}) {
  const entry = TIP_DATA[mode];
  if (!entry) return null;
  return {
    modalTitle: entry.modalTitle,
    sidebarTitle: entry.sidebarTitle,
    tips: entry.tips.map(t => ({
      icon: t.icon,
      short: substituteTokens(t.short, context),
      full:  substituteTokens(t.full,  context),
    })),
  };
}

// Render helpers — return HTML strings the renderer drops into the DOM.

export function renderModalTipsHtml(mode, context = {}) {
  const set = getTipsForMode(mode, context);
  if (!set) return '';
  const items = set.tips.map(t => `
    <li>
      <span class="ptm-icon">${t.icon}</span>
      <span class="ptm-text">${t.full}</span>
    </li>
  `).join('');
  return `<ul class="ptm-list">${items}</ul>`;
}

export function renderSidebarTipsHtml(mode, context = {}) {
  const set = getTipsForMode(mode, context);
  if (!set) return '';
  const items = set.tips.map(t => `
    <li>
      <span class="pts-icon">${t.icon}</span>
      <span class="pts-text">${t.short}</span>
    </li>
  `).join('');
  return `<ul class="pts-list">${items}</ul>`;
}

// Test hook — lets tests inspect the keys without exposing TIP_DATA directly.
export function getKnownModes() {
  return Object.keys(TIP_DATA);
}

// localStorage key per mode. Operator can silence the modal per-mode by
// ticking "Don't show this again" before dismissing.
const SILENCE_PREFIX = 'ortusTipsSilenced_';

export function isTipsSilenced(mode) {
  try { return localStorage.getItem(SILENCE_PREFIX + mode) === '1'; }
  catch { return false; }
}

export function silenceTipsForMode(mode) {
  try { localStorage.setItem(SILENCE_PREFIX + mode, '1'); }
  catch { /* private mode / no storage */ }
}

export function resetTipsSilence(mode) {
  try { localStorage.removeItem(SILENCE_PREFIX + mode); }
  catch { /* */ }
}
