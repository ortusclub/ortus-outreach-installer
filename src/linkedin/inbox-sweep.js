/**
 * Manual bulk reply sweep — identity-safe, preview-only inbox scan.
 *
 * Self-contained on purpose: reuses helpers.getConversationsPage +
 * fetchNewConversations but does NOT touch check-dms.js (the disabled
 * scheduler + its tests depend on it). Matching is identity-first
 * (URN/profileUrl), name only as a fallback, skip-on-doubt → unmatched.
 */

// Member-URN encoding shared with outreach.js / check-dms.js.
const SALES_MEMBER_URN_RE = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;
const URN_RE = /^AC[A-Za-z0-9_-]+$/;

/** Canonical match token from a LinkedIn URL. URN (case-kept) > vanity slug (lowercased) > null. */
export function identityToken(linkedinUrl) {
  if (!linkedinUrl) return null;
  const url = String(linkedinUrl);
  const sales = url.match(SALES_MEMBER_URN_RE);
  if (sales) return sales[1];
  const inMatch = url.match(/\/in\/([^/?#,]+)/);
  if (inMatch) {
    const id = inMatch[1];
    return URN_RE.test(id) ? id : id.toLowerCase();
  }
  return null;
}

/** identityToken of the conversation's (single) participant. */
export function conversationToken(conv) {
  const p = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  return p ? identityToken(p.profileUrl) : null;
}

/** The row's LinkedIn URL: configured column > 'Linkedin URL' > first linkedin.com value > ''. */
export function rowLinkedinUrl(row, linkedinColumn) {
  if (!row || typeof row !== 'object') return '';
  if (linkedinColumn && row[linkedinColumn]) return String(row[linkedinColumn]);
  if (row['Linkedin URL']) return String(row['Linkedin URL']);
  for (const k of Object.keys(row)) {
    const v = String(row[k] || '');
    if (v.includes('linkedin.com')) return v;
  }
  return '';
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fullName(firstName, lastName) {
  return `${normName(firstName)} ${normName(lastName)}`.trim();
}

/** Numeric memberId from a sheet row ('Linkedin Member' / 'Linkedin Member ID' / 'memberId'). */
export function rowMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of ['Linkedin Member', 'LinkedIn Member', 'Linkedin Member ID', 'memberId', 'Member ID']) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{4,}$/.test(v)) return v;
  }
  // Fallback: any column whose value is a bare numeric id of plausible length.
  for (const k of Object.keys(row)) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{6,}$/.test(v)) return v;
  }
  return '';
}

/**
 * True when the lead sent the last message. Prefer the parser's authoritative
 * `lastMessage.isInbound` (sender ≠ viewer); fall back to actor/name comparison
 * only for legacy/test shapes that don't carry it.
 */
export function isInboundConversation(conv) {
  const last = conv?.lastMessage || null;
  if (!last) return false;
  if (typeof last.isInbound === 'boolean') return last.isInbound;
  const participant = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  if (!participant) return false;
  const actor = last.actor || {};
  const sameUrl = participant.profileUrl && actor.profileUrl && participant.profileUrl === actor.profileUrl;
  const sameName = participant.firstName && actor.firstName &&
    fullName(participant.firstName, participant.lastName) === fullName(actor.firstName, actor.lastName);
  return !!(sameUrl || sameName);
}

/**
 * Identity-first match. Token (URN/slug) exact match first; name only when the
 * token side is empty on either party. >1 candidate at any stage → ambiguous
 * (skip-on-doubt) so we never stamp the wrong row.
 */
export function matchConversationIdentitySafe(conv, candidateRows, linkedinColumn) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const participant0 = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);

  // 1. Numeric memberId — the only anchor that survives the ACwAA(sheet)/ACoAA(inbox)
  //    encoding gap. Exact, free (both sides already carry it).
  const cMemberId = String(participant0?.memberId || '').trim();
  if (/^\d{4,}$/.test(cMemberId)) {
    const hits = rows.filter((r) => rowMemberId(r) === cMemberId);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
    // 0 → fall through (sheet row may predate memberId capture).
  }

  // 2. ACoAA fsd_profile token — secondary exact key when memberId is blank on a side.
  const cFsd = String(participant0?.fsdProfile || '').trim();
  if (cFsd) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === cFsd
      || String(r['LinkedIn URN'] || r['Linkedin URN'] || '').trim() === cFsd);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }

  // 3. Legacy slug token (only matches when both sides share an encoding).
  const ctoken = conversationToken(conv);
  if (ctoken) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === ctoken);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }

  const participant = participant0;
  const convFull = participant ? fullName(participant.firstName, participant.lastName) : '';
  if (!convFull) return { row: null, reason: 'unmatched' };

  const nameHits = rows.filter((r) =>
    fullName(r.firstName || r['First Name'], r.lastName || r['Last Name']) === convFull);
  if (nameHits.length === 1) return { row: nameHits[0], reason: 'name' };
  if (nameHits.length > 1) return { row: null, reason: 'ambiguous' };
  return { row: null, reason: 'unmatched' };
}
