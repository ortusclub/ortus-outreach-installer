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

export async function openInviteModal(page, inviteUrl, { log = () => {} } = {}) {
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(SEL.modal, { timeout: 15000 });
  log('invite modal open');
  return { ok: true };
}

export async function readCredits(page) {
  const txt = await page.$$eval(`${SEL.modal} *`, (els) => {
    const hit = els.find((e) => /\d+\s*\/\s*\d+\s*credits available/i.test(e.textContent || '') && e.children.length === 0);
    return hit ? hit.textContent : '';
  }).catch(() => '');
  return parseCreditsAvailable(txt);
}

export async function scrapeResults(page) {
  return page.$$eval(SEL.result, (lis) => lis.map((li) => {
    const text = (li.innerText || '').trim();
    const canInvite = !!li.querySelector('.invitee-picker-connections-result-item--can-invite');
    const m = text.match(/\b(?:1st|2nd|3rd)\s*•\s*/);
    const name = (m ? text.slice(0, m.index) : text).split('\n')[0].trim();
    const headline = m ? text.slice(m.index).replace(/^\s*(?:1st|2nd|3rd)\s*•\s*/, '').trim() : '';
    return { name, headline, canInvite };
  })).catch(() => []);
}

// Type a name, wait for results, decide via pickInviteResult, click the chosen row.
export async function selectPerson(page, person, { log = () => {} } = {}) {
  await page.click(SEL.search, { clickCount: 3 }).catch(() => {});
  await page.type(SEL.search, person.name, { delay: 40 });
  await randomDelay(900, 1600);
  const results = await scrapeResults(page);
  const choice = pickInviteResult(results, person);
  if (!choice) { log(`skip "${person.name}" (${results.length} results, no confident match)`); return false; }
  const clicked = await page.evaluate((sel, targetName) => {
    const lis = [...document.querySelectorAll(sel)];
    const li = lis.find((l) => (l.innerText || '').trim().toLowerCase().startsWith(targetName.toLowerCase()));
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
    selectPerson,
    clickInvite,
    sleep: () => randomDelay(700, 1400),
    ...(deps || {}),
  };
  if (inviteUrl) await d.openModal(page, inviteUrl, { log });
  const creditsBefore = await d.readCredits(page);
  log(`credits available: ${creditsBefore}`);
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
