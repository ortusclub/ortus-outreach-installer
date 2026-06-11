/**
 * src/linkedin/accept-invitation.js — net-new (the codebase has NO accept-
 * invitation capability). Lets the primary's LOCAL browser accept exactly the
 * incoming connection request sent by a known campaign account — never any
 * other invitation. The off-limits actions.js/outreach.js are NOT touched.
 *
 * pickInvitation is a pure, high-precision matcher: a profile-URL match, or an
 * EXACT display-name match — and nothing softer. Unlike the intro typeahead
 * (a pre-filtered 1–5 suggestion list), the invitation manager lists EVERY
 * pending invite from any stranger, so fuzzy/token-prefix/single-candidate
 * matching is deliberately excluded to avoid accepting the wrong person.
 * The two DOM functions are verified manually against LinkedIn.
 */
import { normalizeName } from './match-primary.js';

/** Pull the LinkedIn profile slug out of any /in/<slug> URL, lowercased. */
function urlKey(u) {
  const m = String(u || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pure decision: which received-invitation candidate (if any) belongs to the
 * target campaign account. Precision over recall — only a profile-URL match or
 * an EXACT normalized-name match accepts; anything else returns no-match so a
 * stranger is never accepted. (No token-prefix / single-candidate fallback.)
 * @param {Array<{name:string, profileUrl?:string}>} candidates
 * @param {{name:string, profileUrl?:string}} target
 * @returns {{ index: number|null, reason: string }}
 */
export function pickInvitation(candidates, target) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: null, reason: 'no-candidates' };
  }
  // 1) Profile-URL corroboration — airtight, cannot false-positive.
  const tUrl = urlKey(target && target.profileUrl);
  if (tUrl) {
    const i = candidates.findIndex(c => urlKey(c.profileUrl) === tUrl);
    if (i >= 0) return { index: i, reason: 'profile-url' };
  }
  // 2) Exact display-name match only. The campaign account's name (read from
  //    its own global nav) and the invitation card name are both LinkedIn's
  //    canonical display name for the same account, so they match exactly.
  const norm = normalizeName((target && target.name) || '');
  if (norm) {
    const i = candidates.findIndex(c => normalizeName(c.name) === norm);
    if (i >= 0) return { index: i, reason: 'exact-name' };
  }
  return { index: null, reason: 'no-match' };
}

/**
 * Read the logged-in account's OWN identity from the global nav. Works on any
 * LinkedIn page (the "Me" control is global), so it can run on the campaign
 * account right after it sends the connect request to the primary. The name
 * (from the Me photo's alt) is the reliable signal; the profile URL is scoped
 * to the Me control so it doesn't pick up a sidebar suggestion, and is
 * best-effort corroboration only.
 * @returns {Promise<{name:string, profileUrl:string}>}
 */
export async function readSelfIdentity(page) {
  try {
    return await page.evaluate(() => {
      const out = { name: '', profileUrl: '' };
      const meImg = document.querySelector('img.global-nav__me-photo, .global-nav__me img');
      if (meImg && meImg.alt) out.name = meImg.alt.replace(/\s+/g, ' ').trim();
      // Scope the profile link to the Me control only — querying the whole
      // document would match a sidebar "people you may know" link first.
      const me = document.querySelector('.global-nav__me');
      const link = me ? me.querySelector('a[href*="/in/"]') : null;
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
    return rows.map((row) => {
      const nameEl = row.querySelector('a[href*="/in/"] strong, .invitation-card__title, a[href*="/in/"]');
      const link = row.querySelector('a[href*="/in/"]');
      return {
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

  // Click by IDENTITY, not by the stale index: re-find the matched person's row
  // inside the same evaluate so a SPA re-render between scrape and click can
  // never land us on a different (stranger's) card.
  const matched = candidates[index];
  const clicked = await page.evaluate((want) => {
    const slug = (u) => { const m = String(u || '').match(/\/in\/([^/?#]+)/i); return m ? m[1].toLowerCase() : ''; };
    const rows = Array.from(document.querySelectorAll(
      '.invitation-card, li.mn-invitation-list__item, [data-view-name="pending-invitation"]',
    ));
    const wantSlug = slug(want.profileUrl);
    const wantName = (want.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const row = rows.find((r) => {
      const a = r.querySelector('a[href*="/in/"]');
      if (wantSlug && a && slug(a.href) === wantSlug) return true;
      const nameEl = r.querySelector('a[href*="/in/"] strong, .invitation-card__title, a[href*="/in/"]');
      const rn = (nameEl?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return wantName && rn === wantName;
    });
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button'))
      .find(b => /accept/i.test(b.textContent || '') || /accept/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, matched);

  if (!clicked) return { accepted: false, reason: 'matched-row-not-found-at-click' };
  await new Promise(r => setTimeout(r, 1500));
  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
}
