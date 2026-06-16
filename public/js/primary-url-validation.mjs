/**
 * primary-url-validation.mjs — ONE shared, dependency-free validator for the
 * "Primary person" LinkedIn URL field. Imported by BOTH the browser
 * (public/js/app.js, served at /js/…) and the Node server
 * (server.js → ./public/js/primary-url-validation.mjs) and the test suite, so
 * the wizard's hard-lock and the server's reject can never drift apart.
 *
 * Structural only — NO network lookup. It answers "is this a real personal
 * LinkedIn profile link?", not "is this the RIGHT person?" (that would need a
 * live lookup, which mis-fires on throttled sessions). Deterministic, so it's
 * safe to hard-block a campaign start on it.
 *
 * Uses the global URL constructor, available in both browsers and Node ESM.
 */

/**
 * @param {string} raw  whatever the operator pasted into the field
 * @returns {{ ok: boolean, reason: string, kind: string }}
 *   kind ∈ 'empty' | 'profile' (ok)  |  'not-a-url' | 'not-linkedin' |
 *          'sales-nav' | 'not-profile' (rejected)
 *   Blank is ok:true (the primary URL is optional — empty just disables the
 *   connected-to-primary check). Callers that REQUIRE a URL check emptiness
 *   themselves.
 */
export function validatePrimaryUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, reason: '', kind: 'empty' };

  // Parse leniently — operators often paste without a scheme (linkedin.com/in/x).
  let host = '';
  let path = '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    host = (u.hostname || '').toLowerCase();
    path = u.pathname || '';
  } catch {
    return {
      ok: false,
      kind: 'not-a-url',
      reason: "That doesn't look like a link. Paste the primary person's LinkedIn profile URL (linkedin.com/in/…).",
    };
  }

  // Host must be linkedin.com or one of its subdomains (www., uk., m., …).
  // The `(^|\.)` anchor rejects look-alikes like mylinkedin.com and typos
  // like linkdin.com.
  if (!/(^|\.)linkedin\.com$/.test(host)) {
    return {
      ok: false,
      kind: 'not-linkedin',
      reason: `That's not a LinkedIn URL (it points at "${host || 'an unknown site'}"). It must be a linkedin.com/in/… profile link.`,
    };
  }

  // Sales Navigator profile links (/sales/…) don't work for the connect check —
  // point the operator at the public profile instead.
  if (/^\/sales(\/|$)/i.test(path)) {
    return {
      ok: false,
      kind: 'sales-nav',
      reason: "That's a Sales Navigator link. Open the person's public profile and copy the linkedin.com/in/… URL instead.",
    };
  }

  // Must be a personal profile: /in/<slug> with a non-empty slug. The encoded
  // /in/ACwAA… form matches here too (it's a legit primary URL).
  const m = path.match(/^\/in\/([^/?#]+)/i);
  if (!m || !m[1]) {
    const seg = (path.split('/').filter(Boolean)[0] || '').toLowerCase();
    const known = {
      company: 'a company page',
      school: 'a school page',
      posts: 'a post',
      feed: 'the LinkedIn feed',
      search: 'a search-results page',
      jobs: 'a jobs page',
      groups: 'a group page',
      pub: 'an old-style directory link',
      mwlite: 'the LinkedIn mobile-lite site',
    };
    const what = known[seg] || (seg ? `a /${seg}/ page` : 'the LinkedIn home page');
    return {
      ok: false,
      kind: 'not-profile',
      reason: `That looks like ${what}, not a personal profile. Paste the primary person's linkedin.com/in/… URL.`,
    };
  }

  return { ok: true, reason: '', kind: 'profile' };
}
