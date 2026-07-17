/**
 * src/primary-cookie-capture.js — capture the primary's LinkedIn session off the
 * local handshake browser and hand it to the engine, so a follow-up can later run
 * AS the primary on the VM (see docs/cloud-engine-primary-handshake-spec.md).
 *
 * Registry key is the SLUG (publicIdentifier), not a numeric member id: every
 * engine lookup that matters (getPrimaryBySlug, status join, resume) is
 * slug-based, so a numeric id buys nothing and would need an extra Voyager
 * scrape.
 * ponytail: slug is the key; upgrade to numeric member ID only if people
 * changing their vanity URL mid-campaign becomes a real problem (today it just
 * parks → re-capture).
 */
import { readSelfIdentity } from './linkedin/accept-invitation.js';

/**
 * Best-effort: never throws. Returns null when the primary isn't identifiable
 * or isn't logged in — callers must treat a null return as "skip, don't post".
 * @param {object} page       the local primary browser's puppeteer page
 * @param {object} [deps]
 * @param {typeof readSelfIdentity} [deps.readSelfIdentity]
 * @returns {Promise<{memberId:string, publicIdentifier:string, displayName:string, cookies:Array}|null>}
 */
export async function capturePrimaryCookies(page, deps = {}) {
  const readSelf = deps.readSelfIdentity || readSelfIdentity;
  const self = await readSelf(page).catch(() => null);
  const slug = self && self.profileUrl
    ? (String(self.profileUrl).match(/\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase()
    : '';
  if (!slug) return null;

  const cookies = await page.cookies('https://www.linkedin.com');
  const liAt = Array.isArray(cookies) && cookies.find((c) => c.name === 'li_at');
  if (!liAt) return null; // not logged in

  return { memberId: slug, publicIdentifier: slug, displayName: self.name || '', cookies };
}
