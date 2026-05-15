/**
 * Auto-introduction pass — shared by the in-campaign loop, the manual
 * Bulk Check button, and the post-campaign scheduler.
 *
 * Given a list of leads that just flipped to Connected (returned by
 * bulkCheckConnections.connectedUrls), navigate to each profile and send
 * a 3-way intro DM that includes the configured primary person. Stamps
 * `Introduction Status` on each row.
 *
 * v2.13.14: Construct templates + data exactly the way campaign.js builds
 * them for the Introduce Back batch loop — same `tpl` shape, same `data`
 * enrichment, same call signature into performOutreach. The only overlay
 * is `introMode: true`, `introName: primaryName`, `followUpMessage:
 * primaryIntroBody`, and `introUrl: primaryUrl` (which triggers URL
 * routing for the second pill in sendIntroMessage, sidestepping the
 * unreliable typeahead). senderFirstNames is honoured so
 * `{sender first name}` resolves to the operator-configured nice name
 * rather than the GoLogin email.
 */

import { performOutreach } from './outreach.js';
import { fetchSheet } from '../sheets.js';
import { updateSheetRow } from '../sheets-writer.js';
import { extractLinkedInUrl, withWatchdog, LEAD_TIMEOUT_MS } from '../campaign.js';

function _formatLocalDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const ord = (n) => (n % 10 === 1 && n % 100 !== 11) ? 'st'
    : (n % 10 === 2 && n % 100 !== 12) ? 'nd'
    : (n % 10 === 3 && n % 100 !== 13) ? 'rd' : 'th';
  return `${months[d.getMonth()]} ${day}${ord}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param {object} args
 * @param {puppeteer.Page} args.page          - active page on a logged-in LinkedIn session
 * @param {string} args.profileId             - sender's GoLogin profile id
 * @param {string} args.profileName           - sender's display label (email)
 * @param {string} args.sheetUrl              - target sheet URL (used to look up row data)
 * @param {string} args.linkedinColumn        - operator-specified URL column name
 * @param {string[]} args.connectedUrls       - leads that just flipped to Connected
 * @param {object} args.templates             - wizard templates (full object — primaryName, primaryUrl, primaryIntroBody, introTitle, etc.)
 * @param {Record<string,string>} [args.senderFirstNames] - operator-configured nice names per profileId
 * @param {Function} [args.log]               - log function (defaults to console.log)
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
export async function runAutoIntros({
  page,
  profileId,
  profileName,
  sheetUrl,
  linkedinColumn,
  connectedUrls,
  templates = {},
  senderFirstNames = {},
  log = console.log,
}) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return result;

  const primaryName      = (templates.primaryName      || '').trim();
  const primaryIntroBody = (templates.primaryIntroBody || '').trim();
  const primaryUrl       = (templates.primaryUrl       || '').trim();

  if (!primaryName || !primaryIntroBody) {
    log(`  ⚠ [${profileName}] ${connectedUrls.length} acceptance(s) found but Primary Person name/body missing — skipping auto-intro.`);
    result.skipped = connectedUrls.length;
    return result;
  }

  // Build the templates object the way campaign.js does for Introduce Back —
  // same shape, full wizard inheritance — with the CC+IC-specific overlay.
  // `introUrl` is what makes sendIntroMessage use URL-routing for the
  // second pill (see actions.js:1284 and outreach.js:488). Without it the
  // call would fall back to the typeahead-typing path, which is what was
  // failing in the field with "dropdown never opened".
  const tpl = {
    ...templates,
    introMode: true,
    introName: primaryName,
    followUpMessage: primaryIntroBody,
    introUrl: primaryUrl,
    introTitle: templates.introTitle || 'Introduction: {first name} <> {intro name}',
  };

  // Re-fetch sheet to map URLs → row data for placeholder substitution.
  // Cheap (single CSV read) and necessary because outreach.js merges the
  // row data into templates so {first name}, {primary name}, etc. resolve.
  let rows = [];
  try { rows = await fetchSheet(sheetUrl); } catch { /* best-effort — empty data is fine */ }
  const rowByUrl = new Map();
  for (const r of rows) {
    const u = extractLinkedInUrl(r, linkedinColumn);
    if (u) rowByUrl.set(u, r);
  }

  log(`  🤝 [${profileName}] Auto-introducing ${connectedUrls.length} new connection(s) to ${primaryName}…`);
  for (const url of connectedUrls) {
    // Build `data` the EXACT same way campaign.js builds it for the IB
    // batch loop (see src/campaign.js around the `Build template data`
    // comment). senderFirstName resolves from the operator-configured
    // map first, falling back to splitting the profile display name —
    // matching IB byte-for-byte.
    const row = rowByUrl.get(url) || {};
    const resolvedFirst = senderFirstNames[profileId];
    const data = {
      ...row,
      firstName: row['First Name'] || row['firstName'] || row['first_name'] || '',
      lastName: row['Last Name'] || row['lastName'] || row['last_name'] || '',
      company: row['Company'] || row['company'] || '',
      title: row['Title'] || row['title'] || row['Job Title'] || '',
      senderName: profileName || '',
      senderFirstName: (resolvedFirst && resolvedFirst.trim())
        || (profileName || '').split(/\s+/)[0]
        || '',
      // Surface the primary person under both the variable-button label
      // ("primary name") and the camelCase form so either flavour the
      // operator types in their template resolves.
      primaryName,
      'primary name': primaryName,
      primaryUrl: primaryUrl || '',
      'primary url': primaryUrl || '',
    };
    log(`  ✓ [${profileName}] ${url}: Connection Accepted (stamped at detection)`);

    try {
      let introResult;
      let attempt = 0;
      while (attempt < 2) {
        attempt++;
        try {
          introResult = await withWatchdog(
            performOutreach(page, url, { ...tpl, data }, { profileId }, 'force_message'),
            LEAD_TIMEOUT_MS,
            profileId,
          );
        } catch (watchdogErr) {
          if (watchdogErr && watchdogErr.kind === 'watchdog') {
            log(`  ⏱ [${profileName}] Intro DM timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
            introResult = { action: 'skipped', error: 'intro_timeout_watchdog' };
            break; // watchdog timeout — don't retry
          }
          throw watchdogErr;
        }

        // Check for transient typeahead miss — retry once before giving up.
        const errStr = String(introResult?.error || '');
        if (attempt < 2 && errStr.includes('INTRO_RECIPIENT_NOT_FOUND')) {
          log(`  ↻ [${profileName}] ${url}: typeahead miss, retrying once…`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
      const ok = introResult && (introResult.action === 'message_sent' || introResult.action === 'already_processed');
      // v2.14.x: Connection Accepted Status is now stamped at bulk-check
      // detection (suppressAcceptedStamp=false in the campaign call sites).
      // auto-intro only stamps Introduction Status here.
      const tracking = {
        introductionStatus: ok ? 'Introduction Made' : 'Failed',
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: ok ? `Introduction sent to ${primaryName}` : `Intro failed: ${introResult?.error || 'unknown'}`,
      };
      await updateSheetRow(sheetUrl, url, tracking, linkedinColumn).catch(() => {});
      if (ok) {
        result.sent++;
        log(`  🤝 [${profileName}] ${url}: Introduction Made`);
      } else {
        result.failed++;
        log(`  ⚠ [${profileName}] ${url}: Failed (${introResult?.error || introResult?.action || '?'})`);
      }
    } catch (err) {
      result.failed++;
      await updateSheetRow(sheetUrl, url, {
        introductionStatus: 'Failed',
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: `Intro threw: ${err.message}`,
      }, linkedinColumn).catch(() => {});
      log(`  ⚠ [${profileName}] Intro DM threw for ${url}: ${err.message}`);
    }
  }
  return result;
}
