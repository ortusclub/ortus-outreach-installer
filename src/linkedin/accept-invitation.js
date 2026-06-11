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

// LinkedIn's invitation cards use hashed/randomized CSS classes and the Accept
// button's label is localized (the operator's UI language), so we identify the
// Accept button by a language-stem match on its aria-label / text — and we
// EXCLUDE ignore/decline stems so a stray match can never click "Ignore".
// Stems are lowercase substrings covering the common operator locales.
export const ACCEPT_STEMS = [
  'accept',   // EN accept · FR accepter · NL accepteren · RO acceptă · DA acceptér
  'annehm',   // DE annehmen
  'accett',   // IT accetta / accettare
  'acept',    // ES aceptar
  'aceit',    // PT aceitar
  'godkänn',  // SV
  'godta',    // NO
  'hyväksy',  // FI
  'zaakcept', // PL zaakceptuj
  'przyjmij', // PL przyjmij
  'elfogad',  // HU
  'принять',  // RU
  'tanggap',  // TL (Tagalog/Filipino) tanggapin — NOT a substring of the decline "tanggihan"
];
export const IGNORE_STEMS = [
  'ignor',    // EN/DE/IT/ES ignore/ignorieren/ignora/ignorar
  'negeren',  // NL
  'odrzuc',   // PL
  'rifiut',   // IT rifiuta
  'rechaz',   // ES rechazar
  'refus',    // FR refuser
  'avvis',    // NO/DA avvis
  'hylkää',   // FI
  'elutasít', // HU
  'отклон',   // RU
  'tanggih',  // TL decline (tanggihan) — vetoes the Tanggapin look-alike
  'pansin',   // TL ignore (huwag pansinin)
  'balewala', // TL ignore (balewalain)
];

/**
 * Pure: is this button label an ACCEPT action (and not an ignore/decline)?
 * Matches an accept stem AND no ignore stem. Locale-independent of CSS classes.
 * @param {string} label  aria-label or visible text of a button
 */
export function isAcceptLabel(label, accept = ACCEPT_STEMS, ignore = IGNORE_STEMS) {
  const s = (label || '').toLowerCase();
  if (!s) return false;
  if (ignore.some((v) => s.includes(v))) return false;
  return accept.some((v) => s.includes(v));
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
  // Wait for the received list to actually render an Accept button (the cards
  // load async), or 12s if the list is genuinely empty. The cards use hashed
  // CSS classes, so we anchor on the language-stem Accept label instead.
  await page.waitForFunction(
    (acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      return Array.from(document.querySelectorAll('button'))
        .some((b) => isAcc(b.getAttribute('aria-label') || b.textContent || ''));
    },
    { timeout: 12000 },
    ACCEPT_STEMS, IGNORE_STEMS,
  ).catch(() => { /* empty list / slow — fall through and scrape what's there */ });
  await new Promise((r) => setTimeout(r, 1500));

  // Build candidates by walking each Accept button up to its card's profile
  // link — class-independent. Each candidate ties a sender identity to its own
  // Accept button.
  const candidates = await page.evaluate((acc, ign) => {
    const isAcc = (s) => {
      s = (s || '').toLowerCase();
      if (!s) return false;
      if (ign.some((v) => s.includes(v))) return false;
      return acc.some((v) => s.includes(v));
    };
    const out = [];
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      if (!isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) continue;
      let el = btn, link = null;
      for (let k = 0; k < 10 && el; k++) {
        el = el.parentElement;
        if (!el) break;
        link = el.querySelector('a[href*="/in/"]');
        if (link) break;
      }
      if (!link) continue; // an Accept-like button with no profile card — skip
      const nameEl = el.querySelector('a[href*="/in/"] strong') || link;
      out.push({
        name: (nameEl.textContent || '').replace(/\s+/g, ' ').trim(),
        profileUrl: link.href || '',
      });
    }
    return out;
  }, ACCEPT_STEMS, IGNORE_STEMS);

  const { index, reason } = pickInvitation(candidates, target);
  if (index == null) {
    log(`  ⚠ Auto-accept: no pending invitation matches ${target?.name || 'the account'} (${reason}; ${candidates.length} pending) — accepting nothing.`);
    return { accepted: false, reason };
  }

  // Click by IDENTITY: re-find the matched person's Accept button inside the
  // same evaluate (same anchor logic) so a SPA re-render can never land us on a
  // different card, and so we click ONLY that person's Accept (never Ignore).
  const matched = candidates[index];
  const clicked = await page.evaluate((want, acc, ign) => {
    const isAcc = (s) => {
      s = (s || '').toLowerCase();
      if (!s) return false;
      if (ign.some((v) => s.includes(v))) return false;
      return acc.some((v) => s.includes(v));
    };
    const slug = (u) => { const m = String(u || '').match(/\/in\/([^/?#]+)/i); return m ? m[1].toLowerCase() : ''; };
    const wantSlug = slug(want.profileUrl);
    const wantName = (want.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      if (!isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) continue;
      let el = btn, link = null;
      for (let k = 0; k < 10 && el; k++) {
        el = el.parentElement;
        if (!el) break;
        link = el.querySelector('a[href*="/in/"]');
        if (link) break;
      }
      if (!link) continue;
      const nameEl = el.querySelector('a[href*="/in/"] strong') || link;
      const rn = (nameEl.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if ((wantSlug && slug(link.href) === wantSlug) || (wantName && rn === wantName)) {
        btn.click();
        return true;
      }
    }
    return false;
  }, matched, ACCEPT_STEMS, IGNORE_STEMS);

  if (!clicked) return { accepted: false, reason: 'matched-row-not-found-at-click' };
  await new Promise((r) => setTimeout(r, 1500));
  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
}
