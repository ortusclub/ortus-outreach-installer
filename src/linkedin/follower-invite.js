// Follower Growth Phase 2 — automates the LinkedIn page "Invite to follow" modal.
// Self-contained module (mirrors post-amplification.js); reuses only shared
// helpers.js + the launcher. Does NOT touch outreach.js / actions.js.
import { randomDelay } from './helpers.js';

// "30/30 credits available · …" → 30 (the LEADING number = currently available).
export function parseCreditsAvailable(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*\d+\s*credits available/i);
  return m ? Number(m[1]) : 0;
}

// Used ONLY to disambiguate duplicate same-name results. true if the headline
// contains the company token, or a significant (>=4-char, non-generic) job-title word.
const TITLE_STOP = new Set(['head', 'senior', 'chief', 'lead', 'manager', 'director', 'officer', 'global', 'group', 'team']);
export function headlineMatches(headline, { jobTitle = '', company = '' } = {}) {
  const h = (headline || '').toLowerCase();
  if (!h) return false;
  const co = (company || '').toLowerCase().trim();
  if (co.length >= 3 && h.includes(co)) return true;
  const words = (jobTitle || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w));
  return words.some((w) => h.includes(w));
}

// Decide which search result to select for a queued person.
// results: [{ name, headline, canInvite }]. Returns the chosen result or null (skip).
// Rule: among invitable results whose name matches — exactly one -> take it (no
// headline check); several -> the one whose headline verifies; else (0 or >1) -> null.
export function pickInviteResult(results, person) {
  const target = ((person && person.name) || '').trim().toLowerCase();
  if (!target) return null;
  const byName = (results || []).filter((r) => r.canInvite && (r.name || '').trim().toLowerCase() === target);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) return null;
  const verified = byName.filter((r) => headlineMatches(r.headline, { jobTitle: person.jobTitle, company: person.company }));
  return verified.length === 1 ? verified[0] : null;
}

