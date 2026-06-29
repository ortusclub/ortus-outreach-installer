/**
 * Manual bulk reply sweep — identity-safe, preview-only inbox scan.
 *
 * Self-contained on purpose: reuses helpers.getConversationsPage +
 * fetchNewConversations but does NOT touch check-dms.js (the disabled
 * scheduler + its tests depend on it). Matching is identity-first
 * (URN/profileUrl), name only as a fallback, skip-on-doubt → unmatched.
 */

import * as helpers from './helpers.js';
import { updateSheetRow, appendReplyRow as _appendReplyRow } from '../sheets-writer.js';
import * as sheetsWriter from '../sheets-writer.js';

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

/** Numeric memberId from a sheet row ('Linkedin Membership ID' / 'Linkedin Member' / 'memberId' …). */
export function rowMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of ['Linkedin Membership ID', 'LinkedIn Membership ID', 'Linkedin Member', 'LinkedIn Member', 'Linkedin Member ID', 'memberId', 'Member ID']) {
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
 * Match ONE participant against the candidate rows. memberId → fsd → slug → name,
 * each: 1 hit → identity (name for the last stage), >1 → ambiguous, 0 → next.
 */
function matchParticipant(p, rows, linkedinColumn) {
  if (!p) return { row: null, reason: 'unmatched' };
  const mid = String(p.memberId || '').trim();
  if (/^\d{4,}$/.test(mid)) {
    const hits = rows.filter((r) => rowMemberId(r) === mid);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const fsd = String(p.fsdProfile || '').trim();
  if (fsd) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === fsd
      || String(r['LinkedIn URN'] || r['Linkedin URN'] || '').trim() === fsd);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const ptoken = identityToken(p.profileUrl);
  if (ptoken) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === ptoken);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const full = fullName(p.firstName, p.lastName);
  if (full) {
    const hits = rows.filter((r) => fullName(r.firstName || r['First Name'], r.lastName || r['Last Name']) === full);
    if (hits.length === 1) return { row: hits[0], reason: 'name' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  return { row: null, reason: 'unmatched' };
}

/**
 * Identity-safe match, GROUP-AWARE. In a 3-way CC+IC thread the participants are
 * [the campaign account ("me", excluded by the parser), the lead, the primary
 * person]. The lead is NOT necessarily participants[0] (it's often the primary),
 * so we test EVERY participant against the leads and return the matched LEAD.
 * Returns { row, reason, lead } — `lead` is the matched participant (for correct
 * name/direction attribution). >1 distinct lead row → ambiguous (skip-on-doubt).
 */
export function matchConversationIdentitySafe(conv, candidateRows, linkedinColumn) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const parts = (Array.isArray(conv?.participants) && conv.participants.length)
    ? conv.participants
    : (conv?.participant ? [conv.participant] : []);
  if (!parts.length) return { row: null, reason: 'unmatched', lead: null };

  const matched = [];           // { row, lead, reason }
  let sawAmbiguous = false;
  for (const p of parts) {
    const r = matchParticipant(p, rows, linkedinColumn);
    if (r.reason === 'ambiguous') sawAmbiguous = true;
    else if (r.row) matched.push({ row: r.row, lead: p, reason: r.reason });
  }
  const uniq = [...new Map(matched.map((x) => [x.row, x])).values()];
  if (uniq.length === 1) return { row: uniq[0].row, reason: uniq[0].reason, lead: uniq[0].lead };
  if (uniq.length > 1) return { row: null, reason: 'ambiguous', lead: null };   // two leads in one thread
  if (sawAmbiguous) return { row: null, reason: 'ambiguous', lead: null };
  return { row: null, reason: 'unmatched', lead: null };
}

function previewOf(conv, row, linkedinColumn, lead) {
  // Attribute to the matched lead (groups: NOT participants[0], which may be the primary).
  const p = lead || (Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null));
  const last = conv?.lastMessage || null;
  const isGroup = conv?.groupChat === true ||
    (Array.isArray(conv?.participants) && conv.participants.length > 1);
  return {
    leadName: p ? `${p.firstName || ''} ${p.lastName || ''}`.replace(/\s+/g, ' ').trim() : '(unknown)',
    snippet: String(last?.text || '').slice(0, 160),
    fullText: String(last?.text || ''),
    profileUrl: p?.profileUrl || '',
    memberId: p?.memberId || '',
    threadId: conv?.threadId || '',
    timestamp: last?.deliveredAt || conv?.lastActivityAt || null,
    linkedinUrl: row ? rowLinkedinUrl(row, linkedinColumn) : (p?.profileUrl || ''),
    row: row || null,
    suspected: false,
    isGroup,
    // Who actually wrote the last message (so the UI can show "Luca replied",
    // not the primary). Empty when the parser couldn't resolve a sender.
    lastSender: [last?.actor?.firstName, last?.actor?.lastName].filter(Boolean).join(' ').trim(),
  };
}

