/**
 * Per-target outreach — v18.
 *
 * For each lead:
 *   1. Open lead's LinkedIn profile
 *   2. Wait 30 seconds for page to fully load
 *   3. No zoom, no viewport change — keep 1366x900 (matches physical window)
 *   4. Execute action via JS click (works regardless of element visibility)
 */

import { randomDelay, getConnectionStatus, personalizeTemplate } from './helpers.js';
import { sendConnectionRequest, sendMessage, sendInMail } from './actions.js';

export async function performOutreach(page, targetUrl, templates, state = {}, modeHint = null) {
  try {
    let url = targetUrl.trim();
    if (!url.startsWith('http')) url = 'https://' + url;

    // ── Step 1: Navigate to lead's profile ──
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ── Step 2: Wait 30 seconds for page to fully load ──
    console.log('[outreach] Waiting 30s for page to load…');
    await new Promise(r => setTimeout(r, 30000));

    // Scroll to top
    await page.evaluate(() => window.scrollTo(0, 0));

    // Check for login/404
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      return { action: 'skipped', error: 'Login page detected' };
    }
    if (currentUrl.includes('/404') || currentUrl.includes('unavailable')) {
      return { action: 'skipped', error: 'Profile not found' };
    }

    // ── Step 3: Detect status and execute action ──
    let status;
    let connectViaMore = false;

    if (modeHint === 'force_connect') {
      status = await getConnectionStatus(page);
      if (status === 'message') return { action: 'skipped', error: 'Already connected' };
      if (status === 'pending') return { action: 'already_processed' };
      if (status !== 'connect') {
        console.log(`[outreach] Status="${status}", will try More dropdown`);
        status = 'connect';
        connectViaMore = true;
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
          await sendConnectionRequest(page, note, { tryMoreFirst: connectViaMore });
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
          await sendConnectionRequest(page, note, { tryMoreFirst: true });
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
          await sendConnectionRequest(page, note, { tryMoreFirst: true });
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
