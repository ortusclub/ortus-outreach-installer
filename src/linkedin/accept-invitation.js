/**
 * src/linkedin/accept-invitation.js — net-new (the codebase has NO accept-
 * invitation capability). Lets the primary's LOCAL browser accept exactly the
 * incoming connection request sent by a known campaign account — never any
 * other invitation. The off-limits actions.js/outreach.js are NOT touched.
 *
 * pickInvitation is pure (reuses the existing matchPrimaryCandidate); the two
 * DOM functions are verified manually against LinkedIn, like other primitives.
 */
import { normalizeName } from './match-primary.js';

function urlKey(u) {
  // Compare LinkedIn profile URLs ignoring scheme/host/query/trailing slash.
  const m = String(u || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pure decision: which received-invitation candidate (if any) belongs to the
 * target campaign account. Profile-URL match wins; else fall back to the name
 * matcher already used for the intro typeahead.
 * @param {Array<{name:string, profileUrl?:string}>} candidates
 * @param {{name:string, profileUrl?:string}} target
 * @returns {{ index: number|null, reason: string }}
 */
export function pickInvitation(candidates, target) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: null, reason: 'no-candidates' };
  }
  const tUrl = urlKey(target && target.profileUrl);
  if (tUrl) {
    const i = candidates.findIndex(c => urlKey(c.profileUrl) === tUrl);
    if (i >= 0) return { index: i, reason: 'profile-url' };
  }
  // Use only the name-match tiers (exact / token-prefix), NOT the
  // single-candidate fallback — invitation-manager lists ALL pending invites,
  // not a pre-filtered typeahead, so the fallback would accept the wrong person.
  const mapped = candidates.map(c => ({ text: c.name }));
  const norm = normalizeName((target && target.name) || '');
  if (norm) {
    // Tier 1: exact / startsWith
    for (let i = 0; i < mapped.length; i++) {
      const t = normalizeName(mapped[i].text);
      if (t === norm || t.startsWith(`${norm} `)) {
        return { index: i, reason: 'exact' };
      }
    }
    // Tier 2: token-prefix match
    const tokens = norm.split(/\s+/);
    for (let i = 0; i < mapped.length; i++) {
      const t = normalizeName(mapped[i].text);
      const words = t.split(/\s+/);
      const allMatched = tokens.every(tok => words.some(w => w.startsWith(tok)));
      if (allMatched) {
        return { index: i, reason: 'token-prefix' };
      }
    }
  }
  return { index: null, reason: 'no-match' };
}

/**
 * Read the logged-in account's OWN identity from the global nav. Works on any
 * LinkedIn page (the "Me" control is global), so it can run on the campaign
 * account right after it sends the connect request to the primary.
 * @returns {Promise<{name:string, profileUrl:string}>}
 */
export async function readSelfIdentity(page) {
  try {
    return await page.evaluate(() => {
      const out = { name: '', profileUrl: '' };
      const meImg = document.querySelector('img.global-nav__me-photo, .global-nav__me img');
      if (meImg && meImg.alt) out.name = meImg.alt.replace(/\s+/g, ' ').trim();
      // The "View Profile" link in the Me dropdown carries the own profile URL.
      const link = document.querySelector('a[href*="/in/"]:not([href*="/detail/"])');
      if (link) out.profileUrl = link.href;
      return out;
    });
  } catch {
    return { name: '', profileUrl: '' };
  }
}

/**
 * On the LOCAL browser (= the primary), accept ONLY the invitation matching
 * `target`. If none matches, accept nothing.
 * @returns {Promise<{accepted:boolean, reason:string}>}
 */
export async function acceptInvitationFrom(page, target, { log = () => {} } = {}) {
  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/received/', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await new Promise(r => setTimeout(r, 2500));

  const candidates = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(
      '.invitation-card, li.mn-invitation-list__item, [data-view-name="pending-invitation"]',
    ));
    return rows.map((row, idx) => {
      const nameEl = row.querySelector('a[href*="/in/"] strong, .invitation-card__title, a[href*="/in/"]');
      const link = row.querySelector('a[href*="/in/"]');
      return {
        idx,
        name: (nameEl?.textContent || '').replace(/\s+/g, ' ').trim(),
        profileUrl: link?.href || '',
      };
    });
  });

  const { index, reason } = pickInvitation(candidates, target);
  if (index == null) {
    log(`  ⚠ Auto-accept: no pending invitation matches ${target?.name || 'the account'} (${reason}) — accepting nothing.`);
    return { accepted: false, reason };
  }

  const clicked = await page.evaluate((wantIdx) => {
    const rows = Array.from(document.querySelectorAll(
      '.invitation-card, li.mn-invitation-list__item, [data-view-name="pending-invitation"]',
    ));
    const row = rows[wantIdx];
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button'))
      .find(b => /accept/i.test(b.textContent || '') || /accept/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, index);

  if (!clicked) return { accepted: false, reason: 'accept-button-not-found' };
  await new Promise(r => setTimeout(r, 1500));
  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
}
