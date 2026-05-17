/**
 * Per-target outreach — v19.
 *
 * For each lead:
 *   1. Open lead's LinkedIn profile
 *   2. Smart wait: networkidle + MutationObserver settling (5-15s vs old 30s)
 *   3. No zoom, no viewport change — keep 1366x900 (matches physical window)
 *   4. Execute action via JS click (works regardless of element visibility)
 */

import { randomDelay, getConnectionStatus, getVoyagerDegree, getDegreeBadge, personalizeTemplate } from './helpers.js';
import { sendConnectionRequest, sendMessage, sendIntroMessage, sendInMail, sendViaSalesNav, resolveSalesNavUrlFromInProfile } from './actions.js';
import { dataPath } from '../paths.js';
import { mkdir, writeFile } from 'node:fs/promises';

// 2.8.42: HTML-only diagnostic, capped per process. The 2.8.41 version
// took a screenshot, which on macOS Chromium can pop the GoLogin window
// to the foreground every fire — and for accounts where Voyager fails on
// every lead, the diagnostic fires on every lead. Both are gone now:
// no screenshot, and a 3-dump-per-process cap so a broken session can't
// flood disk or stall the campaign.
let _diagnosticBudget = 3;
async function dumpBadgeDiagnostic(page, publicId, reason) {
  if (_diagnosticBudget <= 0) return;
  _diagnosticBudget--;
  try {
    const dir = dataPath('diagnostics');
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeId = (publicId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
    const base = `${dir}/${safeId}-${ts}`;

    // Capture <main> outerHTML — the profile header lives inside main, and
    // capping at 300KB keeps the file small enough to read quickly.
    const html = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return (main?.outerHTML || '').substring(0, 300000);
    });
    const url = page.url();
    const header = [
      `<!-- diagnostic dump: ${reason} -->`,
      `<!-- url: ${url} -->`,
      `<!-- timestamp: ${new Date().toISOString()} -->`,
      '',
    ].join('\n');
    await writeFile(`${base}.html`, header + html);

    console.log(`[outreach] Diagnostic dumped → ${base}.html (${_diagnosticBudget} remaining this run)`);
  } catch (err) {
    console.warn(`[outreach] Diagnostic dump failed: ${err.message}`);
  }
}

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

