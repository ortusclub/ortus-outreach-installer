/**
 * Connect-time identity verification.
 *
 * Background (2026-06-08 connect_and_introduce incident): lead URLs in the
 * encoded member-URN form (`/in/ACwAA…`) sometimes fail to load — under
 * LinkedIn rate-limiting / session degradation the browser lands on a junk
 * fallback page. The connect flow then read THAT page as "already a 1st-degree
 * connection" and `captureProfileMeta` stamped the stray page's URN onto the
 * lead's row, with no check it was the right person. bulk-check later matched
 * the lead to that stranger's acceptance → false "Already Connected" → the
 * CC+IC intro fired at someone who was never connected → "compose page didn't
 * load". The tell: a genuine connection round-trips a NUMERIC member id; a
 * false one carries a URN but an EMPTY member id.
 *
 * This pure helper is the guard: only trust a connect/already-connected stamp
 * when the captured identity provably belongs to the intended lead.
 */

// Pull the AC**AA member token (LinkedIn's encoded member id) out of any
// string — a /in/ACwAA… URL, an ACoAA… URN, etc. Mirrors memberIdFromAny in
// bulk-check-connections.js so the two stay consistent.
function memberToken(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[0] : '';
}

// Everything after the 5-char AC**AA tag. The leading bytes of this body
// encode the member id, so the SAME person's ACwAA (URL) and ACoAA (captured
// URN) forms share a long common prefix here even though their tags differ.
function tokenBody(value) {
  const tok = memberToken(value);
  return tok ? tok.slice(5) : '';
}

function commonPrefixLen(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Empirically, same-member ACwAA/ACoAA bodies share ~7 leading chars; different
// members share 0–1. 6 is a safe floor that separates the two cleanly.
const MIN_BODY_PREFIX = 6;

const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// Sheets carry the lead's numeric member id under a few header spellings (and
// a SECOND, run-stamped "LinkedIn Membership ID" column that starts empty).
// Read the first NON-EMPTY numeric value across the known spellings so the
// source id wins over the empty run-stamped column. Returns digits-only or ''.
const _SOURCE_MEMBER_ID_KEYS = [
  'Linkedin Membership ID', 'LinkedIn Membership ID', 'linkedin membership id',
  'Linkedin Member ID', 'LinkedIn Member ID', 'linkedin member id',
  'Member ID', 'member id', 'memberId', 'membershipId', 'membership id',
];

export function readSourceMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of _SOURCE_MEMBER_ID_KEYS) {
    if (k in row) {
      const digits = digitsOnly(row[k]);
      if (digits) return digits;
    }
  }
  return '';
}

/**
 * Decide whether a captured profile identity can be trusted as the intended
 * lead before stamping Connected / Already Connected and writing its URN.
 *
 * @param {object}  args
 * @param {string}  args.capturedMemberNumber - numeric member id read off the
 *   loaded profile (captureProfileMeta.memberNumber). Empty = profile did not
 *   resolve a real member → do NOT trust.
 * @param {string}  args.capturedUrn          - the AC**AA URN captured from the
 *   loaded page (captureProfileMeta.memberId).
 * @param {string}  args.leadUrl              - the lead's own LinkedIn URL from
 *   the sheet (extractLinkedInUrl), used for URN-token corroboration.
 * @param {string}  args.sourceMemberId       - the lead's known numeric member
 *   id from the sheet, if present. The strongest anchor when available.
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyConnectIdentity({
  capturedMemberNumber = '',
  capturedUrn = '',
  leadUrl = '',
  sourceMemberId = '',
} = {}) {
  const captured = digitsOnly(capturedMemberNumber);
  const source = digitsOnly(sourceMemberId);
  const leadBody = tokenBody(leadUrl);
  const capBody = tokenBody(capturedUrn);
  const urnComparable = !!(leadBody && capBody);
  const urnMatch = urnComparable && commonPrefixLen(leadBody, capBody) >= MIN_BODY_PREFIX;

  // 1) Hard contradiction first — both numeric ids are known and they DIFFER.
  //    That is the strongest "we loaded the wrong person" signal; never let a
  //    coincidental URN-token overlap override it.
  if (source && captured && captured !== source) {
    return { ok: false, reason: `member-number-mismatch (captured ${captured} ≠ lead ${source})` };
  }

  // 2) Positive confirmation — accept on EITHER strong signal, so a genuine
  //    lead isn't over-skipped when one signal is momentarily weak (e.g. a real
  //    profile loaded and its URN matches the lead, but Voyager hiccupped and
  //    returned no numeric id).
  if (source && captured && captured === source) {
    return { ok: true, reason: 'member-number-match' };
  }
  if (urnMatch) {
    return { ok: true, reason: 'urn-prefix-match' };
  }

  // 3) No numeric member id at all → we never resolved the lead's profile.
  //    This is the exact false-positive fingerprint from the incident.
  if (!captured) {
    return { ok: false, reason: 'no-member-number-captured (profile did not load)' };
  }

  // 4) A URN was captured and it points at a different profile than the lead.
  if (urnComparable && !urnMatch) {
    return { ok: false, reason: 'urn-prefix-mismatch (captured a different profile)' };
  }

  // 5) Real member id captured and nothing on the row refutes it. Trust it
  //    rather than over-skip.
  return { ok: true, reason: 'member-number-present-unverified' };
}
