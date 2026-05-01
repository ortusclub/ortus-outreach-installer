/**
 * Per-target outreach — v19.
 *
 * For each lead:
 *   1. Open lead's LinkedIn profile
 *   2. Smart wait: networkidle + MutationObserver settling (5-15s vs old 30s)
 *   3. No zoom, no viewport change — keep 1366x900 (matches physical window)
 *   4. Execute action via JS click (works regardless of element visibility)
 */

import { randomDelay, getConnectionStatus, getVoyagerDegree, personalizeTemplate } from './helpers.js';
import { sendConnectionRequest, sendMessage, sendInMail, sendViaSalesNav, resolveSalesNavUrlFromInProfile } from './actions.js';

// Matches Sales Navigator profile URLs (linkedin.com/sales/people/… or /sales/lead/…).
// Used to short-circuit the /in/-shaped status check for sheets whose rows are
// direct Sales Nav links rather than standard profile URLs.
const SALES_NAV_URL_RE = /\/sales\/(people|lead)\//;

// LinkedIn encoded member URN in an /in/ URL — e.g. `ACwAAAAqhRIB3oRn1YJ…`.
// Always starts with "AC" and is followed by URL-safe base64 chars. We transform
// these directly to Sales Nav URLs. Vanity /in/ slugs (e.g. /in/john-smith) do
// not match and cannot be transformed — the lead skips with a clear reason.
// Phase 2.8.17 (H-01): allow `#fragment` as a URN terminator. Sales Nav emits
// `#chat`, `#tab=…` etc. and operators copy-paste deep links — without `#`
// the regex returned null and the lead skipped with "URL not in URN format".
const IN_MEMBER_URN_RE = /\/in\/(AC[A-Za-z0-9_-]{10,})(?:[/?#]|$)/;

// Sales Nav member URN in a /sales/lead/ or /sales/people/ URL — same encoding
// as /in/, used for the reverse transform (Connect campaigns need /in/ because
// Sales Nav pages don't expose the Connect button the same way).
const SALES_MEMBER_URN_RE = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;

/**
 * Smart wait: resolves when the DOM stops changing for 1.5s OR after maxWait ms.
 * Much faster than a fixed 30s wait — typically resolves in 5-10s.
 */
async function waitForDomSettle(page, { settleMs = 1500, maxWait = 15000 } = {}) {
  await page.evaluate(({ settleMs, maxWait }) => new Promise((resolve) => {
    const target = document.querySelector('main') || document.body;
    let timer;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { observer.disconnect(); resolve(); }, settleMs);
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    // Kick off the settle timer immediately (in case DOM is already done)
    timer = setTimeout(() => { observer.disconnect(); resolve(); }, settleMs);
    // Hard ceiling
    setTimeout(() => { observer.disconnect(); resolve(); }, maxWait);
  }), { settleMs, maxWait });
}

export async function performOutreach(page, targetUrl, templates, state = {}, modeHint = null) {
  try {
    let url = targetUrl.trim();
    if (!url.startsWith('http')) url = 'https://' + url;

    // ── URL transform: /in/{memberId} → /sales/lead/{memberId} for OP/InMail ──
    // Routes campaigns that need the Sales Nav composer (positive
    // "Free to Open Profile" signal) straight to the Sales Nav lead page, so
    // we never load /in/ at all. Vanity slugs (/in/john-smith) can't be
    // transformed — those skip with a clear reason.
    if (modeHint === 'force_open_profile' || modeHint === 'force_inmail') {
      if (!SALES_NAV_URL_RE.test(url)) {
        const m = url.match(IN_MEMBER_URN_RE);
        if (!m) {
          console.warn('[outreach] /in/ URL not in encoded member-URN format — cannot route to Sales Nav');
          return { action: 'skipped', error: 'URL not in member-URN format — cannot route to Sales Nav' };
        }
        url = `https://www.linkedin.com/sales/lead/${m[1]}`;
        console.log(`[outreach] Transformed /in/ → Sales Nav: ${url}`);
      }
    }

    // ── URL transform: /sales/lead/{memberId} → /in/{memberId} for Connect / Message ──
    // Sales Nav pages don't expose the Connect button the same way /in/ pages
    // do, and the /in/-shaped status check false-positives "already connected"
    // on Sales Nav DOM → lead gets skipped. For connection campaigns, reverse
    // the transform: extract the URN and rebuild as /in/{urn}.
    // 2.8.36: also for force_message — sendMessage parses publicId from
    // /in/<id> in the URL, so a Sales Nav URL would throw "could not parse
    // publicId" without this rewrite.
    if (modeHint === 'force_connect' || modeHint === 'force_message') {
      if (SALES_NAV_URL_RE.test(url)) {
        const m = url.match(SALES_MEMBER_URN_RE);
        if (!m) {
          console.warn('[outreach] Sales Nav URL not in encoded member-URN format — cannot route to /in/');
          return { action: 'skipped', error: 'Sales Nav URL not in member-URN format — cannot route to /in/' };
        }
        url = `https://www.linkedin.com/in/${m[1]}`;
        console.log(`[outreach] Transformed Sales Nav → /in/: ${url}`);
      }
    }

    // ── Step 0: Check LinkedIn session cookie health ──
    try {
      const cookies = await page.cookies('https://www.linkedin.com');
      const liAt = cookies.find(c => c.name === 'li_at');
      if (!liAt) {
        console.warn('[outreach] ⚠ No li_at cookie — session may be expired');
        return { action: 'skipped', error: 'LinkedIn session expired (no li_at cookie)' };
      }
      // Check if cookie expires soon (within 1 hour)
      if (liAt.expires > 0) {
        const expiresIn = liAt.expires - (Date.now() / 1000);
        if (expiresIn < 3600) {
          console.warn(`[outreach] ⚠ li_at cookie expires in ${Math.round(expiresIn / 60)}min`);
        }
      }
    } catch { /* cookie check is best-effort */ }

    // ── Step 1: Navigate to lead's profile ──
    // 2.8.29 perf: check_only uses domcontentloaded (not networkidle0) — the
    // Voyager API only needs the URL pathname + cookies, both available as
    // soon as the document parses. networkidle0 waits for LinkedIn's polling
    // to stop and routinely costs 10-20s of dead time. Send paths still wait
    // because they need the action buttons rendered.
    const navWait = (modeHint === 'check_only') ? 'domcontentloaded' : 'networkidle0';
    const navTimeout = (modeHint === 'check_only') ? 15000 : 30000;
    try {
      await page.goto(url, { waitUntil: navWait, timeout: navTimeout });
    } catch (e) {
      console.log(`[outreach] ${navWait} timed out, continuing: ${e.message}`);
    }

    // ── Step 2: DOM settle / buffer / zoom — only needed for paths that
    // interact with the page. check_only reads the Voyager API and exits.
    if (modeHint !== 'check_only') {
      console.log('[outreach] Waiting for DOM to settle…');
      await waitForDomSettle(page, { settleMs: 1500, maxWait: 15000 });
      await new Promise(r => setTimeout(r, 2000));
      console.log('[outreach] DOM settled.');
      await page.evaluate(() => { document.body.style.zoom = '75%'; });
    }

    // ── Step 2b: Human-like browsing — scroll profile and dwell ──
    // 2.8.29: skip the entire dwell block for check_only — read-only mode,
    // no LinkedIn-visible action that could be flagged. The dwell is pure
    // anti-detection padding for sends, not reads. Saves 5-30s per check.
    // 2.8.35: also skip for force_message — DMing 1st-degree connections is
    // low-risk; no need to scroll the profile before navigating to compose.
    if (modeHint !== 'check_only' && modeHint !== 'force_message') {
      // ~20% chance of a "deep read" (20-30s) to mimic genuinely interested browsing
      const isDeepRead = Math.random() < 0.2;
      const dwellTime = isDeepRead
        ? 20000 + Math.floor(Math.random() * 10000)   // 20-30s deep read
        : 5000 + Math.floor(Math.random() * 5000);     // 5-10s normal browse
      console.log(`[outreach] Browsing profile (${isDeepRead ? 'deep read ' : ''}${(dwellTime / 1000).toFixed(0)}s)…`);

      // Scroll down with Page Down (works regardless of zoom)
      await page.keyboard.press('PageDown');
      await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1500)));
      await page.keyboard.press('PageDown');

      if (isDeepRead) {
        // Deep read: scroll further down, pause, scroll more — like reading their experience
        await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 3000)));
        await page.keyboard.press('PageDown');
        await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
        await page.keyboard.press('PageDown');
        await new Promise(r => setTimeout(r, dwellTime - 10000)); // remaining dwell
      } else {
        await new Promise(r => setTimeout(r, dwellTime));
      }

      // Scroll back to top
      await page.keyboard.press('Home');
      await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
    }

    // Check for login/404/rate-limit
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      return { action: 'skipped', error: 'Login page detected' };
    }
    if (currentUrl.includes('/404') || currentUrl.includes('unavailable')) {
      return { action: 'skipped', error: 'Profile not found' };
    }

    // Detect rate-limit or error pages
    const pageError = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase().substring(0, 3000);
      if (text.includes('please try again later') || text.includes('too many requests'))
        return 'rate_limited';
      if (text.includes('this page doesn') && text.includes('exist'))
        return 'page_not_found';
      if (text.includes('something went wrong'))
        return 'linkedin_error';
      return null;
    });
    if (pageError) {
      return { action: 'skipped', error: `Page error: ${pageError}` };
    }

    // ── Step 3: Detect status and execute action ──
    // Fast-path: Voyager API degree check (more reliable than DOM scraping)
    const voyagerDegree = await getVoyagerDegree(page);
    // Voyager gives definitive answers for degree-1 (connected) and can help
    // disambiguate when DOM detection returns 'unknown'

    let status;

    if (modeHint === 'check_only') {
      // Voyager fast-path: same source as the 1st-degree badge LinkedIn renders.
      if (voyagerDegree === 1) {
        console.log('[outreach] Voyager: degree=1 → accepted');
        return { action: 'status_accepted' };
      }
      if (voyagerDegree === 2 || voyagerDegree === 3) {
        // Not connected per the API — but we still need to know if our invite
        // is pending or was withdrawn/declined. That requires the DOM button.
        console.log(`[outreach] Voyager: degree=${voyagerDegree} → check button state`);
      }
      // 2.8.29 perf: only settle the DOM when we actually need to scrape it
      // (Voyager didn't give a definitive degree-1 answer).
      await waitForDomSettle(page, { settleMs: 1000, maxWait: 8000 });
      status = await getConnectionStatus(page);
      console.log(`[outreach] Check status: ${status}`);
      if (status === 'message') return { action: 'status_accepted' };
      if (status === 'pending') return { action: 'status_pending' };
      if (status === 'connect' || status === 'follow') return { action: 'status_declined' };
      return { action: 'status_unknown', error: `Status: ${status}` };
    } else if (modeHint === 'force_connect') {
      // Voyager fast-path: if already connected, skip immediately
      if (voyagerDegree === 1) {
        console.log('[outreach] Voyager: degree=1 → already connected');
        return { action: 'skipped', error: 'Already connected' };
      }
      status = await getConnectionStatus(page);
      if (status === 'message') return { action: 'skipped', error: 'Already connected' };
      if (status === 'pending') return { action: 'already_processed' };
      if (status !== 'connect') {
        console.log(`[outreach] Status="${status}", will try Connect (retry loop handles More fallback)`);
        status = 'connect';
      }
    } else if (modeHint === 'force_message') {
      // Voyager fast-path: need degree 1 to message
      if (voyagerDegree !== null && voyagerDegree !== 1) {
        console.log(`[outreach] Voyager: degree=${voyagerDegree} → not connected yet`);
        return { action: 'skipped', error: 'Not yet connected' };
      }
      status = await getConnectionStatus(page);
      if (status === 'connect') return { action: 'skipped', error: 'Not yet connected' };
      if (status === 'pending') return { action: 'skipped', error: 'Still pending' };
      status = 'message';
    } else if (modeHint === 'force_inmail') {
      // Upfront conversion guaranteed we're on a Sales Nav URL.
      // sendViaSalesNav routes: "Free to Open Profile" badge → OP template
      // (free); credit counter with credits → InMail template; 0 credits → skip.
      const d = templates.data || {};
      const result = await sendViaSalesNav(page, {
        mode: 'force_inmail',
        opSubject:     personalizeTemplate(templates.openProfileSubject || '', d),
        opBody:        personalizeTemplate(templates.openProfileBody || '', d),
        inmailSubject: personalizeTemplate(templates.inmail?.subject || '', d),
        inmailBody:    personalizeTemplate(templates.inmail?.message || '', d),
      });
      if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
      if (result.ok && result.kind === 'inmail_sent')     return { action: 'inmail_sent', creditsLeft: result.creditsLeft };
      if (result.reason === 'message_button_not_found')   return { action: 'skipped', error: 'Sales Nav Message button not found' };
      if (result.reason === 'no_compose_textbox')         return { action: 'skipped', error: 'Sales Nav compose textbox did not appear' };
      if (result.reason === 'no_credits')                 return { action: 'skipped', error: 'INMAIL_NO_CREDITS: 0 credits remaining' };
      if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
      return { action: 'skipped', error: 'Sales Nav: unknown result' };
    } else if (modeHint === 'force_open_profile') {
      // Upfront conversion guaranteed we're on a Sales Nav URL. Delegate to
      // sendViaSalesNav; it uses isFreeToOpenProfile to gate free-vs-paid.
      if (!templates.openProfileBody) return { action: 'skipped', error: 'No Open Profile template' };
      const d = templates.data || {};
      const result = await sendViaSalesNav(page, {
        mode: 'force_open_profile',
        opSubject: personalizeTemplate(templates.openProfileSubject || '', d),
        opBody:    personalizeTemplate(templates.openProfileBody    || '', d),
      });
      if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
      if (result.reason === 'message_button_not_found')   return { action: 'skipped', error: 'Sales Nav Message button not found' };
      if (result.reason === 'not_open_profile')           return { action: 'skipped', error: 'NOT_OPEN_PROFILE: Free to Open Profile badge not present on Sales Nav panel' };
      if (result.reason === 'no_compose_textbox')         return { action: 'skipped', error: 'Sales Nav compose textbox did not appear' };
      if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
      return { action: 'skipped', error: 'Sales Nav: unknown result' };
    } else if (modeHint === 'force_connect_op_fallback') {
      // "Message Open Profiles Directly" in Connect campaign — try OP first,
      // fall back to Connect if the lead isn't OP-enabled.
      const d = templates.data || {};
      const opSubj = templates.openProfileSubject ? personalizeTemplate(templates.openProfileSubject, d) : '';
      const opBody = templates.openProfileBody    ? personalizeTemplate(templates.openProfileBody,    d) : '';
      const note   = templates.connectionNote     ? personalizeTemplate(templates.connectionNote,     d) : '';

      // Sales Nav URL: delegate to the router — it handles Message-panel
      // detection and the "..." → Connect fallback inside one visit.
      if (SALES_NAV_URL_RE.test(page.url())) {
        const result = await sendViaSalesNav(page, {
          mode: 'force_connect_op_fallback',
          opSubject: opSubj,
          opBody: opBody,
          connectionNote: note,
        });
        if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
        if (result.ok && result.kind === 'connection_sent') return { action: 'connection_sent' };
        if (result.reason === 'unreachable')                return { action: 'skipped', error: 'Sales Nav: neither OP nor Connect available' };
        if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
        return { action: 'skipped', error: result.error || result.reason || 'Sales Nav unknown' };
      }

      // /in/ URL: try Sales Nav first (mirrors the SALES_NAV_URL_RE
      // short-circuit above). If the Sales Nav link is not resolvable from
      // the /in/ page, fall back to the direct /in/ Connect path — this is
      // a Connect campaign at heart and we should not skip entire rows just
      // because Sales Nav is unavailable.
      if (opBody) {
        const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
        if (salesNavUrl) {
          try {
            await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (e) {
            console.warn(`[outreach] Sales Nav navigation issue: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 5000));

          const result = await sendViaSalesNav(page, {
            mode: 'force_connect_op_fallback',
            opSubject: opSubj,
            opBody: opBody,
            connectionNote: note,
          });
          if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
          if (result.ok && result.kind === 'connection_sent') return { action: 'connection_sent' };
          if (result.reason === 'unreachable')                return { action: 'skipped', error: 'Sales Nav: neither OP nor Connect available' };
          if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
          return { action: 'skipped', error: result.error || result.reason || 'Sales Nav unknown' };
        }
        // Sales Nav URL not resolvable — fall through to /in/ Connect fallback below.
        console.warn('[outreach] Sales Nav link not available on /in/ page — falling back to direct Connect');
      }

      // Connect fallback (also the path when opBody is empty)
      status = await getConnectionStatus(page);
      if (status === 'message') return { action: 'skipped', error: 'Already connected' };
      if (status === 'pending') return { action: 'already_processed' };
      try {
        await sendConnectionRequest(page, note);
        return { action: 'connection_sent' };
      } catch (err) {
        return { action: 'skipped', error: `Connect failed: ${err.message}` };
      }
    } else {
      status = await getConnectionStatus(page);
    }

    const data = templates.data || {};

    switch (status) {
      case 'connect': {
        if (state.connectionSent) return { action: 'already_processed' };
        const note = templates.connectionNote ? personalizeTemplate(templates.connectionNote, data) : '';
        try {
          await sendConnectionRequest(page, note);
          return { action: 'connection_sent' };
        } catch (err) {
          return { action: 'skipped', error: `Connect failed: ${err.message}` };
        }
      }

      case 'message': {
        if (state.messageSent) return { action: 'already_processed' };
        if (!templates.followUpMessage) return { action: 'skipped', error: 'No message template' };
        try {
          await sendMessage(page, personalizeTemplate(templates.followUpMessage, data));
          return { action: 'message_sent' };
        } catch (err) {
          return { action: 'skipped', error: `Message failed: ${err.message}` };
        }
      }

      case 'follow': {
        console.log('[outreach] Follow → trying Connect via More…');
        try {
          const note = templates.connectionNote ? personalizeTemplate(templates.connectionNote, data) : '';
          await sendConnectionRequest(page, note);
          return { action: 'connection_sent' };
        } catch (e) {
          console.log(`[outreach] More Connect failed: ${e.message}`);
        }

        if (!templates.inmail?.subject && !templates.inmail?.message) {
          return { action: 'skipped', error: 'Connect not in More, no InMail template' };
        }
        try {
          const inmailResult = await sendInMail(page,
            personalizeTemplate(templates.inmail.subject || '', data),
            personalizeTemplate(templates.inmail.message || '', data));
          return { action: 'inmail_sent', creditsLeft: inmailResult?.creditsLeft ?? null };
        } catch (err) {
          return { action: 'skipped', error: `InMail failed: ${err.message}` };
        }
      }

      case 'pending':
        return { action: 'already_processed' };

      default: {
        console.log(`[outreach] Unknown → trying Connect via More…`);
        try {
          const note = templates.connectionNote ? personalizeTemplate(templates.connectionNote, data) : '';
          await sendConnectionRequest(page, note);
          return { action: 'connection_sent' };
        } catch (err) {
          return { action: 'skipped', error: `Unknown status, connect failed: ${err.message}` };
        }
      }
    }
  } catch (err) {
    return { action: 'skipped', error: `Outreach error: ${err.message}` };
  }
}