// v2.11.1: legacy Sales Nav profile URLs use a numeric LinkedIn member id
// (`/sales/profile/2803628,rZnG,NAME_SEARCH`) instead of the AC-encoded URN.
// These can't be mechanically converted to /in/ without scraping the page
// itself, so for Connect / Message / Check Status modes we skip them with a
// clear reason. OP and InMail modes are NOT affected — Sales Nav handles the
// /sales/profile/ form natively for those flows.
const LEGACY_SALES_NAV_RE = /\/sales\/profile\//;

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
    // 2.8.37: force HTTPS. Sheets often have legacy http:// LinkedIn URLs;
    // Chromium in automation mode shows a "site doesn't support secure
    // connection" interstitial for http:// linkedin.com instead of upgrading.
    if (url.startsWith('http://')) url = 'https://' + url.slice(7);

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

    // ── URL transform: /sales/lead/{memberId} → /in/{memberId} for Connect / Message / Check ──
    // Sales Nav pages don't expose the Connect button the same way /in/ pages
    // do, and the /in/-shaped status check false-positives "already connected"
    // on Sales Nav DOM → lead gets skipped. For connection campaigns, reverse
    // the transform: extract the URN and rebuild as /in/{urn}.
    // 2.8.36: also for force_message — sendMessage parses publicId from
    // /in/<id> in the URL, so a Sales Nav URL would throw "could not parse
    // publicId" without this rewrite.
    // 2.8.39: also for check_only — Voyager's /voyager/api/.../profiles/<id>
    // endpoint requires the /in/ URL format. Without the rewrite, every Sales
    // Nav row in Check Status gets skipped instead of evaluated, leaving its
    // CC stuck at the previous (potentially wrong) state.
    if (modeHint === 'force_connect' || modeHint === 'force_message' || modeHint === 'check_only') {
      // v2.11.1: legacy /sales/profile/<numeric>,xxx,NAME_SEARCH has no encoded
      // URN to extract — the bot would navigate, find the Sales Nav layout,
      // and skip with a misleading "Connect button not found". Skip up-front
      // with a clear reason so the operator can re-export with a vanity slug.
      if (LEGACY_SALES_NAV_RE.test(url)) {
        console.warn('[outreach] Legacy Sales Nav profile URL — cannot route to /in/');
        return { action: 'skipped', error: 'Legacy Sales Nav URL — re-export with vanity slug or AC URN' };
      }
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
    // 2.8.29 perf: check_only used domcontentloaded (not networkidle0) — the
    // Voyager API only needs the URL pathname + cookies, both available as
    // soon as the document parses. networkidle0 waits for LinkedIn's polling
    // to stop and routinely costs 10-20s of dead time.
    //
    // v2.14.x: send paths ALSO switch to domcontentloaded. In background-
    // throttled tabs (the operator's default mode — 99% of campaigns run
    // with the Electron window backgrounded), LinkedIn's chat-polling /
    // realtime-updates XHRs never go idle, so networkidle0 was timing out
    // at 30s on every navigation. The subsequent `waitForDomSettle` +
    // explicit 2s buffer (Step 2 below) covers the rendered-action-buttons
    // wait that networkidle0 used to provide. Net: 30s dead time → ~3.5s
    // settle.
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      console.log(`[outreach] domcontentloaded timed out, continuing: ${e.message}`);
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
      // 2.8.40: per user directive, ONLY the "1st"/"2nd"/"3rd" badge near
      // the profile name decides connection state. No Message-button
      // fallback, no Pending-button fallback, no other heuristic.
      //
      // Voyager's distance.value is the SAME data source LinkedIn uses to
      // render that badge (DISTANCE_1 ↔ "1st", DISTANCE_2 ↔ "2nd",
      // DISTANCE_3 ↔ "3rd"), just accessed via API instead of DOM. So
      // Voyager IS the badge, not a fallback. Try API first (faster, no
      // DOM-render race); fall back to reading the badge from the DOM only
      // if Voyager fails.
      //
      // Outcomes are exhaustive — there is no "skipped" or "unknown":
      //   1st          → status_accepted (green, Y kept)
      //   2nd / 3rd / not found → status_pending (yellow, Y stripped)
      if (voyagerDegree === 1) {
        console.log('[outreach] Voyager: DISTANCE_1 → 1st badge → accepted');
        return { action: 'status_accepted' };
      }
      if (voyagerDegree === 2 || voyagerDegree === 3) {
        console.log(`[outreach] Voyager: DISTANCE_${voyagerDegree} → not 1st → pending`);
        return { action: 'status_pending' };
      }

      // Voyager API failed. Read the badge from the DOM directly.
      await waitForDomSettle(page, { settleMs: 1500, maxWait: 10000 });
      const badge = await getDegreeBadge(page);
      if (badge === '1st') {
        console.log('[outreach] DOM badge: 1st → accepted');
        return { action: 'status_accepted' };
      }
      // 2.8.41: when badge detection fails, capture the DOM + a screenshot
      // so we can write selectors against ground truth instead of guesses.
      // Fires when Voyager null AND DOM didn't return a recognizable badge.
      if (badge === null) {
        const publicId = page.url().match(/\/in\/([^/?#]+)/)?.[1] || null;
        await dumpBadgeDiagnostic(page, publicId, 'Voyager null + getDegreeBadge null');
      }
      console.log(`[outreach] DOM badge: ${badge ?? 'not found'} → pending`);
      return { action: 'status_pending' };
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
      if (result.reason === 'inmail_no_credits_lead_not_op') return { action: 'skipped', error: 'INMAIL_NO_CREDITS_NOT_OP: account has 0 InMail credits and lead is not Open Profile' };
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
      if (result.reason === 'inmail_no_credits_lead_not_op') return { action: 'skipped', error: 'INMAIL_NO_CREDITS_NOT_OP: account has 0 InMail credits and lead is not Open Profile' };
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
        const r = await sendConnectionRequest(page, note);
        return { action: 'connection_sent', invitationUrn: r?.invitationUrn || null };
      } catch (err) {
        // v2.14.x: actions.js detected the lead's invitation is already
        // Pending via the profile More dropdown (e.g. Pravin Bisen 2026-05-15).
        // Treat as already_processed so the row gets stamped Connect Pending.
        if (String(err.message).includes('INVITATION_ALREADY_PENDING')) {
          return { action: 'already_processed' };
        }
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
          const r = await sendConnectionRequest(page, note);
          return { action: 'connection_sent', invitationUrn: r?.invitationUrn || null };
        } catch (err) {
          if (String(err.message).includes('INVITATION_ALREADY_PENDING')) {
            return { action: 'already_processed' };
          }
          return { action: 'skipped', error: `Connect failed: ${err.message}` };
        }
      }

      case 'message': {
        if (state.messageSent) return { action: 'already_processed' };
        if (!templates.followUpMessage) return { action: 'skipped', error: 'No message template' };
        try {
          // 2.8.50: Introduction Messages — when introMode is true, route to
          // the 3-way group flow (add intro person, set group title, send body).
          // Body placeholder substitution gets {intro name} on top of the
          // existing data fields.
          if (templates.introMode) {
            if (!templates.introName) {
              return { action: 'skipped', error: 'No intro person configured (introMode on but introName empty)' };
            }
            // v2.11.6: split introName into first/last on whitespace so
            // operators can write more natural copy ("Hi {first name}, meet
            // {intro first name}…"). Single-token input → first set, last
            // empty (operator should adapt the template). Multi-token input
            // → first token is first name, everything after is the last
            // name (handles "Samuel Adcock Jr." → first="Samuel",
            // last="Adcock Jr." correctly).
            const introTokens = templates.introName.trim().split(/\s+/);
            const introFirst = introTokens[0] || '';
            const introLast  = introTokens.slice(1).join(' ');
            const introData = {
              ...data,
              // Full name — back-compat, unchanged behaviour.
              'intro name': templates.introName,
              'introName': templates.introName,
              'intro_name': templates.introName,
              // New split placeholders (all naming variants accepted).
              'intro first name': introFirst,
              'introFirstName': introFirst,
              'intro_first_name': introFirst,
              'intro last name': introLast,
              'introLastName': introLast,
              'intro_last_name': introLast,
            };
            const body  = personalizeTemplate(templates.followUpMessage, introData);
            const title = personalizeTemplate(templates.introTitle || 'Introduction: {first name} <> {intro name}', introData);
            // v2.14.x: CC+IC and IB call sendIntroMessage with the SAME
            // arguments — typeahead-for-primary path. The previous
            // URL-routing experiment (passing templates.introUrl as 5th
            // arg) failed because LinkedIn's compose URL parser is
            // last-wins for repeated ?recipient= params, so the lead's
            // pill was silently dropped. The secondRecipientUrl param on
            // sendIntroMessage now has no caller (dead code, harmless).
            await sendIntroMessage(page, body, templates.introName, title);
          } else {
            await sendMessage(page, personalizeTemplate(templates.followUpMessage, data));
          }
          return { action: 'message_sent' };
        } catch (err) {
          return { action: 'skipped', error: `Message failed: ${err.message}` };
        }
      }

      case 'follow': {
        console.log('[outreach] Follow → trying Connect via More…');
        try {
          const note = templates.connectionNote ? personalizeTemplate(templates.connectionNote, data) : '';
          const r = await sendConnectionRequest(page, note);
          return { action: 'connection_sent', invitationUrn: r?.invitationUrn || null };
        } catch (e) {
          if (String(e.message).includes('INVITATION_ALREADY_PENDING')) {
            return { action: 'already_processed' };
          }
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
          const r = await sendConnectionRequest(page, note);
          return { action: 'connection_sent', invitationUrn: r?.invitationUrn || null };
        } catch (err) {
          if (String(err.message).includes('INVITATION_ALREADY_PENDING')) {
            return { action: 'already_processed' };
          }
          return { action: 'skipped', error: `Unknown status, connect failed: ${err.message}` };
        }
      }
    }
  } catch (err) {
    return { action: 'skipped', error: `Outreach error: ${err.message}` };
  }
}
