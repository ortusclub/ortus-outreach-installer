/**
 * Check DMs orchestrator + pure functions — Phase 11.3 / 2.9.7.
 *
 * 2.9.7 rewrite — per-lead targeted thread scrape. The previous bulk-inbox
 * Voyager scan (`checkProfileDms`) is preserved for back-compat + tests, but
 * the production server route now uses `checkProfileDmsPerLead` which:
 *   1. Receives a list of pre-filtered leads (Sender column → profileId)
 *   2. Navigates to /messaging/compose/?recipient=<publicId> per lead
 *   3. DOM-scrapes the visible thread
 *   4. Appends every message to the Replies tab (bridge dedupes)
 *   5. Bumps Stage to 'Replied' if any inbound message exists
 *
 * Public exports:
 *   - checkProfileDms(profileId, opts) — legacy bulk-inbox Voyager scan
 *   - checkProfileDmsPerLead(profileId, leads, opts) — 2.9.7 per-lead scrape
 *   - extractDmThreadFromPage(page, leadPublicId) — DOM scraper
 *   - extractPublicIdFromUrl(url) — utility
 *   - fetchNewConversations(pageFactory, watermark) — pagination
 *   - matchConversationToSheet(conv, rows) — pure match logic
 *   - shouldWriteReply(currentStatus, newReply) — non-destructive predicate
 *   - performWriteBack(sheetUrl, url, reply, linkedinColumn) — write to sheet
 *   - _setDeps(stubs | null) — test hook; null resets to production deps
 */

import * as helpers from './helpers.js';
import { updateSheetRow, appendReplyRow } from '../sheets-writer.js';
import * as sheetsWriter from '../sheets-writer.js';
import { launchProfile, closeProfile, getProfiles } from '../gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from '../local-launcher.js';
import { fetchSheet } from '../sheets.js';

// ── Dependency injection ─────────────────────────────────────────────────────
// check-dms.js manages its own browser session lifecycle rather than reusing
// campaign.js's internal `ensureOpen` / `closeSession` — those are closures
// inside startCampaign() and reaching into them would violate the preservation
// contract in 11.3-CONTEXT.md. Session mgmt here is intentionally simpler
// (single-profile, no batch loop, no parking) — check-dms is a lighter flow.

const _realDeps = {
  async getConversationsPage(page, opts) { return helpers.getConversationsPage(page, opts); },
  async getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn) {
    return sheetsWriter.getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn);
  },
  async updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn) {
    return updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn);
  },
  async appendReplyRow(sheetUrl, reply) {
    return appendReplyRow(sheetUrl, reply);
  },
  async ensureOpen(profileId) {
    if (profileId === 'local-browser') {
      const launched = await launchLocalBrowser();
      return { page: launched.page, browser: launched.browser, profileId, pName: 'Local Browser' };
    }
    const token = process.env.GOLOGIN_API_TOKEN;
    // P-01 fix (2.8.18): look up the real GoLogin profile NAME so it matches
    // what campaign.js writes into the "Account Used" sheet column. Previously
    // pName was set to profileId (a hashed GoLogin internal id) which never
    // matched the human-readable name in the sheet → getCandidateRows always
    // returned [] → Check DMs silently reported 0 replies on every run.
    let pName = profileId;
    try {
      const profiles = await getProfiles(token);
      const found = profiles.find(p => p.id === profileId);
      if (found && found.name) pName = found.name;
    } catch { /* getProfiles is cached; if it fails fall back to profileId */ }
    const launched = await launchProfile(profileId, token);
    return { page: launched.page, browser: launched.browser, profileId, pName };
  },
  async closeSession(profileId) {
    if (profileId === 'local-browser') return closeLocalBrowser();
    return closeProfile(profileId);
  },
  async getCandidateRows(profileName, sheetUrl) {
    // P-01 fix (2.8.18): filter by profile NAME, not profileId — see ensureOpen
    // comment above. The Sender column holds the value written by campaign.js,
    // which is pName (e.g. "matt.adcock@ortus.solutions"), not the GoLogin
    // internal profile id. v2.11.11: migrated from "Account Used" to "Sender".
    const rows = await fetchSheet(sheetUrl);
    return rows.filter(r =>
      (r.Message || '').toString().toLowerCase() === 'sent' &&
      ((r.Sender || r.sender) || '').toString() === profileName
    );
  },
};

let _deps = { ..._realDeps };

export function _setDeps(stubs) {
  if (stubs === null) {
    _deps = { ..._realDeps };
  } else {
    _deps = { ..._realDeps, ...stubs };
  }
}

// ── Pure functions ───────────────────────────────────────────────────────────

/**
 * Normalize a name fragment for matching (lowercase, trim, collapse whitespace).
 */
