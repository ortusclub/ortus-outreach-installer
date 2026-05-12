/**
 * Auto-introduction pass — shared by the in-campaign loop, the manual
 * Bulk Check button, and the post-campaign scheduler.
 *
 * Given a list of leads that just flipped to Connected (returned by
 * bulkCheckConnections.connectedUrls), navigate to each profile and send
 * a 3-way intro DM that includes the configured primary person. Stamps
 * `Introduction Status` on each row.
 *
 * Reuses the introduce_back outreach flow (introMode=true) — same code
 * path that the standalone Introduce Back mode uses, just with the
 * primary person's name/body overriding introName/title/body.
 */

import { performOutreach } from './outreach.js';
import { fetchSheet } from '../sheets.js';
import { updateSheetRow } from '../sheets-writer.js';
import { extractLinkedInUrl } from '../campaign.js';

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
 * @param {string} args.primaryName           - primary person's full LinkedIn name
 * @param {string} args.primaryIntroBody      - DM body template (with placeholders)
 * @param {string} [args.primaryUrl]          - optional primary person URL (placeholder)
 * @param {string} [args.introTitle]          - group thread title template
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
  primaryName,
  primaryIntroBody,
  primaryUrl = '',
  introTitle = 'Introduction: {first name} <> {intro name}',
  log = console.log,
}) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return result;
  if (!primaryName || !primaryIntroBody) {
    log(`  ⚠ [${profileName}] ${connectedUrls.length} acceptance(s) found but Primary Person name/body missing — skipping auto-intro.`);
    result.skipped = connectedUrls.length;
    return result;
  }

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

  const introTpl = {
    introMode: true,
    introName: primaryName,
    introTitle,
    followUp1: primaryIntroBody,
    primaryName,
    primaryUrl,
    primaryIntroBody,
  };

  log(`  🤝 [${profileName}] Auto-introducing ${connectedUrls.length} new connection(s) to ${primaryName}…`);
  for (const url of connectedUrls) {
    try {
      const introResult = await performOutreach(
        page,
        url,
        { ...introTpl, data: rowByUrl.get(url) || {} },
        { profileId },
        'force_message',
      );
      const ok = introResult && (introResult.action === 'message_sent' || introResult.action === 'already_processed');
      await updateSheetRow(sheetUrl, url, {
        introductionStatus: ok ? 'Introduction Made' : 'Failed',
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: ok ? `Introduction sent to ${primaryName}` : `Intro failed: ${introResult?.error || 'unknown'}`,
      }, linkedinColumn).catch(() => {});
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
