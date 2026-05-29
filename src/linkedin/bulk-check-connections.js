/**
 * Bulk Connection Status check.
 *
 * Replaces the per-lead Voyager-degree check with a single paginated fetch
 * of the account's recent connections, then matches against pending invites
 * in the sheet. Matched rows get Connected Status = 'Connected' written
 * back via the existing batchUpdate path.
 *
 * Match key: LinkedIn public identifier (the slug after /in/). Both the
 * sheet's URL column and the connections payload carry this, so collision
 * risk is effectively zero.
 *
 * Caller is responsible for cooldown gating + navigating the page to a
 * LinkedIn URL before invoking (so JSESSIONID is present for Voyager).
 */

import { getRecentConnections } from './helpers.js';
import { fetchSheet } from '../sheets.js';
import { batchUpdateSheet, writeRecentConnectionsTab } from '../sheets-writer.js';
import { extractLinkedInUrl, campaign } from '../campaign.js';

function publicIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().trim() : '';
}

// Extract LinkedIn's ACwAA-style member ID from any string (URL, URN, etc.).
// Some sheet rows use /in/ACwAA…-style URLs (URN-encoded) instead of the
// vanity /in/firstname-lastname slug. The Voyager connections API returns
// both representations across different fields, so we match on either.
function memberIdFromAny(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Pure helper — given the fetched connections + the sheet rows, decide
 * which rows get Connected stamps vs Still Pending stamps. Extracted from
 * bulkCheckConnections so it can be unit-tested without spinning up a
 * Puppeteer page.
 *
 * @param {object[]} rows - sheet rows (from fetchSheet)
 * @param {object[]} conns - Voyager connections array
 * @param {string} linkedinColumn - operator-specified URL column name (or '')
 * @param {string} stillPendingLabel - timestamped "Still Pending" stamp value
 * @param {object} opts
 * @param {boolean} [opts.suppressAcceptedStamp=false] - when true, matched
 *   URLs are returned in connectedUrls but their cc/connectedAlready writes
 *   are omitted from the updates array
 * @returns {{ updates: object[], connectedUrls: string[], diag: object }}
 */
export function computeBulkCheckUpdates(rows, conns, linkedinColumn, stillPendingLabel, opts = {}) {
  const { suppressAcceptedStamp = false, profileName = '', introducedInRun = null, composeAttempts = null } = opts;

  // v2.62: sender-scoped matching. Builds the set of accounts ACTIVELY
  // running this campaign from distinct Sender values in the sheet. Used
  // to prevent cross-account false-positive Connected stamps: if eryca's
  // bulk-check finds a lead in her network but the row's Sender is
  // carmella, eryca shouldn't stamp the row as Connected (carmella's
  // invitation may still be pending). Operator's rule, verbatim:
  // "if Antonio isn't running the campaign, who cares?"
  //
  // Backward-compat: empty profileName or sheets with no Sender column
  // skip the scoping entirely (legacy single-account / pre-sender-column
  // behavior preserved).
  const activeSenders = new Set();
  for (const row of rows) {
    const s = (row['Sender'] || row['sender'] || '').toString().toLowerCase().trim();
    if (s) activeSenders.add(s);
  }
  const profileNameNorm = (profileName || '').toLowerCase().trim();
  const senderScopingActive = !!profileNameNorm && activeSenders.size > 0;
  const callerIsActiveSender = !senderScopingActive || activeSenders.has(profileNameNorm);

  // Build account-attributed match indexes. Each connection carries the
  // `account` (campaign Sender) that owns it — supplied by the caller from
  // the accumulated "Recent Connections" tab, or attributed to the sweeping
  // profile on the live-fetch fallback path. Key → Set<accountNorm>.
  // CONTRACT: on a sender-scoped sheet the caller MUST set `account` on every
  // conn. An account-less conn ('') won't match a row whose Sender is set, so
  // bulkCheckConnections attributes the live-fetch fallback to the sweeping
  // profile (see bulk-check-connections.js fallback path).
  const slugToAccounts = new Map();
  const memberIdToAccounts = new Map();
  const nameToAccounts = new Map();
  const accountDisplay = new Map(); // accountNorm → original-case (for stamps)
  const _addAcct = (map, key, acct) => {
    if (!key) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(acct);
  };
  for (const c of conns) {
    const acctRaw = (c.account || '').toString().trim();
    const acct = acctRaw.toLowerCase();
    if (acct && !accountDisplay.has(acct)) accountDisplay.set(acct, acctRaw);
    if (c.publicId) _addAcct(slugToAccounts, c.publicId.toLowerCase(), acct);
    const mid = memberIdFromAny(c.urn) || memberIdFromAny(c.publicId);
    if (mid) _addAcct(memberIdToAccounts, mid, acct);
    const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`.trim();
    if (nameKey && nameKey !== ' ') _addAcct(nameToAccounts, nameKey, acct);
  }

  // Snapshot a few extracted IDs for the diag eyeball-compare.
  const sampleConnectedSlugs = [...slugToAccounts.keys()].slice(0, 3);
  const sampleConnectedMemberIds = [...memberIdToAccounts.keys()].slice(0, 3);
  const sampleConnectedNames = [...nameToAccounts.keys()].slice(0, 3);

  const updates = [];
  const connectedUrls = [];
  let dbgRowsScanned = 0, dbgWithUrl = 0, dbgWithCRS = 0;
  let dbgAlreadyConnected = 0, dbgAlreadyDeclined = 0, dbgPidMatched = 0;
  let dbgAlreadyIntroduced = 0;
  let dbgAlreadyUnverified = 0;
  let dbgComposeCapped = 0;
  let dbgCrossSender = 0;
  let dbgSkippedNotActiveSender = 0;
  const sampleSheetSlugs = [];
  const sampleSheetMemberIds = [];
  const sampleCRSValues = new Set();

  // Defense: if sender scoping is active and this caller isn't a
  // campaign sender, return empty. The bulk-check shouldn't have
  // run for this account; we won't make it worse by touching rows.
  if (senderScopingActive && !callerIsActiveSender) {
    dbgSkippedNotActiveSender = rows.length;
    return {
      updates: [],
      connectedUrls: [],
      diag: {
        rowsScanned: rows.length, withUrl: 0, withCRS: 0,
        alreadyConnected: 0, alreadyDeclined: 0, alreadyIntroduced: 0,
        alreadyUnverified: 0, composeCapped: 0, pidMatched: 0,
        crossSender: 0, skippedNotActiveSender: dbgSkippedNotActiveSender,
        slugs: slugToAccounts.size, memberIds: memberIdToAccounts.size, names: nameToAccounts.size,
        sampleSheetSlugs: [], sampleSheetMemberIds: [],
        sampleConnectedSlugs, sampleConnectedMemberIds, sampleConnectedNames,
        sampleCRSValues: new Set(),
      },
    };
  }

  for (const row of rows) {
    dbgRowsScanned++;
    const url = extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    dbgWithUrl++;

    // Accepted-status lookup includes both old (Connected Status / CC) and
    // new (Connection Accepted Status) headers for back-compat across the
    // v2.14 rename window.
    const cs = (
      row['Connection Accepted Status'] || row['connection accepted status']
      || row['Check Status'] || row['check status']
      || row['Connected Status']  || row['connected status']
      || row['CC'] || row['cc'] || ''
    ).toString().trim();
    if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
    // v2.61.0: sticky downgrade — auto-intro.js writes this exact prefix when
    // reverify confirms a Connected stamp was a false positive. Leaving the
    // row alone means subsequent bulk-check passes can't restamp Connected
    // even if Voyager still returns the URN. Operator clears the cell to retry.
    if (cs.startsWith('Unverified — manual review')) {
      dbgAlreadyUnverified++;
      continue;
    }

    const slug = publicIdFromUrl(url);
    const rowUrn = (row['LinkedIn URN'] || row['linkedin urn'] || '').toString();
    const memberId = memberIdFromAny(rowUrn) || memberIdFromAny(url);
    if (sampleSheetSlugs.length < 3 && slug) sampleSheetSlugs.push(slug);
    if (sampleSheetMemberIds.length < 3 && memberId) sampleSheetMemberIds.push(memberId);

    const firstName = (row['First Name'] || row['first name'] || row['firstName'] || '').toString().toLowerCase().trim();
    const lastName  = (row['Last Name']  || row['last name']  || row['lastName']  || '').toString().toLowerCase().trim();
    const nameKey = `${firstName} ${lastName}`.trim();

    // Sender-scoping read — what account does this row's lead belong to?
    // Empty means "no one assigned yet" → legacy behavior. Otherwise we
    // compare against the calling profile (profileNameNorm).
    const rowSenderRaw = (row['Sender'] || row['sender'] || '').toString().trim();
    const rowSenderNorm = rowSenderRaw.toLowerCase();
    const rowSenderMismatch = senderScopingActive
      && rowSenderNorm
      && rowSenderNorm !== profileNameNorm;

    // Which campaign accounts have this lead in the accumulated tab?
    const _matchedAccounts = new Set();
    for (const a of (slugToAccounts.get(slug) || [])) _matchedAccounts.add(a);
    if (memberId) for (const a of (memberIdToAccounts.get(memberId) || [])) _matchedAccounts.add(a);
    if (nameKey && nameKey !== ' ') for (const a of (nameToAccounts.get(nameKey) || [])) _matchedAccounts.add(a);
    const isMatch = _matchedAccounts.size > 0;

    // Is the row's ASSIGNED sender among the accounts connected to this lead?
    // Legacy sheets (no Sender column) → any match counts as the assigned one.
    const _assignedConnected = rowSenderNorm
      ? _matchedAccounts.has(rowSenderNorm)
      : isMatch;

    // v2.14.x: extract requestStatus BEFORE the isMatch branch so we can
    // distinguish two match cases:
    //   - wasInvited: bot sent a connect request in a prior run, recipient
    //     has now accepted → "Connected" (normal acceptance flow)
    //   - !wasInvited: lead was already a 1st-degree connection to this
    //     account before the campaign ever started → "Already connected",
    //     with Sender + Stage stamped so the operator sees WHICH account
    //     they're connected to, and pre-filter excludes the row from new
    //     connect sends by other accounts.
    const requestStatus = (
      row['Connection Request Status'] || row['connection request status']
      || row['Connection Status']        || row['connection status']
      || row['Status'] || row['status'] || ''
    ).toString().trim();
    const wasInvited = requestStatus === 'Connection Request Sent';

    if (isMatch) {
      dbgPidMatched++;

      // v2.14.x: check introductionStatus FIRST. The previous code skipped
      // any row with cs='Connected'/'Already connected' before looking at
      // introductionStatus — which meant any lead whose intro got
      // INTERRUPTED (Stop pressed mid-batch, browser died) was stamped
      // 'Skipped — Stop pressed' / 'Skipped — browser closed' but then
      // EXCLUDED FROM RE-PICKUP on every subsequent bulk-check, because
      // the cs guard short-circuited before the introductionStatus check
      // could route them back into connectedUrls. The cs-guard was a stale
      // proxy for "intro already done"; the introductionStatus check below
      // is the authoritative signal — see commit comment about
      // nitin.kumar 2026-05-16 (kanojiya/samson/chaudhary 3× intros).
      const introductionStatus = (
        row['Introduction Status'] || row['introduction status'] || ''
      ).toString().trim();

      // Authoritative intro-already-done signals: sheet-side (cross-restart)
      // and in-memory blacklist (this-process, beats CSV cache lag).
      if (introductionStatus === 'Introduction Made' || introductionStatus === 'Introduction Already Made') {
        dbgAlreadyIntroduced++;
        continue;
      }
      if (introducedInRun && introducedInRun.has(url)) {
        dbgAlreadyIntroduced++;
        continue;
      }

      // v2.61.0: per-URL compose-textbox failure cap. If reverify-and-downgrade
      // didn't resolve the row (e.g. getConnectionStatus returned 'unknown'),
      // this caps repeat attempts so a single false-positive doesn't produce a
      // 30+ retry storm over a single process lifetime.
      if (composeAttempts && (composeAttempts.get(url) || 0) >= 3) {
        dbgComposeCapped++;
        continue;
      }

      // v2.62 (v2.63 attribution): a DIFFERENT campaign sender owns this
      // lead in the tab — the row's assigned sender's invite may still be
      // pending. DON'T stamp cc, DON'T push to connectedUrls (the assigned
      // sender fires its own auto-DM/intro), DON'T overwrite an existing
      // Connected stamp. DO write an informational "Already connected to
      // <owning account>" into Stage so the operator sees which campaign
      // account already has this person.
      if (!_assignedConnected) {
        dbgCrossSender++;
        if (suppressAcceptedStamp) continue;
        if (cs === 'Connected' || cs.startsWith('Already connected')) continue;
        let _other = '';
        for (const a of _matchedAccounts) { if (a) { _other = accountDisplay.get(a) || a; break; } }
        updates.push({
          linkedinUrl: url,
          stage: `Already connected to ${_other}`,
        });
        continue;
      }

      // Not yet introduced — queue for the auto-intro pass. Even if the
      // CC column is already 'Connected' (from a prior bulk-check), the
      // intro still needs to fire — this is the path that lets
      // 'Skipped — Stop pressed' / 'Skipped — browser closed' / 'Failed'
      // leads recover on the next bulk-check round.
      const ccAlreadyStamped = (cs === 'Connected' || cs === 'Already connected');
      if (ccAlreadyStamped) dbgAlreadyConnected++;
      connectedUrls.push(url);

      // Only stamp the CC column when it's not already at its target
      // value — avoids redundant Apps Script writes for rows we're just
      // re-picking-up for an intro retry.
      if (!suppressAcceptedStamp && !ccAlreadyStamped) {
        // v2.14.x: also stamp checkStatus so the legacy "Check Status"
        // column (still present on operator sheets that haven't been
        // migrated by the Apps Script rename) fills in visibly. In the
        // v2.14 schema both cc and checkStatus map to the same column
        // ("Connection Accepted Status"), so the dual write is a no-op
        // there. In v2.13.x they're separate columns — this fills both.
        if (wasInvited) {
          // Normal acceptance — bot invited, recipient accepted.
          // v2.62: also stamp Stage='Connected' so the Stage column
          // reflects reality. Previously the Stage stayed at 'Connect
          // Pending' while cc flipped to 'Connected', confusing
          // operators reading the row at a glance.
          updates.push({
            linkedinUrl: url,
            cc: 'Connected',
            stage: 'Connected',
            connectedAlready: 'Yes',
            checkStatus: 'Connected',
          });
        } else {
          // Pre-existing 1st-degree connection (no prior outreach by the bot).
          // Mirror Pinky's row pattern from outreach.js's already_connected
          // path: Sender + Stage + Connection Accepted Status all reading
          // "Already connected". Pre-filter (campaign.js:1216) excludes
          // Stage='Already connected' from new connect sends, so other
          // accounts won't try to connect. The existing connectedUrls →
          // runAutoIntros chain fires the IC DM from THIS account
          // immediately in the same bulk-check pass.
          updates.push({
            linkedinUrl: url,
            sender: rowSenderRaw || accountDisplay.get([..._matchedAccounts].find((a) => a) || '') || profileName,
            stage: 'Already connected',
            cc: 'Already connected',
            connectedAlready: 'Yes',
            checkStatus: 'Already connected',
          });
        }
      }
      continue;
    }

    // Not in recent connections — stamp "Still Pending" if the bot invited.
    if (sampleCRSValues.size < 5 && requestStatus) sampleCRSValues.add(requestStatus);
    if (requestStatus !== 'Connection Request Sent') continue;
    // v2.62: don't let other accounts' bulk-checks downgrade a row to
    // Still Pending. Only the assigned Sender should refresh its own
    // pending timestamp.
    if (rowSenderMismatch) continue;
    // v2.14.x: never overwrite a row that's already known-connected or
    // already-introduced. LinkedIn's recent-connections endpoint returns at
    // most ~80 most-recent connections — older accepted invites silently
    // fall off the list. Without this guard, every bulk-check pass after
    // ~80 newer connections downgrades the older ones from "Connected" /
    // "Already connected" back to "Still Pending", wiping the audit trail
    // even though the lead IS still a connection. Operator screenshot
    // 2026-05-16: Cindy (intro'd 14:48) shown as "Still Pending (17:07)".
    if (cs === 'Connected' || cs === 'Already connected') continue;
    const _introStatusForGuard = (
      row['Introduction Status'] || row['introduction status'] || ''
    ).toString().trim();
    if (_introStatusForGuard === 'Introduction Made' || _introStatusForGuard === 'Introduction Already Made') continue;
    dbgWithCRS++;
    // Same dual-write as the matched branch — see comment above.
    updates.push({
      linkedinUrl: url,
      cc: stillPendingLabel,
      checkStatus: stillPendingLabel,
    });
  }

  return {
    updates,
    connectedUrls,
    diag: {
      rowsScanned: dbgRowsScanned,
      withUrl: dbgWithUrl,
      withCRS: dbgWithCRS,
      alreadyConnected: dbgAlreadyConnected,
      alreadyDeclined: dbgAlreadyDeclined,
      alreadyIntroduced: dbgAlreadyIntroduced,
      alreadyUnverified: dbgAlreadyUnverified,
      composeCapped: dbgComposeCapped,
      pidMatched: dbgPidMatched,
      crossSender: dbgCrossSender,
      skippedNotActiveSender: dbgSkippedNotActiveSender,
      slugs: slugToAccounts.size,
      memberIds: memberIdToAccounts.size,
      names: nameToAccounts.size,
      sampleSheetSlugs,
      sampleSheetMemberIds,
      sampleConnectedSlugs,
      sampleConnectedMemberIds,
      sampleConnectedNames,
      sampleCRSValues,
    },
  };
}

/**
 * Run one bulk-check pass for a profile.
 *
 * @param {puppeteer.Page} page - Active page on a LinkedIn URL
 * @param {string} sheetUrl - Sheet URL the campaign is running against
 * @param {string} linkedinColumn - Operator-specified URL column name (or '')
 * @param {string} pName - Profile name for logging
 * @param {object} [opts={}]
 * @param {boolean} [opts.suppressAcceptedStamp=false] - when true, matched
 *   URLs are returned in connectedUrls but their cc/connectedAlready writes
 *   are omitted from the batch update
 * @returns {Promise<{ matched: number, fetched: number, error?: string, connectedUrls?: string[] }>}
 */
export async function bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, opts = {}) {
  // 1) Always navigate to a stable LinkedIn URL so the page context has
  // fresh cookies. /mynetwork/invite-connect/connections/ is what LinkedIn's
  // own UI hits. Then check whether we ended up logged in — a stale-session
  // profile gets redirected to /login or /uas/login, where Voyager doesn't
  // exist (returns 404 from a login-page context).
  let postNavUrl = '';
  try {
    await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    postNavUrl = page.url() || '';
  } catch (err) {
    return { matched: 0, fetched: 0, error: `navigation-failed: ${err.message}` };
  }
  // Quick auth check before burning cycles on Voyager calls that will 404.
  if (/\/login|\/uas\/|\/checkpoint/.test(postNavUrl)) {
    return { matched: 0, fetched: 0, error: `session-expired (redirected to ${postNavUrl})` };
  }

  // 2) Fetch recent connections. We pass sinceMs=0 so all pages are fetched
  // (up to the helper's MAX_PAGES cap). Tighter scoping (e.g. since the
  // first invite in this campaign) is a future optimisation.
  const conns = await getRecentConnections(page, 0);
  if (conns.length === 0) {
    // The helper attaches `.error` on the empty array when the failure was
    // something specific (no-csrf, http-XXX, empty-elements, etc.). Surface
    // it so the operator can see exactly why the fetch produced nothing.
    const reason = conns.error || 'no-connections-fetched';
    return { matched: 0, fetched: 0, error: reason };
  }

  // 3) Read the sheet. Done BEFORE the sidecar write so we can extract the
  // active-sender set (distinct Sender column values) — Apps Script needs it
  // to filter out non-campaign accounts from the "Recent Connections" tab.
  let rows;
  try {
    rows = await fetchSheet(sheetUrl);
  } catch (err) {
    return { matched: 0, fetched: conns.length, error: `sheet-fetch: ${err.message}` };
  }

  // v2.62: active senders for this campaign — distinct values in the Sender
  // column. Used by the sidecar write to scope the "Recent Connections" tab
  // to accounts running THIS campaign (operator rule: the tab is the Bible
  // for matching, so anyone who isn't a campaign sender doesn't belong in
  // it). Also passed into computeBulkCheckUpdates for sender-scoped matching.
  const activeSendersList = [];
  const activeSendersSeen = new Set();
  for (const row of rows) {
    const s = (row['Sender'] || row['sender'] || '').toString().trim();
    if (s && !activeSendersSeen.has(s.toLowerCase())) {
      activeSendersSeen.add(s.toLowerCase());
      activeSendersList.push(s);
    }
  }

  // Mirror the fetched connections into a sidecar tab on the same sheet so
  // the operator has a visible audit log of what Voyager actually returned.
  // Best-effort — failures are non-fatal to the bulk-check flow.
  try {
    const sidecarRows = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: c.publicId || '',
      // LinkedIn URN column carries just the ACoAA… portion (no
      // `urn:li:fsd_profile:` prefix) — same convention as the campaign tab.
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      connectedAt: c.connectedAt || 0,
      profileSentBy: pName || '',
    }));
    await writeRecentConnectionsTab(sheetUrl, pName, sidecarRows, activeSendersList);
  } catch (err) {
    console.warn(`[bulk-check] sidecar tab write failed: ${err.message}`);
  }

  // Build a single human-readable timestamp for every "Still Pending" stamp
  // written this sweep. Same string everywhere so the operator can see at a
  // glance which rows were checked in the same pass.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stillPendingLabel = `Still Pending (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())})`;

  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows,
    conns,
    linkedinColumn,
    stillPendingLabel,
    {
      suppressAcceptedStamp: opts.suppressAcceptedStamp === true,
      // v2.14.x: stamped onto pre-existing 1st-degree matches so the
      // operator sees WHICH account is connected to the lead.
      profileName: pName || '',
      // v2.14.x: read campaign-level in-memory blacklist by default so
      // every call site benefits without needing to pass the Set explicitly.
      introducedInRun: opts.introducedInRun || campaign.introducedInRun,
      composeAttempts: opts.composeAttempts || campaign.composeAttempts,
    }
  );

  const diagSummary = `scanned=${diag.rowsScanned}, withUrl=${diag.withUrl}, slugs=${diag.slugs}, memberIds=${diag.memberIds}, names=${diag.names}, pidMatched=${diag.pidMatched}, alreadyConnected=${diag.alreadyConnected}, alreadyIntroduced=${diag.alreadyIntroduced}, alreadyUnverified=${diag.alreadyUnverified}, composeCapped=${diag.composeCapped}, alreadyDeclined=${diag.alreadyDeclined}, stamped=${diag.withCRS}\n  ↳ sampleSheetSlugs=${diag.sampleSheetSlugs.join(' | ') || '(none)'}\n  ↳ sampleSheetMemberIds=${diag.sampleSheetMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedSlugs=${diag.sampleConnectedSlugs.join(' | ') || '(none)'}\n  ↳ sampleConnectedMemberIds=${diag.sampleConnectedMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedNames=${diag.sampleConnectedNames.join(' | ') || '(none)'}\n  ↳ sampleCRS=${[...diag.sampleCRSValues].join(' | ') || '(none)'}`;
  // Log to stdout for forensic deep-dives, AND also surface in the return
  // so the campaign loop can pipe it into the dashboard-visible log.
  console.log(`[bulk-check] diag: ${diagSummary}`);

  if (updates.length === 0) {
    return { matched: 0, fetched: conns.length, diag: diagSummary, connectedUrls };
  }

  // Batch-update via the existing Apps Script bridge. cc → 'Connected
  // Status' column on the new schema; FIELD_MAP handles the column mapping.
  try {
    await batchUpdateSheet(sheetUrl, updates);
  } catch (err) {
    return { matched: 0, fetched: conns.length, error: `batch-update: ${err.message}`, diag: diagSummary, connectedUrls };
  }

  const matchedCount = updates.filter((u) => u.cc === 'Connected').length;
  const pendingCount = updates.length - matchedCount;
  // connectedUrls comes from computeBulkCheckUpdates — includes matched URLs
  // regardless of suppressAcceptedStamp, so callers can fire auto-intros.
  return { matched: matchedCount, fetched: conns.length, stamped: pendingCount, diag: diagSummary, connectedUrls };
}