const SEL = {
  modal: 'div[data-test-modal-id="invite-to-follow-picker"]',
  search: 'input.artdeco-typeahead__input',
  result: 'ul.artdeco-typeahead__results-list[role="listbox"] li[role="option"]',
  dismiss: 'button[aria-label="Dismiss"]',
};
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The modal SHELL (SEL.modal) mounts before LinkedIn renders its contents, so a
// read fired right after waitForSelector saw only "Dialog content start. Invite
// to follow Dialog content end." → 0 credits → instant bail (first send always
// failed; the retry worked because content had rendered by then). Poll until the
// real content is present: the credits line OR at least one result row. Node-side
// poll (not page.waitForFunction) so it reuses the tested parseCreditsAvailable
// and is unit-testable with a fake page. Returns after `timeoutMs` regardless so
// readCredits still runs and logs its parse-miss diagnostic if truly empty.
export async function waitForModalContent(page, { timeoutMs = 12000, pollMs = 250, log = () => {}, sleep = _sleep, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  let polls = 0;
  while (now() <= deadline) {
    polls++;
    const txt = await page.$eval(SEL.modal, (m) => m.innerText || '').catch(() => '');
    if (parseCreditsAvailable(txt) > 0) return { ready: true, via: 'credits', polls };
    const hasRow = await page.$(SEL.result).then(Boolean).catch(() => false);
    if (hasRow) return { ready: true, via: 'rows', polls };
    await sleep(pollMs);
  }
  return { ready: false, via: 'timeout', polls };
}

export async function openInviteModal(page, inviteUrl, { log = () => {} } = {}) {
  // Operators run on slow/overloaded laptops; the invite page + modal can take a
  // while. Quadrupled from 30s/15s after a real run timed out at 30s.
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector(SEL.modal, { timeout: 60000 });
  const content = await waitForModalContent(page, { log });
  log(content.ready
    ? `invite modal ready (${content.via}, ${content.polls} polls)`
    : `invite modal content did not render within ${content.polls} polls — proceeding anyway`);
  return { ok: true, contentReady: content.ready };
}

export async function readCredits(page, { log = () => {} } = {}) {
  // Read the WHOLE modal's visible text, not a single leaf node. LinkedIn often
  // splits "30/30 credits available" across child spans, so a leaf-only match
  // (the old approach) found nothing and returned 0 → the run thought the cap was
  // reached and bailed instantly. innerText concatenates the spans, so the regex
  // in parseCreditsAvailable still matches.
  const txt = await page.$eval(SEL.modal, (m) => m.innerText || '').catch(() => '');
  const credits = parseCreditsAvailable(txt);
  if (!credits) {
    // Couldn't parse a number — surface the real wording so the regex/selector can
    // be tuned (or confirm the account genuinely has 0 invite credits / isn't admin).
    log(`credits parse miss — modal text: "${String(txt).replace(/\s+/g, ' ').trim().slice(0, 240)}"`);
  }
  return credits;
}

export async function scrapeResults(page) {
  return page.$$eval(SEL.result, (lis) => lis.map((li) => {
    const text = (li.innerText || '').trim();
    const canInvite = !!li.querySelector('.invitee-picker-connections-result-item--can-invite');
    const m = text.match(/\b(?:1st|2nd|3rd)\s*•\s*/);
    // LinkedIn prepends the checkbox a11y label "Select <Name>" to each result's
    // first line — strip it so the name equals the queued person's name.
    const name = (m ? text.slice(0, m.index) : text).split('\n')[0].trim().replace(/^select\s+/i, '').trim();
    const headline = m ? text.slice(m.index).replace(/^\s*(?:1st|2nd|3rd)\s*•\s*/, '').trim() : '';
    // raw + class captured for diagnosing skips (name-match / can-invite detection).
    return { name, headline, canInvite, raw: text.replace(/\s+/g, ' ').slice(0, 140), cls: (li.className || '').slice(0, 120) };
  })).catch(() => []);
}

// Diagnostic (v2.119.4): LinkedIn changed the invite-to-follow modal DOM — the
// search typeahead selector (SEL.search) no longer matches, so selectPerson
// crashed ("No element found for selector: input.artdeco-typeahead__input").
// This dumps the modal's real input structure + innerHTML so the selector can
// be fixed from evidence, not guesswork. Runs once per real run, before the loop.
export async function probeSearchBox(page, { log = () => {} } = {}) {
  const hasSearch = await page.$(SEL.search).then(Boolean).catch(() => false);
  if (hasSearch) { log('search box present ✓'); return true; }
  const diag = await page.$eval(SEL.modal, (m) => {
    const fields = [...m.querySelectorAll('input, textarea, [role="combobox"], [role="searchbox"], [contenteditable="true"]')]
      .map((i) => ({
        tag: i.tagName.toLowerCase(),
        cls: (i.className || '').slice(0, 120),
        type: i.getAttribute('type') || '',
        ph: i.getAttribute('placeholder') || '',
        role: i.getAttribute('role') || '',
        aria: i.getAttribute('aria-label') || '',
      }));
    return { fields, html: (m.innerHTML || '').replace(/\s+/g, ' ').slice(0, 2000) };
  }).catch(() => null);
  log(`⚠ search box NOT found (${SEL.search}). modal fields: ${JSON.stringify(diag?.fields || [])}`);
  log(`⚠ modal html (first 2000 chars): ${diag?.html || '(modal not readable)'}`);
  return false;
}

// Type a name, wait for results, decide via pickInviteResult, click the chosen row.
export async function selectPerson(page, person, { log = () => {} } = {}) {
  await page.click(SEL.search, { clickCount: 3 }).catch(() => {});
  await page.type(SEL.search, person.name, { delay: 40 });
  await randomDelay(900, 1600);
  const results = await scrapeResults(page);
  const choice = pickInviteResult(results, person);
  if (!choice) { log(`skip "${person.name}" — scraped ${JSON.stringify(results.slice(0, 2))}`); return false; }
  const clicked = await page.evaluate((sel, targetName) => {
    // Match on the first line minus the "Select " a11y prefix (same as scrapeResults).
    const norm = (s) => (s || '').split('\n')[0].trim().replace(/^select\s+/i, '').trim().toLowerCase();
    const lis = [...document.querySelectorAll(sel)];
    const li = lis.find((l) => norm(l.innerText).startsWith(targetName.toLowerCase()));
    if (!li) return false;
    const box = li.querySelector('input[type="checkbox"], [role="checkbox"]') || li;
    box.click();
    return true;
  }, SEL.result, choice.name);
  log(`${clicked ? 'selected' : 'click-miss'} "${person.name}"`);
  return clicked;
}

export async function clickInvite(page, { log = () => {} } = {}) {
  const ok = await page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return false;
    const btn = [...modal.querySelectorAll('button.artdeco-button--primary')]
      .find((b) => /invite/i.test(((b.querySelector('.artdeco-button__text') || b).textContent) || ''));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, SEL.modal);
  log(ok ? 'clicked Invite' : 'Invite button not clickable');
  return ok;
}

// Orchestrator. `deps` is the unit-test seam (defaults to the real page fns above).
// The modal is opened only when `inviteUrl` is passed (real runs); unit tests omit it.
// `deps.sleep` replaces the inter-person pause (default: randomDelay 700–1400 ms).
export async function runFollowerInvites({ page, inviteUrl, queued = [], log = () => {}, shouldAbort = () => false, deps } = {}) {
  const d = {
    openModal: openInviteModal,
    readCredits,
    probeSearchBox,
    selectPerson,
    clickInvite,
    sleep: () => randomDelay(700, 1400),
    ...(deps || {}),
  };
  if (inviteUrl) await d.openModal(page, inviteUrl, { log });
  const creditsBefore = await d.readCredits(page, { log });
  log(`credits available: ${creditsBefore}`);
  // One-time DOM evidence dump on real runs (omitted in unit tests, which pass
  // no inviteUrl) so a changed search-box selector is diagnosable from the log.
  if (inviteUrl) await d.probeSearchBox(page, { log });
  const invited = [], skipped = [];
  for (const person of queued) {
    if (shouldAbort()) { log('aborted'); break; }
    if (invited.length >= creditsBefore) { log('credit cap reached'); break; }
    const ok = await d.selectPerson(page, person, { log });
    (ok ? invited : skipped).push(person.memberId);
    await d.sleep();
  }
  let sent = false;
  if (invited.length) sent = await d.clickInvite(page, { log });
  const creditsAfter = sent ? Math.max(0, creditsBefore - invited.length) : creditsBefore;
  return { invited: sent ? invited : [], skipped: sent ? skipped : skipped.concat(invited), creditsBefore, creditsAfter, sent };
}
