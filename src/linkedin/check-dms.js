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
    // comment above. The "Account Used" column holds the value written by
    // campaign.js, which is pName (e.g. "matt.adcock@ortus.solutions"), not
    // the GoLogin internal profile id.
    const rows = await fetchSheet(sheetUrl);
    return rows.filter(r =>
      (r.Message || '').toString().toLowerCase() === 'sent' &&
      (r['Account Used'] || '').toString() === profileName
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
export async function checkProfileDms(profileId, { watermark = 0, sheetUrl, linkedinColumn }) {
  const startTime = Date.now();
  const replies = [];
  const ambiguous = [];
  const errors = [];

  let session = null;
  try {
    session = await _deps.ensureOpen(profileId);
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
      // Give the messenger XHR up to ~8s to fire. Re-poll the performance
      // entries until we see one, then proceed. If it never fires,
      // getConversationsPage will return null and we surface a clean error.
      if (typeof session.page.waitForFunction === 'function') {
        try {
          await session.page.waitForFunction(
            () => performance.getEntriesByType('resource')
              .some(e => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations')),
            { timeout: 8000 },
          );
        } catch { /* fall through — getConversationsPage will return null */ }
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
      const match = matchConversationToSheet(conv, candidateRows);

      if (match.reason === 'ambiguous') {
        ambiguous.push({ conv, candidates: match.candidates });
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
      });
    }

    return { replies, ambiguous, errors, newWatermark: startTime };
  } catch (e) {
    return { replies, ambiguous, errors: [`checkProfileDms threw: ${e.message}`] };
  } finally {
    if (session) {
      try { await _deps.closeSession(profileId); } catch { /* best-effort */ }
    }
  }
}

// ── 2.9.7 Per-lead targeted thread scrape ────────────────────────────────────

/**
 * Extract the publicId slug from a /in/<slug> LinkedIn URL.
 * Returns null for Sales Navigator URLs (caller should skip + log).
 */
export function extractPublicIdFromUrl(linkedinUrl) {
  if (!linkedinUrl) return null;
  const m = String(linkedinUrl).match(/\/in\/([^/?#]+)/);
  return m ? m[1] : null;
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
 * Scrape the visible message thread from a LinkedIn /messaging/compose page.
 *
 * Returns an array of { sender, direction, body, timestamp } in DOM order
 * (oldest → newest, matching LinkedIn's render order).
 *
 * Direction is determined by comparing the inline sender anchor's /in/ slug
 * to the lead's publicId. Continuation messages (no sender shown) inherit
 * the previous direction.
 */
export async function extractDmThreadFromPage(page, leadPublicId) {
  const raw = await page.evaluate((leadSlug) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const items = document.querySelectorAll(
      '.msg-s-event-listitem, [class*="event-listitem"]'
    );
    const out = [];
    let lastSlug = null;
    let lastSender = '';
    let lastDirection = null;

    for (const item of items) {
      // Sender anchor: only present on the first message of a contiguous run
      const a = item.querySelector('a[href*="/in/"]');
      let slug = null;
      let senderName = '';
      if (a) {
        const m = a.getAttribute('href').match(/\/in\/([^/?#]+)/);
        if (m) slug = m[1];
        senderName = norm(a.textContent);
      }

      // Body: prefer the explicit message-body element
      const bodyEl = item.querySelector(
        '.msg-s-event-listitem__body, [class*="event-listitem__body"], [class*="message__body"], [class*="msg-event-listitem__body"]'
      );
      let body = norm(bodyEl?.textContent || '');
      // If we couldn't isolate the body, the item is likely a system row
      // (read receipt, "joined the chat", typing indicator). Skip it.
      if (!body) continue;

      // Timestamp: try datetime attr first, then visible text
      let timestamp = '';
      const tsEl = item.querySelector('time, [class*="timestamp"]');
      if (tsEl) {
        timestamp = tsEl.getAttribute('datetime') || norm(tsEl.textContent || '');
      }

      // Continuation: inherit previous sender if no anchor on this row
      if (!slug && lastSlug) {
        slug = lastSlug;
        senderName = lastSender;
      }

      let direction = lastDirection;
      if (slug) {
        direction = (slug === leadSlug) ? 'in' : 'out';
        lastSlug = slug;
        lastSender = senderName;
        lastDirection = direction;
      }

      out.push({ sender: senderName, direction, body, timestamp });
    }
    return out;
  }, leadPublicId);

  // Build stable per-message keys outside the page context so we can hash.
  return raw.map((m) => ({
    sender: m.sender,
    direction: m.direction || 'out',
    body: m.body,
    timestamp: m.timestamp || stableMessageKey(m.direction || 'out', m.body),
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
export async function checkProfileDmsPerLead(profileId, leads, { sheetUrl, linkedinColumn }) {
  const startTime = Date.now();
  const replies = [];
  const ambiguous = [];
  const errors = [];

  let session = null;
  try {
    session = await _deps.ensureOpen(profileId);
    if (!session || !session.page) {
      return { replies, ambiguous, errors: ['ensureOpen returned no session'] };
    }

    for (const lead of (leads || [])) {
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
        // Sales Navigator URLs don't contain /in/<slug>. Skip with a clear note.
        errors.push(`Sales Navigator URL — cannot scrape thread: ${linkedinUrl}`);
        continue;
      }

      try {
        const composeUrl = `https://www.linkedin.com/messaging/thread/?recipient=${encodeURIComponent(publicId)}`;
        if (typeof session.page.goto === 'function') {
          await session.page.goto(composeUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        }

        // Wait for thread DOM to populate. If LinkedIn renders an empty
        // composer (no prior thread), waitForSelector times out — that's
        // fine; we treat it as "no messages" and continue.
        if (typeof session.page.waitForSelector === 'function') {
          await session.page.waitForSelector(
            '.msg-s-event-listitem, [class*="event-listitem"]',
            { timeout: 8000 },
          ).catch(() => { /* empty thread is OK */ });
        }
        // Settle a beat for late-render bubbles.
        await new Promise(r => setTimeout(r, 1500));

        const thread = await extractDmThreadFromPage(session.page, publicId);

        // Append each message to the Replies tab. Bridge dedupes on
        // (leadUrl, timestamp) so re-runs are idempotent.
        for (const msg of thread) {
          try {
            await _deps.appendReplyRow(sheetUrl, {
              leadUrl: linkedinUrl,
              timestamp: msg.timestamp,
              direction: msg.direction,
              sender: msg.sender,
              body: msg.body,
            });
          } catch (e) {
            errors.push(`appendReply failed for ${linkedinUrl}: ${e.message}`);
          }
        }

        // Update legacy Reply tracking + bump Stage to 'Replied' when the
        // lead has at least one inbound message.
        const lastInbound = [...thread].reverse().find(m => m.direction === 'in');
        if (lastInbound) {
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
          messages: thread,
          snippet: thread[thread.length - 1]?.body || '',
          inbound: !!lastInbound,
          messageCount: thread.length,
        });
      } catch (e) {
        errors.push(`thread scrape failed for ${linkedinUrl}: ${e.message}`);
      }
    }

    return { replies, ambiguous, errors, newWatermark: startTime };
  } catch (e) {
    return { replies, ambiguous, errors: [`checkProfileDmsPerLead threw: ${e.message}`] };
  } finally {
    if (session) {
      try { await _deps.closeSession(profileId); } catch { /* best-effort */ }
    }
  }
}