function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Match a normalized conversation (1 participant) against a set of sheet rows.
 * Caller is responsible for pre-filtering rows to the running profile's scope
 * (Message='sent' AND Account Used = profileId).
 *
 * Returns one of:
 *   { match: row }                            — exact single match
 *   { match: null, reason: 'unmatched' }      — no row matched
 *   { match: null, reason: 'ambiguous', candidates: [rows] }  — >1 row matched
 */
export function matchConversationToSheet(conv, candidateRows) {
  // Accept either { participant: {...} } (simple test shape) or
  // { participants: [{...}] } (normalized production shape).
  const participant = conv?.participant
    ?? (Array.isArray(conv?.participants) ? conv.participants[0] : null);
  if (!participant) return { match: null, reason: 'unmatched' };

  const convFirst = normName(participant.firstName);
  const convLast = normName(participant.lastName);
  const convFull = `${convFirst} ${convLast}`.trim();

  const matches = (candidateRows || []).filter(r => {
    const rowFull = `${normName(r.firstName || r['First Name'])} ${normName(r.lastName || r['Last Name'])}`.trim();
    return rowFull === convFull && convFull !== '';
  });

  if (matches.length === 0) return { match: null, reason: 'unmatched' };
  if (matches.length > 1) return { match: null, reason: 'ambiguous', candidates: matches };
  return { match: matches[0] };
}

/**
 * Non-destructive predicate: returns false if the row's Reply column already
 * contains "yes" (preserves manual edits). True when empty / missing / null.
 */
export function shouldWriteReply(currentStatus, _newReply) {
  if (!currentStatus) return true;
  const v = String(currentStatus.Reply || '').toLowerCase().trim();
  return v !== 'yes';
}

/**
 * Pagination driver. Iterates pages from pageFactory, short-circuits as soon
 * as a page's oldest message is at-or-older than the watermark.
 *
 * pageFactory: async ({start, count}) => {elements: [...], paging?: {total}, metadata?}
 * watermark:   ms timestamp; only conversations with lastActivityAt > watermark return
 */
export async function fetchNewConversations(pageFactory, watermark) {
  const result = [];
  let start = 0;
  const count = 20;
  // Hard safety cap to avoid runaway loops if schema drifts
  const MAX_PAGES = 10;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const batch = await pageFactory({ start, count });
    if (!batch || !Array.isArray(batch.elements) || batch.elements.length === 0) break;
    for (const el of batch.elements) {
      if ((el.lastActivityAt || 0) > watermark) result.push(el);
    }
    const oldest = batch.elements.reduce(
      (min, e) => Math.min(min, e.lastActivityAt || 0),
      Number.POSITIVE_INFINITY
    );
    if (oldest <= watermark) break;
    const paging = batch.paging;
    if (paging && typeof paging.total === 'number' && start + count >= paging.total) break;
    start += count;
  }
  return result;
}

// ── I/O writeback ────────────────────────────────────────────────────────────

/**
 * Non-destructive reply writeback. Calls getSheetRowStatus → shouldWriteReply
 * → updateSheetRow. Exported for the integration test in Plan 11.3-05.
 *
 * Returns { wrote: true } on write, { wrote: false, reason } on skip.
 */
export async function performWriteBack(sheetUrl, linkedinUrl, reply, linkedinColumn) {
  const current = await _deps.getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn);
  if (!shouldWriteReply(current, reply)) {
    return { wrote: false, reason: 'already-replied' };
  }
  const tracking = {
    Reply: 'yes',
    ReplyAt: new Date(reply.deliveredAt || Date.now()).toISOString(),
    ReplyPreview: String(reply.text || '').slice(0, 100),
  };
  await _deps.updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn);
  return { wrote: true };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run a Check DMs scan for one profile.
 *
 * Returns {
 *   replies: [{ match, conversation, snippet }...],
 *   ambiguous: [{ conv, candidates }...],
 *   errors: [string...],
 *   newWatermark?: number   // undefined on failure → caller must NOT advance
 * }
 */
