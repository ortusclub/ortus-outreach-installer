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

import { sendIntroMessage } from './actions.js';
import { sendIntroViaVoyager } from './intro-voyager.js';
import { personalizeTemplate } from './helpers.js';
import { fetchSheet } from '../sheets.js';
import { updateSheetRow } from '../sheets-writer.js';
import { extractLinkedInUrl, campaign } from '../campaign.js';

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

  // v2.14.x: split primaryName on whitespace so operators can write
  // "Hey {firstName}, let me introduce you {primary first name}" instead
  // of always rendering the full name. Mirrors the intro-name split in
  // outreach.js:469-484 for the IB path.
  const primaryTokens    = primaryName.split(/\s+/);
  const primaryFirstName = primaryTokens[0] || '';
  const primaryLastName  = primaryTokens.slice(1).join(' ');

  // v2.14.x: split introName (=primaryName) the same way outreach.js:469-484
  // does for IB, so {intro first name} / {intro last name} resolve in both
  // the body and the group title.
  const introTokens = primaryName.split(/\s+/);
  const introFirst  = introTokens[0] || '';
  const introLast   = introTokens.slice(1).join(' ');

  // v2.14.x: bail-out helper. When stop is pressed mid-batch or the browser
  // dies under us, the remaining intros never get a fair attempt — stamp
  // them with a 'Skipped — <reason>' status so the operator does NOT see a
  // cascade of bogus 'Failed' marks. Reason ∈ {'Stop pressed','browser closed'}.
  // The next campaign run / bulk-check sweep will re-detect these leads as
  // Connected with no Introduction Status and fire the intro fresh.
  async function _stampSkipped(skippedUrls, reason) {
    for (const skippedUrl of skippedUrls) {
      await updateSheetRow(sheetUrl, skippedUrl, {
        introductionStatus: `Skipped — ${reason}`,
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: `Intro skipped: ${reason} (lead never attempted)`,
      }, linkedinColumn).catch(() => {});
      result.skipped++;
    }
  }
  // v2.14.x: returns true when the puppeteer page is dead — browser was
  // killed (closeAllProfiles), the websocket dropped, or the tab was closed.
  // page.isClosed() is documented but flaky in edge cases (puppeteer#6695);
  // pairing it with browser.connected catches every real scenario.
  function _browserAlive() {
    try {
      const b = page.browser?.();
      if (!b || b.connected === false) return false;
      if (page.isClosed?.()) return false;
      return true;
    } catch { return false; }
  }

  log(`  🤝 [${profileName}] Auto-introducing ${connectedUrls.length} new connection(s) to ${primaryName}…`);
  for (let i = 0; i < connectedUrls.length; i++) {
    const url = connectedUrls[i];

    // v2.14.x: graceful-abort checkpoint. Without this guard, runAutoIntros
    // keeps iterating against a dead page after the operator presses Stop
    // (which force-closes browsers from server.js:/api/campaign/stop) or
    // after any silent browser death — every subsequent sendIntroMessage
    // fails fast at 'compose textbox did not appear' and stamps the lead
    // as 'Failed', producing the 7-bogus-Failed cascade seen 2026-05-17.
    // Industry pattern (Crawlee #1102, Puppeteer #4671): check abort flag
    // + browser-alive between iterations and bail out cleanly. Remaining
    // leads are stamped as 'Skipped — <reason>' so the operator can tell
    // them apart from real LinkedIn-side failures.
    if (campaign._abort) {
      log(`  ■ [${profileName}] Stop detected — marking remaining ${connectedUrls.length - i} intro(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'Stop pressed');
      break;
    }
    if (!_browserAlive()) {
      log(`  ■ [${profileName}] Browser closed — marking remaining ${connectedUrls.length - i} intro(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'browser closed');
      break;
    }

    // Build `data` the EXACT same way campaign.js builds it for the IB
    // batch loop (see src/campaign.js around the `Build template data`
    // comment). senderFirstName resolves from the operator-configured
    // map first, falling back to splitting the profile display name —
    // matching IB byte-for-byte.
    const row = rowByUrl.get(url) || {};
    const resolvedFirst = senderFirstNames[profileId];
    // v2.14.x: tolerate every reasonable casing of the name columns —
    // "First Name" / "first name" / "FIRST NAME" / "First name" /
    // "firstName" / "first_name". Without this, a column header like
    // "first name" (lowercase) silently produces an empty firstName and
    // the intro DM goes out as "Hey , let me introduce you…" with the
    // lead's name missing. See live-test screenshot 2026-05-15.
    const leadFirstName = row['First Name'] || row['First name'] || row['first name']
      || row['FIRST NAME'] || row['firstName'] || row['FirstName'] || row['first_name'] || '';
    const leadLastName = row['Last Name'] || row['Last name'] || row['last name']
      || row['LAST NAME'] || row['lastName'] || row['LastName'] || row['last_name'] || '';
    const data = {
      ...row,
      firstName: leadFirstName,
      lastName: leadLastName,
      // v2.14.x: the default introTitle is `'Introduction: {first name}
      // <> {intro name}'` (with a space). Without these aliases the
      // {first name} token never resolves and the thread title renders
      // as "Introduction:  <> Antonio Varlese" with the lead's name
      // missing. Mirror the camelCase + with-space dual-flavour pattern
      // outreach.js uses for intro name.
      'first name': leadFirstName,
      'last name': leadLastName,
      company: row['Company'] || row['company'] || '',
      title: row['Title'] || row['title'] || row['Job Title'] || '',
      senderName: profileName || '',
      senderFirstName: (resolvedFirst && resolvedFirst.trim())
        || (profileName || '').split(/\s+/)[0]
        || '',
      // Surface the primary person under every naming flavour the
      // operator might have typed: legacy "primary name", new
      // "primary full name" (v2.14.x rename), and the camelCase form.
      // All three resolve to the same full name so old templates keep
      // working after the wizard chip rename.
      primaryName,
      'primary name': primaryName,
      'primary full name': primaryName,
      'primaryFullName': primaryName,
      'primary_full_name': primaryName,
      primaryUrl: primaryUrl || '',
      'primary url': primaryUrl || '',
      // v2.14.x: primary-name split — operators can now write just
      // {primary first name} instead of always {primary name}. All
      // three naming flavours accepted (with-space label, camelCase,
      // snake_case) for parity with how outreach.js handles intro name.
      'primary first name': primaryFirstName,
      'primaryFirstName':   primaryFirstName,
      'primary_first_name': primaryFirstName,
      'primary last name': primaryLastName,
      'primaryLastName':   primaryLastName,
      'primary_last_name': primaryLastName,
    };
    // v2.14.x: diagnostic log — surfaces whether rowByUrl found the lead
    // and what firstName/lastName resolved to. If the field still comes
    // up empty after the casing tolerance above, this line tells the
    // operator exactly which column header to fix in their sheet.
    log(`     · row matched=${!!rowByUrl.get(url)} firstName="${leadFirstName}" lastName="${leadLastName}"`);
    log(`  ✓ [${profileName}] ${url}: Connection Accepted (stamped at detection)`);

    // v2.14.x: IC DM fast-path — bypass performOutreach entirely.
    //
    // The old path called performOutreach(..., 'force_message') which did:
    //   1. page.goto(leadProfile, { waitUntil: 'networkidle0', timeout: 30s })
    //   2. waitForDomSettle (1.5s settle + 2s buffer)
    //   3. zoom=75%
    //   4. Voyager degree check + getConnectionStatus DOM check
    //   5. → eventually called sendIntroMessage, which navigates to compose anyway
    //
    // For IC DM none of (1)-(4) is necessary: bulk-check just confirmed
    // degree=1 within the last ~60s, and sendIntroMessage navigates to its
    // own compose URL. The profile-visit detour wasted 5-30s per lead in
    // background-throttled mode and was the underlying reason the 180s
    // watchdog kept firing. Now we build the body/title from templates and
    // call sendIntroMessage directly with the lead URL as the 6th arg.
    //
    // INTRO_RECIPIENT_NOT_FOUND retry-once is preserved.
    const introData = {
      ...data,
      'intro name':       primaryName,
      'introName':        primaryName,
      'intro_name':       primaryName,
      'intro first name': introFirst,
      'introFirstName':   introFirst,
      'intro_first_name': introFirst,
      'intro last name':  introLast,
      'introLastName':    introLast,
      'intro_last_name':  introLast,
    };
    const body  = personalizeTemplate(tpl.followUpMessage, introData);
    const title = personalizeTemplate(tpl.introTitle, introData);

    // v2.51.0 — Voyager-first intro send. When primaryUrl is set, try the
    // direct API path (POST /voyager/api/.../createMessage). If it succeeds,
    // skip the DOM typeahead entirely. If it fails (4xx, network error,
    // URN-resolve fail), fall through to the existing typeahead loop below
    // BYTE-FOR-BYTE UNCHANGED. Spec: 2026-05-18-voyager-intro-send-design.md
    let _voyagerOk = false;
    let _voyagerConversationUrn = '';
    if (primaryUrl) {
      try {
        const vResult = await sendIntroViaVoyager({ page, leadUrl: url, primaryUrl, body, title });
        if (vResult.ok) {
          _voyagerOk = true;
          _voyagerConversationUrn = vResult.conversationUrn;
          if (vResult.retriedWithoutTitle) {
            log(`  🤝 [${profileName}] ${url}: Voyager ok (retried without title), convo=${vResult.conversationUrn}`);
          } else {
            log(`  🤝 [${profileName}] ${url}: Voyager ok, convo=${vResult.conversationUrn}`);
          }
        } else {
          const detail = vResult.phase || 'unknown';
          const reason = vResult.reason || (vResult.firstAttempt && vResult.firstAttempt.status) || '';
          log(`  ↪ [${profileName}] ${url}: Voyager rejected (phase=${detail}, reason=${reason}) — falling back to typeahead`);
        }
      } catch (voyErr) {
        log(`  ↪ [${profileName}] ${url}: Voyager threw (${voyErr.message || voyErr}) — falling back to typeahead`);
      }
    }

    let ok = _voyagerOk;
    let alreadyMade = false;
    let errMsg = '';
    let attempt = 0;
    while (!ok && attempt < 2) {
      attempt++;
      try {
        await sendIntroMessage(page, body, primaryName, title, '', url);
        ok = true;
        break;
      } catch (err) {
        errMsg = err.message || String(err);
        // v2.14.x: sendIntroMessage detected via URL-settle that the trio
        // already has an existing intro thread (LinkedIn redirected from
        // /compose/?recipient=X to /messaging/thread/{id} mid-type). Stamp
        // 'Introduction Already Made' to preserve the audit distinction
        // between intros made by THIS run vs pre-existing ones.
        if (errMsg.includes('INTRO_ALREADY_EXISTS')) {
          alreadyMade = true;
          break;
        }
        if (attempt < 2 && errMsg.includes('INTRO_RECIPIENT_NOT_FOUND')) {
          log(`  ↻ [${profileName}] ${url}: typeahead miss, retrying once…`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
    }

    // v2.14.x: was the failure caused by abort or by the browser dying
    // mid-send? If so, this isn't a Failed (LinkedIn-side rejection) — it
    // never got a fair attempt. Reclassify as Skipped so the operator can
    // tell phantom failures apart from real ones.
    const interrupted = !ok && !alreadyMade && (campaign._abort || !_browserAlive());
    const interruptReason = campaign._abort ? 'Stop pressed' : 'browser closed';

    // v2.14.x: Connection Accepted Status is stamped at bulk-check
    // detection (suppressAcceptedStamp=false in the campaign call sites).
    // auto-intro only stamps Introduction Status here.
    const tracking = {
      introductionStatus: alreadyMade
        ? 'Introduction Already Made'
        : ok
          ? 'Introduction Made'
          : interrupted
            ? `Skipped — ${interruptReason}`
            : 'Failed',
      sender: profileName,
      accountUsed: profileName,
      dateLastAction: _formatLocalDate(new Date()),
      auditAction: alreadyMade
        ? `Introduction thread already exists with ${primaryName}`
        : ok
          ? `Introduction sent to ${primaryName}`
          : interrupted
            ? `Intro skipped: ${interruptReason} (interrupted mid-send)`
            : `Intro failed: ${errMsg || 'unknown'}`,
    };
    await updateSheetRow(sheetUrl, url, tracking, linkedinColumn).catch(() => {});
    if (ok) {
      // v2.14.x: blacklist this URL for the rest of the process so the next
      // bulk-check pass (5-min cooldown) doesn't re-fire the same intro.
      // Primary defense against Google Sheets CSV-export cache lag.
      try { campaign.introducedInRun?.add(url); } catch { /* */ }
      result.sent++;
      log(`  🤝 [${profileName}] ${url}: Introduction Made`);
    } else if (alreadyMade) {
      // Counted as a sent (the intro is effectively done — there's an
      // active thread) so result.sent reflects real coverage rather than
      // creating a third counter the campaign loop would have to learn
      // about. The distinct sheet stamp + log line preserve the audit.
      try { campaign.introducedInRun?.add(url); } catch { /* */ }
      result.sent++;
      log(`  ⏳ [${profileName}] ${url}: Introduction Already Made (existing thread detected)`);
    } else if (interrupted) {
      result.skipped++;
      log(`  ■ [${profileName}] ${url}: Skipped — ${interruptReason}`);
      // Browser is dead / abort raised — stamp the rest as skipped and exit
      // the for-loop rather than wasting cycles on guaranteed failures.
      if (i < connectedUrls.length - 1) {
        log(`  ■ [${profileName}] Marking remaining ${connectedUrls.length - i - 1} intro(s) as Skipped.`);
        await _stampSkipped(connectedUrls.slice(i + 1), interruptReason);
      }
      break;
    } else {
      result.failed++;
      log(`  ⚠ [${profileName}] ${url}: Failed (${errMsg || 'unknown'})`);
    }

    // v2.14.x: brief feed visit between IC DMs. Mirrors the organic
    // browsing the campaign loop does between connect requests — gives
    // the compose page a clean reset before the next intro and pads
    // the cadence to look less robotic. Skipped after the last lead.
    if (i < connectedUrls.length - 1) {
      try {
        log(`  🔄 [${profileName}] Brief feed visit between intros…`);
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {
        // Feed visit is best-effort; don't fail the batch over it.
        log(`  ⚠ [${profileName}] Feed visit warning: ${e.message}`);
      }
    }
  }
  return result;
}
