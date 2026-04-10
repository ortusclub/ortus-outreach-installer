/**
 * Per-target outreach — v19.
 *
 * For each lead:
 *   1. Open lead's LinkedIn profile
 *   2. Smart wait: networkidle + MutationObserver settling (5-15s vs old 30s)
 *   3. No zoom, no viewport change — keep 1366x900 (matches physical window)
 *   4. Execute action via JS click (works regardless of element visibility)
 */

import { randomDelay, getConnectionStatus, personalizeTemplate } from './helpers.js';
import { sendConnectionRequest, sendMessage, sendInMail } from './actions.js';

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

    // ── Step 1: Navigate to lead's profile ──
    // Use networkidle0 — waits until no network requests for 500ms
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
      // Fallback: if networkidle0 times out, the page is still usable
      console.log(`[outreach] networkidle0 timed out, continuing: ${e.message}`);
    }

    // ── Step 2: Smart wait — DOM settles when mutations stop for 1.5s ──
    console.log('[outreach] Waiting for DOM to settle…');
    await waitForDomSettle(page, { settleMs: 1500, maxWait: 15000 });
    // Small buffer for late-loading elements (LinkedIn lazy renders some cards)
    await new Promise(r => setTimeout(r, 2000));
    console.log('[outreach] DOM settled.');

    // ── Step 2a: Zoom to 75% so all action buttons are visible ──
    await page.evaluate(() => { document.body.style.zoom = '75%'; });

    // ── Step 2b: Human-like browsing — scroll profile and dwell ──
    // Mimics how a real person reads a profile before acting
    const scrollPercent = 30 + Math.floor(Math.random() * 40); // 30-70%
    await page.evaluate((pct) => {
      const maxScroll = document.body.scrollHeight - window.innerHeight;
      window.scrollTo({ top: maxScroll * (pct / 100), behavior: 'smooth' });
    }, scrollPercent);
    const dwellTime = 5000 + Math.floor(Math.random() * 5000); // 5-10s
    console.log(`[outreach] Browsing profile (scrolled ${scrollPercent}%, dwelling ${(dwellTime / 1000).toFixed(0)}s)…`);
    await new Promise(r => setTimeout(r, dwellTime));

    // Scroll back to top for action buttons
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await new Promise(r => setTimeout(r, 1000));

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
    let status;

    if (modeHint === 'check_only') {
      // Just read the status — don't click anything
      status = await getConnectionStatus(page);
      console.log(`[outreach] Check status: ${status}`);
      if (status === 'message') return { action: 'status_accepted' };
      if (status === 'pending') return { action: 'status_pending' };
      if (status === 'connect' || status === 'follow') return { action: 'status_declined' };
      return { action: 'status_unknown', error: `Status: ${status}` };
    } else if (modeHint === 'force_connect') {
      status = await getConnectionStatus(page);
      if (status === 'message') return { action: 'skipped', error: 'Already connected' };
      if (status === 'pending') return { action: 'already_processed' };
      if (status !== 'connect') {
        console.log(`[outreach] Status="${status}", will try Connect (retry loop handles More fallback)`);
        status = 'connect';
      }
    } else if (modeHint === 'force_message') {
      status = await getConnectionStatus(page);
      if (status === 'connect') return { action: 'skipped', error: 'Not yet connected' };
      if (status === 'pending') return { action: 'skipped', error: 'Still pending' };
      status = 'message';
    } else if (modeHint === 'force_inmail') {
      status = await getConnectionStatus(page);
      if (status === 'connect') return { action: 'skipped', error: 'Can connect directly' };
      if (status === 'message') return { action: 'skipped', error: 'Already connected' };
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
          await sendInMail(page,
            personalizeTemplate(templates.inmail.subject || '', data),
            personalizeTemplate(templates.inmail.message || '', data));
          return { action: 'inmail_sent' };
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