/** True when the LEAD (matched participant) sent the last message — not us, not the primary. */
function leadSentLast(conv, lead) {
  const last = conv?.lastMessage || null;
  if (!last || !lead) return false;
  const senderMid = String(last.actor?.memberId || '').trim();
  const leadMid = String(lead.memberId || '').trim();
  if (senderMid && leadMid) return senderMid === leadMid;        // exact, group-safe
  // memberId missing on the message actor → fall back to name/url comparison.
  const sUrl = last.actor?.profileUrl, lUrl = lead.profileUrl;
  if (sUrl && lUrl) return sUrl === lUrl;
  const sName = fullName(last.actor?.firstName, last.actor?.lastName);
  const lName = fullName(lead.firstName, lead.lastName);
  return !!(sName && sName === lName);
}

/**
 * Split conversations into matched campaign replies vs unmatched new replies.
 * Group-aware: a thread is a campaign reply only when a campaign LEAD is a
 * participant AND that lead sent the last message (so the primary's own intro
 * message is never mistaken for the lead replying).
 */
export function classifyConversations(convs, candidateRows, linkedinColumn) {
  const campaignReplies = [];
  const unmatched = [];
  for (const conv of (Array.isArray(convs) ? convs : [])) {
    const m = matchConversationIdentitySafe(conv, candidateRows, linkedinColumn);
    const inbound = isInboundConversation(conv);
    if (m.reason === 'identity' || m.reason === 'name') {
      // A campaign lead is in this thread. Surface as a reply only when the LEAD
      // spoke last (group-safe); if the actor carries no memberId, fall back to
      // the coarse inbound signal so 1:1 DM threads still work.
      const hasActorMid = !!String(conv?.lastMessage?.actor?.memberId || '').trim();
      if (leadSentLast(conv, m.lead) || (!hasActorMid && inbound)) {
        campaignReplies.push(previewOf(conv, m.row, linkedinColumn, m.lead));
      }
      // else: we / the primary spoke last → not a fresh lead reply; skip silently.
    } else if (inbound) {
      // No campaign lead in the thread, but someone messaged us → unmatched bucket.
      const item = previewOf(conv, null, linkedinColumn, null);
      item.suspected = (m.reason === 'ambiguous');
      unmatched.push(item);
    }
  }
  return { campaignReplies, unmatched };
}

// ── Dependency injection (test hook; mirrors check-dms.js) ───────────────────
const _realDeps = {
  async getConversationsPage(page, opts) { return helpers.getConversationsPage(page, opts); },
  async getSheetRowStatus(sheetUrl, url, col) { return sheetsWriter.getSheetRowStatus(sheetUrl, url, col); },
  async updateSheetRow(sheetUrl, url, tracking, col) { return updateSheetRow(sheetUrl, url, tracking, col); },
  async appendReplyRow(sheetUrl, reply) { return _appendReplyRow(sheetUrl, reply); },
};
let _deps = { ..._realDeps };
export function _setDeps(stubs) { _deps = stubs === null ? { ..._realDeps } : { ..._realDeps, ...stubs }; }

/** Non-destructive: don't overwrite a row already marked Reply=yes. */
export function shouldWriteReply(currentStatus, _newReply) {
  if (!currentStatus) return true;
  return String(currentStatus.Reply || '').toLowerCase().trim() !== 'yes';
}

export function makeInitialSweepStatus(profileNames, dryRun) {
  const names = Array.isArray(profileNames) ? profileNames : [];
  return {
    running: true, phase: 'scanning', dryRun: !!dryRun,
    totalProfiles: names.length, doneProfiles: 0, currentProfile: null,
    campaignReplies: [], unmatched: [], wrote: 0,
    perProfile: names.map((n) => ({ profileName: n, status: 'waiting', replies: 0, unmatched: 0, error: '' })),
    logs: [], error: null,
  };
}