export async function checkProfileDms(profileId, { watermark = 0, sheetUrl, linkedinColumn, page = null, pName = null }) {
  const startTime = Date.now();
  const replies = [];
  const ambiguous = [];
  const errors = [];
  // v2.72: inbound replies in 1:1 threads (groups ignored), last message only —
  // dumped to the "Recent Messages" sidecar tab by the caller.
  const recentMessages = [];

  // v2.72: optional pre-opened page (mid-campaign reply check reusing a paused
  // profile's browser). When supplied we reuse it and must NOT close it.
  let session = null;
  let _ownSession = false;
  try {
    if (page) {
      session = { page, profileId, pName: pName || profileId };
    } else {
      session = await _deps.ensureOpen(profileId);
      _ownSession = true;
    }
    if (!session || !session.page) {
      return { replies, ambiguous, errors: ['ensureOpen returned no session'] };
    }

    // 2.9.6: Navigate to LinkedIn's messaging inbox so the Voyager
    // messengerConversations XHR fires. getConversationsPage scrapes the URL
    // from performance.getEntriesByType('resource') — without this navigation
    // the entry list is empty and getConversationsPage returns null, ending
    // the scan instantly with the browser flashing open and closed.
    // Guarded with `typeof === 'function'` so unit-test mock pages (plain
    // objects without puppeteer methods) don't crash the orchestrator.
    if (typeof session.page.goto === 'function') {
      try {
        await session.page.goto('https://www.linkedin.com/messaging/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (e) {
        return { replies, ambiguous, errors: [`navigation to /messaging/ failed: ${e.message}`] };
      }
      // v2.72: LinkedIn loads the inbox lazily, so the messengerConversations
      // XHR doesn't always fire on plain navigation — give it time AND nudge it
      // by scrolling the conversation list, then poll the performance entries
      // for up to ~20s (was 8s, which was timing out and yielding 0 results).
      if (typeof session.page.waitForFunction === 'function') {
        await new Promise(r => setTimeout(r, 2500));
        try {
          await session.page.evaluate(() => {
            const list = document.querySelector(
              '.msg-conversations-container__conversations-list, ' +
              'ul[class*="conversations-list"], .scaffold-layout__list-detail, .scaffold-layout__list'
            );
            if (list) {
              list.scrollTop = list.scrollHeight;
              list.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
            window.scrollTo(0, document.body.scrollHeight);
          });
        } catch { /* best-effort nudge */ }
        try {
          await session.page.waitForFunction(
            () => performance.getEntriesByType('resource')
              .some(e => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations')),
            { timeout: 20000 },
          );
        } catch { /* fall through — getConversationsPage will return null and we surface a clean error */ }
      }
    }

    // Fetch the first page directly (avoids double-fetch). If the first page
    // isn't enough (oldest still newer than watermark AND total indicates more),
    // fetchNewConversations paginates from start=count using the same factory.
    let first;
    try {
      first = await _deps.getConversationsPage(session.page, { start: 0, count: 20 });
    } catch (e) {
      return { replies, ambiguous, errors: [`getConversationsPage threw: ${e.message}`] };
    }

    if (first === null || first === undefined) {
      return { replies, ambiguous, errors: ['Voyager returned null — scan failed; watermark NOT advanced'] };
    }

    // Filter first page for new-only
    const convs = [];
    for (const el of first.elements || []) {
      if ((el.lastActivityAt || 0) > watermark) convs.push(el);
    }

    // If the first page may not have reached the watermark, keep paginating.
    const firstOldest = (first.elements || []).reduce(
      (min, e) => Math.min(min, e.lastActivityAt || 0),
      Number.POSITIVE_INFINITY,
    );
    const paging = first.paging;
    const maybeMore = firstOldest > watermark &&
      (!paging || !paging.total || 20 < paging.total);
    if (maybeMore && (first.elements || []).length >= 20) {
      const pageFactory = async (opts) => _deps.getConversationsPage(session.page, opts);
      // Continue from start=20; fetchNewConversations handles stop-on-old + MAX_PAGES.
      const extra = await fetchNewConversations(
        async ({ start, count }) => pageFactory({ start: start + 20, count }),
        watermark,
      );
      convs.push(...extra);
    }

    // P-01 fix (2.8.18): pass profile NAME (matches what campaign.js writes
    // into "Account Used"), not profileId.
    const candidateRows = await _deps.getCandidateRows(session.pName, sheetUrl);

    for (const conv of convs) {
      const lastMessage = conv.lastMessage || null;
      // v2.72: did the LEAD send the last message (inbound reply) or did we?
      const _leadP = (Array.isArray(conv.participants) && conv.participants[0]) || null;
      let _inbound = false;
      if (lastMessage) {
        const _actor = lastMessage.actor || {};
        const _sameUrl = _leadP?.profileUrl && _actor?.profileUrl && _leadP.profileUrl === _actor.profileUrl;
        const _sameName = _leadP?.firstName && _actor?.firstName
          && normName(_leadP.firstName) === normName(_actor.firstName)
          && normName(_leadP.lastName || '') === normName(_actor.lastName || '');
        _inbound = !!(_sameUrl || _sameName);
      }
      const _convName = [_leadP?.firstName, _leadP?.lastName].filter(Boolean).join(' ').trim();
      const match = matchConversationToSheet(conv, candidateRows);

      // v2.72: Recent Messages dump — inbound replies in 1:1 threads only
      // (participants holds just the other person; >1 means a group → skip),
      // last message only. Captured regardless of whether it matched a lead.
      const _participantCount = Array.isArray(conv.participants) ? conv.participants.length : 1;
      if (_inbound && _participantCount === 1 && lastMessage) {
        recentMessages.push({
          account: session.pName || profileId,
          name: _convName,
          lastMessage: lastMessage.text || '',
          receivedAt: lastMessage.deliveredAt ? new Date(lastMessage.deliveredAt).toISOString() : '',
          matched: !!(match && match.match),
        });
      }

      if (match.reason === 'ambiguous') {
        // v2.72: same-name leads → can't attribute uniquely. Flag as a suspected
        // reply for manual review instead of stamping the wrong campaign row.
        ambiguous.push({
          conv, candidates: match.candidates,
          inbound: _inbound, name: _convName,
          snippet: lastMessage?.text || '',
          timestamp: lastMessage?.deliveredAt || conv.lastActivityAt,
        });
        continue;
      }
      if (match.reason === 'unmatched') continue;

      const linkedinUrl = match.match['Linkedin URL'] || match.match[linkedinColumn] || '';
      if (lastMessage && linkedinUrl) {
        try {
          // 2.9.4: detect direction. The conversation has one participant
          // (the lead). If lastMessage.actor matches that participant, the
          // lead replied (inbound). Otherwise the bot/operator sent it (outbound).
          const leadParticipant = (Array.isArray(conv.participants) && conv.participants[0]) || null;
          const actor = lastMessage.actor || {};
          const sameProfileUrl = leadParticipant?.profileUrl && actor?.profileUrl
            && leadParticipant.profileUrl === actor.profileUrl;
          const sameName = leadParticipant?.firstName && actor?.firstName
            && normName(leadParticipant.firstName) === normName(actor.firstName)
            && normName(leadParticipant.lastName || '') === normName(actor.lastName || '');
          const direction = (sameProfileUrl || sameName) ? 'in' : 'out';
          const senderName = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim()
            || (direction === 'in' ? 'lead' : (session.pName || 'unknown'));
          const tsIso = new Date(lastMessage.deliveredAt || startTime).toISOString();

          // Append the full message body to the Replies tab. Bridge dedupes
          // on (leadUrl, timestamp) so safe to call repeatedly.
          await _deps.appendReplyRow(sheetUrl, {
            leadUrl: linkedinUrl,
            timestamp: tsIso,
            direction,
            sender: senderName,
            body: String(lastMessage.text || ''),
          });

          // Legacy back-compat writes — Reply / ReplyAt / ReplyPreview.
          // Plus bump Pipeline Stage to 'Replied' when the lead replied,
          // regardless of prior stage (per user direction).
          const current = await _deps.getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn);
          if (shouldWriteReply(current, lastMessage)) {
            const tracking = {
              Reply: 'yes',
              ReplyAt: tsIso,
              ReplyPreview: String(lastMessage.text || '').slice(0, 100),
            };
            if (direction === 'in') {
              tracking.stage = 'Replied';
            }
            await _deps.updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn);
          }
        } catch (e) {
          errors.push(`writeback failed for ${linkedinUrl}: ${e.message}`);
        }
      }

      replies.push({
        match: match.match,
        conversation: conv,
        snippet: lastMessage?.text || '',
        threadId: conv.threadId,
        timestamp: lastMessage?.deliveredAt || conv.lastActivityAt,
        inbound: _inbound,
        leadUrl: linkedinUrl,
        name: _convName,
      });
    }

    return { replies, ambiguous, errors, recentMessages, newWatermark: startTime };
  } catch (e) {
    return { replies, ambiguous, errors: [`checkProfileDms threw: ${e.message}`], recentMessages };
  } finally {
    if (session && _ownSession) {
      try { await _deps.closeSession(profileId); } catch { /* best-effort */ }
    }
  }
}

// ── 2.9.7 Per-lead targeted thread scrape ────────────────────────────────────

// Sales Navigator URN encoding — same regex outreach.js uses for the
// /sales/lead/<urn> ↔ /in/<urn> transform. We can recover the publicId
// slug from any Sales Nav URL that has an encoded member URN; vanity
// Sales Nav URLs (rare) cannot be converted without visiting the page.
const SALES_MEMBER_URN_RE = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;

/**
 * Extract the publicId slug from a LinkedIn URL.
 *
 * Handles:
 *   - /in/<slug>             → returns slug
 *   - /sales/lead/<urn>      → returns urn (the encoded URN works as a
 *                              recipient= value, identical to /in/<urn>)
 *   - /sales/people/<urn>    → ditto
 *
 * Returns null for unrecognized shapes (caller should skip + log).
 */
export function extractPublicIdFromUrl(linkedinUrl) {
  if (!linkedinUrl) return null;
  const url = String(linkedinUrl);
  const m1 = url.match(/\/in\/([^/?#]+)/);
  if (m1) return m1[1];
  const m2 = url.match(SALES_MEMBER_URN_RE);
  if (m2) return m2[1];
  return null;
}

/**
 * Stable content-derived dedup key. Bridge dedupes appendReply rows by
 * (leadUrl, timestamp). DOM-scraped messages have no reliable timestamp,
 * so we hash the body to produce a stable key — re-runs of the same
 * thread produce the same keys, so the bridge silently dedupes.
 */
function stableMessageKey(direction, body) {
  const s = `${direction}|${String(body || '').trim()}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `msg-${Math.abs(h).toString(36)}`;
}

/**
 * Read the running account's identity from Voyager /me.
 *
 * 2.9.7 v3: data-event-urn turned out to be the MAILBOX-OWNER URN, NOT
 * the sender's URN. So URN-based direction detection doesn't work. We
 * fall back to the most stable per-message signal: the operator's full
 * NAME ("Antonio Varlese"), which appears in the name element of every
 * outbound message bubble.
 *
 * Returns { fullName, slug } or { fullName: null, slug: null } on failure.
 */
async function getRunningAccountIds(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const csrfCookie = document.cookie.split(';')
          .map(c => c.trim())
          .find(c => c.startsWith('JSESSIONID='));
        const csrf = csrfCookie?.split('=')[1]?.replace(/"/g, '');
        if (!csrf) return { fullName: null, slug: null };
        const resp = await fetch('/voyager/api/me', {
          credentials: 'include',
          headers: { 'csrf-token': csrf },
        });
        if (!resp.ok) return { fullName: null, slug: null };
        const data = await resp.json();
        const mp = data?.miniProfile || data?.data?.miniProfile || null;
        if (mp) {
          const fn = (mp.firstName || '').trim();
          const ln = (mp.lastName || '').trim();
          const fullName = `${fn} ${ln}`.replace(/\s+/g, ' ').trim();
          return { fullName: fullName || null, slug: mp.publicIdentifier || null };
        }
        return { fullName: null, slug: null };
      } catch {
        return { fullName: null, slug: null };
      }
    });
  } catch {
    return { fullName: null, slug: null };
  }
}

/**
 * Scrape the visible message thread from a LinkedIn /messaging/compose page.
 *
 * 2.9.7 v3 — uses NAME-based direction detection.
 *
 * Why not URN: data-event-urn carries the mailbox-owner URN (the running
 * account, identical for every message in the thread), NOT the sender.
 * Verified empirically: 5 messages from 3 different senders all had the
 * same URN segment.
 *
 * Why name works: each outbound bubble has a name element containing the
 * operator's display name ("Antonio Varlese"), and inbound bubbles have
 * the lead's name. We pull the operator's full name from Voyager /me
 * (firstName + lastName) and compare exact strings.
 *
 * Items are restricted to the VISIBLE message-list container. LinkedIn
 * caches recent threads' DOM as separate hidden containers — without
 * scoping we'd pick up messages from other (cached) conversations.
 *
 * Returns { sender, direction, body, time } per message in DOM order.
 */
export async function extractDmThreadFromPage(page, leadPublicId) {
  const { fullName: meName, slug: meSlug } = await getRunningAccountIds(page);

  const raw = await page.evaluate(({ meName, meSlug, leadPublicId }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // Find the VISIBLE message-list container. LinkedIn caches recently
    // viewed threads in DOM as separate hidden containers; only the
    // active one has non-zero dimensions.
    const containers = document.querySelectorAll(
      '.msg-s-message-list-content, [class*="msg-s-message-list-content"]'
    );
    let activeContainer = null;
    for (const c of containers) {
      const rect = c.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { activeContainer = c; break; }
    }
    if (!activeContainer && containers.length > 0) {
      activeContainer = containers[0];
    }

    // Pattern for date-marker text ("Apr 17", "TODAY", "Yesterday", etc.).
    // We walk the children of the message list in DOM order, watching for
    // any element whose text content matches this pattern — that becomes
    // the "current date" stamped on every following message group until
    // the next marker is seen.
    const DATE_RE = /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
    const isDateMarker = (t) => {
      const s = (t || '').trim();
      if (!s || s.length > 30) return false;
      return DATE_RE.test(s);
    };

    // Walk in DOM order so we visit date markers BEFORE the messages
    // that follow them. activeContainer's direct children include both
    // message items and date-line wrappers.
    const walker = activeContainer
      ? activeContainer.querySelectorAll('*')
      : document.querySelectorAll('.msg-s-message-list-content *');

    const items = [];
    let currentDate = '';
    let dateMarkersFound = 0;

    for (const el of walker) {
      // Date markers can be tiny <time> / <span> / <div> with month-day
      // or weekday text. Detect by text pattern, ignoring elements that
      // contain other elements (so we don't mistake a whole bubble for
      // a date marker).
      if (el.children.length === 0) {
        const txt = norm(el.textContent);
        if (isDateMarker(txt) && !el.closest('.msg-s-event-listitem')) {
          currentDate = txt;
          dateMarkersFound++;
        }
      }
      if (el.matches && el.matches('.msg-s-event-listitem')) {
        items.push({ el, date: currentDate });
      }
    }

    window.__ortusDebug = {
      itemsFound: items.length,
      containers: containers.length,
      dateMarkersFound,
      meName: meName || null,
      meSlug: meSlug || null,
      leadPublicId: leadPublicId || null,
    };

    const out = [];
    let lastSenderName = '';
    let lastDirection = null;

    for (const { el: item, date } of items) {
      // Body — strict: <p class="msg-s-event-listitem__body">.
      const bodyEl = item.querySelector('p.msg-s-event-listitem__body, .msg-s-event-listitem__body');
      if (!bodyEl) continue;
      const body = norm(bodyEl.textContent || '');
      if (!body) continue;

      // Sender display name — present on first message of a contiguous
      // run from one sender. Continuation rows omit it.
      let senderName = '';
      const nameEl = item.querySelector('.msg-s-message-group__name, .msg-s-event-listitem__name, [class*="event-listitem__name"]');
      if (nameEl) senderName = norm(nameEl.textContent);
      if (/^view .+'s? (profile|page)$/i.test(senderName)) senderName = '';

      // Time — group-level <time class="msg-s-message-group__timestamp">,
      // or a per-item time element if the group one is missing.
      let timeOnly = '';
      const tEl = item.querySelector('.msg-s-message-group__timestamp, time, [class*="timestamp"]');
      if (tEl) {
        timeOnly = norm(tEl.getAttribute('datetime') || tEl.textContent || '');
      }

      // Combine date + time. Result examples:
      //   "Apr 17, 6:01 PM"  (both present)
      //   "6:01 PM"          (no date marker yet)
      //   "Apr 17"           (no time)
      let timestamp = '';
      if (date && timeOnly) timestamp = `${date}, ${timeOnly}`;
      else if (timeOnly) timestamp = timeOnly;
      else if (date) timestamp = date;

      // Continuation: inherit previous sender if no name on this row.
      if (!senderName && lastSenderName) senderName = lastSenderName;

      // Direction = name match against the operator.
      let direction;
      if (senderName && meName && senderName === meName) {
        direction = 'out';
      } else if (senderName) {
        direction = 'in';
      } else {
        direction = lastDirection || 'unknown';
      }

      if (senderName) {
        lastSenderName = senderName;
        lastDirection = direction;
      }

      out.push({ sender: senderName, direction, body, time: timestamp });
    }
    return out;
  }, { meName, meSlug, leadPublicId });

  return raw.map((m) => ({
    sender: m.sender,
    direction: m.direction || 'unknown',
    body: m.body,
    time: m.time || '',
  }));
}

/**
 * 2.9.7 — per-lead targeted Check DMs scan.
 *
 * Replaces the bulk-inbox Voyager scan for the production flow. Caller
 * (server route) groups sheet rows by Sender → profileId and passes the
 * lead list per profile. We open the profile's session ONCE, navigate
 * per-lead, scrape, write back, then close.
 *
 * Returns the same shape as checkProfileDms: { replies, ambiguous, errors,
 * newWatermark }. `replies[i].messages` holds the full scraped thread.
 */
export async function checkProfileDmsPerLead(profileId, leads, { sheetUrl, linkedinColumn, shouldAbort, log, page = null }) {
  const startTime = Date.now();
  const replies = [];
  const ambiguous = [];
  const errors = [];
  const abortCheck = typeof shouldAbort === 'function' ? shouldAbort : () => false;
  const logLine = (msg) => {
    console.log(msg);
    if (typeof log === 'function') { try { log(msg); } catch { /* */ } }
  };

  // v2.72: when the caller supplies a pre-opened `page` (e.g. /api/reply-check-now
  // running mid-campaign on a paused profile's browser), reuse it and DO NOT
  // close it — the caller owns the session lifecycle. Otherwise manage our own
  // session as before (open on entry, close in finally).
  let session = null;
  let _ownSession = false;
  try {
    if (page) {
      session = { page, profileId };
    } else {
      session = await _deps.ensureOpen(profileId);
      _ownSession = true;
    }
    if (!session || !session.page) {
      return { replies, ambiguous, errors: ['ensureOpen returned no session'] };
    }

    for (const lead of (leads || [])) {
      if (abortCheck()) {
        errors.push('Aborted by operator before completing all leads');
        break;
      }
      // Resolve LinkedIn URL from the row. Reads the user's configured column
      // first, then falls back to scanning every column for linkedin.com.
      let linkedinUrl = '';
      if (linkedinColumn && lead[linkedinColumn]) {
        linkedinUrl = String(lead[linkedinColumn]).trim();
      } else {
        for (const k of Object.keys(lead)) {
          const v = String(lead[k] || '').trim();
          if (v.includes('linkedin.com')) { linkedinUrl = v; break; }
        }
      }
      if (linkedinUrl && !linkedinUrl.startsWith('http')) {
        linkedinUrl = 'https://' + linkedinUrl;
      }
      if (!linkedinUrl) {
        errors.push(`row missing LinkedIn URL: ${lead.firstName || lead['First Name'] || '(unknown)'}`);
        continue;
      }

      const publicId = extractPublicIdFromUrl(linkedinUrl);
      if (!publicId) {
        // Vanity Sales Nav URL with no encoded member URN — same skip
        // condition outreach.js uses for force_connect/force_message.
        errors.push(`URL not in member-URN format — cannot route to /in/: ${linkedinUrl}`);
        continue;
      }

      try {
        // Same URL sendMessage uses (actions.js:955). /messaging/compose/
        // opens the existing thread for that recipient if one exists, or a
        // fresh compose pane otherwise — and the prior message history is
        // visible in both cases.
        let recipientId = publicId;
        const composeUrl = (id) => `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(id)}`;
        logLine(`[check-dms] → ${linkedinUrl}`);
        if (typeof session.page.goto === 'function') {
          await session.page.goto(composeUrl(recipientId), {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        }

        // 2.9.7: detect LinkedIn's "errorpg" page (vanity slug rejected by
        // /messaging/compose/?recipient=<slug>). Fall back: navigate to
        // /in/<slug>/ which redirects to the encoded URN form, capture
        // that URN, then retry compose with the encoded URN.
        let isErrorPage = false;
        try {
          isErrorPage = await session.page.evaluate(() => {
            const m = document.querySelector('main');
            const cls = (m?.className || '').toString().toLowerCase();
            return cls.includes('errorpg') || cls.includes('error-page');
          });
        } catch { /* */ }

        if (isErrorPage) {
          logLine(`[check-dms] ${linkedinUrl}: vanity slug rejected, looking up canonical URN…`);
          try {
            await session.page.goto(`https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`, {
              waitUntil: 'domcontentloaded',
              timeout: 20000,
            });
            // After redirect, the address bar (or canonical link in head)
            // carries the encoded URN form for vanity-slug profiles.
            await new Promise(r => setTimeout(r, 1500));
            const canonical = await session.page.evaluate(() => {
              const m1 = window.location.href.match(/\/in\/([^/?#]+)/);
              if (m1 && /^AC[A-Za-z0-9_-]+$/.test(m1[1])) return m1[1];
              // Canonical link in <head> sometimes carries the URN form
              const link = document.querySelector('link[rel="canonical"]');
              if (link) {
                const m2 = (link.getAttribute('href') || '').match(/\/in\/([^/?#]+)/);
                if (m2 && /^AC[A-Za-z0-9_-]+$/.test(m2[1])) return m2[1];
              }
              return null;
            });
            if (canonical && canonical !== publicId) {
              recipientId = canonical;
              logLine(`[check-dms] ${linkedinUrl}: retrying compose with canonical URN ${canonical}`);
              await session.page.goto(composeUrl(recipientId), {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
              });
            } else {
              errors.push(`could not resolve canonical URN for ${linkedinUrl}`);
              continue;
            }
          } catch (e) {
            errors.push(`URN-lookup fallback failed for ${linkedinUrl}: ${e.message}`);
            continue;
          }
        }

        // Poll for the message list to render. LinkedIn's messaging is
        // slow to hydrate (heavy SPA + Voyager XHRs). Old fixed waits
        // missed the list on slower networks.
        if (typeof session.page.evaluate === 'function') {
          await session.page.evaluate(async () => {
            const sels = [
              '.msg-s-event-listitem',
              '[class*="event-listitem"]',
              '[class*="msg-event"]',
              '[class*="message-list"] li',
              '[class*="msg-s-message-list"] li',
            ];
            for (let i = 0; i < 40; i++) {
              for (const s of sels) {
                if (document.querySelectorAll(s).length > 0) return;
              }
              await new Promise(r => setTimeout(r, 500));
            }
          }).catch(() => { /* */ });
        }
        // Final settle for late-render bubbles.
        await new Promise(r => setTimeout(r, 1500));

        const thread = await extractDmThreadFromPage(session.page, publicId);
        // Pull debug info out of the page so we can see WHY scraping failed.
        let dbg = null;
        try {
          dbg = await session.page.evaluate(() => window.__ortusDebug || null);
        } catch { /* */ }
        logLine(
          `[check-dms] ${linkedinUrl}: scraped ${thread.length} message(s) ` +
          `(itemsFound=${dbg?.itemsFound ?? '?'} dateMarkers=${dbg?.dateMarkersFound ?? '?'} meName="${dbg?.meName || ''}")`
        );

        // If we found NO items, dump a DOM sample so we can update selectors.
        if (thread.length === 0 && typeof session.page.evaluate === 'function') {
          try {
            const sample = await session.page.evaluate(() => {
              const main = document.querySelector('main') || document.body;
              const mainCls = main?.className?.toString().slice(0, 80) || '';
              const inLinks = main?.querySelectorAll('a[href*="/in/"]').length || 0;
              const liCount = main?.querySelectorAll('li').length || 0;
              const url = window.location.href;
              // Sample first 3 list items inside main with /in/ links
              const samples = [];
              const lis = main?.querySelectorAll('li') || [];
              for (let i = 0; i < Math.min(lis.length, 3); i++) {
                const li = lis[i];
                if (li.querySelector('a[href*="/in/"]')) {
                  samples.push((li.className || '').toString().slice(0, 90));
                }
              }
              return { url, mainCls, inLinks, liCount, samples };
            });
            logLine(`[check-dms] DOM sample: url=${sample.url} mainCls="${sample.mainCls}" inLinks=${sample.inLinks} li=${sample.liCount} liCls=${JSON.stringify(sample.samples)}`);
          } catch { /* */ }
        }

        // 2.9.7: keep inbound only. Fall back to "everything except known
        // outbound" when meSlug detection fails (then 'unknown' is a stand-in
        // for "probably the lead since we couldn't id ourselves"). This way
        // we never silently drop a whole thread because LinkedIn's class
        // names rotated and we couldn't find the global-nav profile link.
        const filtered = thread.filter(m => m.direction !== 'out');
        const lastTwo = filtered.slice(-2);
        const inboundOnly = filtered;
        if (thread.length > 0 && lastTwo.length === 0) {
          const inCount = thread.filter(m => m.direction === 'in').length;
          const outCount = thread.filter(m => m.direction === 'out').length;
          const unkCount = thread.filter(m => m.direction === 'unknown').length;
          logLine(`[check-dms] ${linkedinUrl}: ${thread.length} scraped, in=${inCount} out=${outCount} unknown=${unkCount} — nothing to write`);
        }

        // Pull lead's First / Last name from the row. Try several casings.
        const firstName = String(
          lead.firstName || lead['First Name'] || lead.first_name || ''
        ).trim();
        const lastName = String(
          lead.lastName || lead['Last Name'] || lead.last_name || ''
        ).trim();

        // Append the last-two inbound messages. Bridge dedupes on
        // (leadUrl, body) so re-runs are idempotent regardless of how
        // LinkedIn renders the timestamp.
        for (const msg of lastTwo) {
          try {
            await _deps.appendReplyRow(sheetUrl, {
              leadUrl: linkedinUrl,
              timestamp: msg.time || '',
              firstName,
              lastName,
              body: msg.body,
            });
          } catch (e) {
            errors.push(`appendReply failed for ${linkedinUrl}: ${e.message}`);
          }
        }

        // Update legacy Reply tracking + bump Stage to 'Replied' ONLY when
        // we have a confirmed inbound message (direction === 'in'). Don't
        // bump on 'unknown' to avoid false positives when slug detection
        // fails on outbound-only threads.
        const confirmedInbound = thread.filter(m => m.direction === 'in');
        if (confirmedInbound.length > 0) {
          const lastInbound = confirmedInbound[confirmedInbound.length - 1];
          try {
            const tracking = {
              Reply: 'yes',
              ReplyAt: new Date(startTime).toISOString(),
              ReplyPreview: String(lastInbound.body).slice(0, 100),
              stage: 'Replied',
            };
            await _deps.updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn);
          } catch (e) {
            errors.push(`updateSheetRow failed for ${linkedinUrl}: ${e.message}`);
          }
        }

        replies.push({
          match: lead,
          leadUrl: linkedinUrl,
          messages: lastTwo,
          snippet: lastTwo[lastTwo.length - 1]?.body || '',
          inbound: confirmedInbound.length > 0,
          messageCount: lastTwo.length,
        });
      } catch (e) {
        errors.push(`thread scrape failed for ${linkedinUrl}: ${e.message}`);
      }
    }

    return { replies, ambiguous, errors, newWatermark: startTime };
  } catch (e) {
    return { replies, ambiguous, errors: [`checkProfileDmsPerLead threw: ${e.message}`] };
  } finally {
    if (session && _ownSession) {
      try { await _deps.closeSession(profileId); } catch { /* best-effort */ }
    }
  }
}