/**
 * Write matched campaign replies to the sheet (Replies tab + Reply/Stage).
 * Non-destructive + per-row isolated. Only called when dry-run is OFF.
 */
export async function applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies }) {
  let wrote = 0, skipped = 0;
  const errors = [];
  for (const r of (campaignReplies || [])) {
    const url = r.linkedinUrl || '';
    if (!url) { errors.push(`missing LinkedIn URL for ${r.leadName || '(unknown)'}`); continue; }
    try {
      const current = await _deps.getSheetRowStatus(sheetUrl, url, linkedinColumn);
      if (!shouldWriteReply(current, r)) { skipped++; continue; }
      const tsIso = new Date(r.timestamp || Date.now()).toISOString();
      await _deps.appendReplyRow(sheetUrl, {
        leadUrl: url, timestamp: tsIso, direction: 'in', sender: r.leadName || 'lead', body: String(r.snippet || ''),
      });
      await _deps.updateSheetRow(sheetUrl, url, {
        Reply: 'yes', ReplyAt: tsIso, ReplyPreview: String(r.snippet || '').slice(0, 100), stage: 'Replied',
      }, linkedinColumn);
      wrote++;
    } catch (e) {
      errors.push(`write-back failed for ${url}: ${e.message}`);
    }
  }
  return { wrote, skipped, errors };
}

/** Navigate /messaging/, wait for the conversations XHR, fetch + paginate, filter by watermark. */
export async function loadInboxConversations(page, { watermark = 0, log = () => {} } = {}) {
  try {
    if (typeof page.goto === 'function') {
      try {
        await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        return { convs: [], error: `couldn't open inbox: ${e.message}` };
      }
      if (typeof page.waitForFunction === 'function') {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          await page.evaluate(() => {
            const list = document.querySelector('.msg-conversations-container__conversations-list, ul[class*="conversations-list"], .scaffold-layout__list-detail, .scaffold-layout__list');
            if (list) { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll', { bubbles: true })); }
            window.scrollTo(0, document.body.scrollHeight);
          });
        } catch { /* best-effort nudge */ }
        try {
          await page.waitForFunction(
            () => performance.getEntriesByType('resource').some((e) => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations')),
            { timeout: 20000 },
          );
        } catch { /* fall through — getConversationsPage will return null */ }
      }
    }

    let first;
    try { first = await _deps.getConversationsPage(page, { start: 0, count: 20 }); }
    catch (e) { return { convs: [], error: `couldn't read inbox: ${e.message}` }; }
    if (first === null || first === undefined) {
      return { convs: [], error: "couldn't load inbox for this account (rate-limited or session expired) — try again" };
    }

    const convs = (first.elements || []).filter((el) => (el.lastActivityAt || 0) > watermark);
    const firstOldest = (first.elements || []).reduce((min, e) => Math.min(min, e.lastActivityAt || 0), Number.POSITIVE_INFINITY);
    const paging = first.paging;
    const maybeMore = firstOldest > watermark && (!paging || !paging.total || 20 < paging.total);
    if (maybeMore && (first.elements || []).length >= 20) {
      let start = 20;
      for (let pages = 0; pages < 9; pages++) {
        let batch;
        try { batch = await _deps.getConversationsPage(page, { start, count: 20 }); }
        catch { break; }
        if (!batch || !Array.isArray(batch.elements) || batch.elements.length === 0) break;
        for (const el of batch.elements) { if ((el.lastActivityAt || 0) > watermark) convs.push(el); }
        const oldest = batch.elements.reduce((min, e) => Math.min(min, e.lastActivityAt || 0), Number.POSITIVE_INFINITY);
        if (oldest <= watermark) break;
        start += 20;
      }
    }
    return { convs, error: '' };
  } catch (e) {
    return { convs: [], error: `inbox scan failed: ${e.message}` };
  }
}

/** Preview-only sweep for one profile. Never throws — per-profile isolated. */
export async function sweepProfileInbox({ page, sheetUrl, linkedinColumn, candidateRows, watermark = 0, log = () => {} }) {
  const { convs, error } = await loadInboxConversations(page, { watermark, log });
  if (error) return { campaignReplies: [], unmatched: [], conversationsScanned: 0, error };
  const { campaignReplies, unmatched } = classifyConversations(convs, candidateRows, linkedinColumn);
  return { campaignReplies, unmatched, conversationsScanned: convs.length, error: '' };
}
