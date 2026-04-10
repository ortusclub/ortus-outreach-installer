/**
 * LinkedIn actions — v18.
 *
 * CORE PRINCIPLE: Every click uses element.click() via page.evaluate().
 * NEVER page.mouse.click(x, y).
 *
 * This means:
 * - No coordinate calculations
 * - No viewport size dependencies
 * - No zoom dependencies
 * - Works whether element is visible, off-screen, or in Shadow DOM
 *
 * Shadow DOM buttons are reached via:
 *   document.getElementById('interop-outlet').shadowRoot.querySelector(...)
 */

import { randomDelay, clickByAria, clickByText } from './helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Detect modal — checks both regular DOM and Shadow DOM
// ─────────────────────────────────────────────────────────────────────────────

async function detectModal(page) {
  return page.evaluate(() => {
    // Collect buttons from regular DOM + ALL Shadow DOM roots
    const buttons = Array.from(document.querySelectorAll('button'));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) buttons.push(...Array.from(el.shadowRoot.querySelectorAll('button')));
    });

    const findByAria = (label) => buttons.find(b =>
      (b.getAttribute('aria-label') || '').toLowerCase() === label.toLowerCase()
    );
    const findByText = (text) => buttons.find(b =>
      b.textContent?.trim().toLowerCase() === text.toLowerCase()
    );

    const sendWithout = findByAria('Send without a note');
    const addNote = findByAria('Add a note');
    const send = findByAria('Send') || findByText('send') || findByText('send invitation');
    const withdraw = findByText('withdraw');

    // Gather all visible text (regular + all shadow DOMs)
    let pageText = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) pageText += (el.shadowRoot.textContent || '').substring(0, 3000).toLowerCase();
    });

    const hasHowDoYouKnow = pageText.includes('how do you know');

    // Weekly/invitation limit detection
    const hasWeeklyLimit = pageText.includes('weekly invitation limit') ||
                           pageText.includes("you've reached") ||
                           pageText.includes('invitation limit') ||
                           pageText.includes('too many pending');

    // Email required to connect
    const hasEmailRequired = pageText.includes('enter their email') ||
                             pageText.includes('verify this member knows you') ||
                             pageText.includes('email address to connect');

    const found = !!(sendWithout || addNote || send || withdraw || hasHowDoYouKnow || hasWeeklyLimit || hasEmailRequired);

    return {
      found,
      hasAddNote: !!addNote,
      hasSendWithout: !!sendWithout,
      hasSend: !!send,
      hasWithdraw: !!withdraw,
      hasHowDoYouKnow,
      hasWeeklyLimit,
      hasEmailRequired,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if Pending
// ─────────────────────────────────────────────────────────────────────────────

async function isPending(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) buttons.push(...Array.from(el.shadowRoot.querySelectorAll('button')));
    });
    return buttons.some(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return t === 'pending' || a.includes('pending');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Type into message/note field
// ─────────────────────────────────────────────────────────────────────────────

async function typeIntoField(page, text) {
  const focused = await page.evaluate(() => {
    const selectors = [
      'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]',
      '.msg-form__contenteditable', '[aria-label*="Write a message"]',
    ];

    // Regular DOM
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.focus(); el.click(); return true; }
    }

    // All Shadow DOM roots
    const shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot);
    for (const host of shadowHosts) {
      for (const sel of selectors) {
        const found = host.shadowRoot.querySelector(sel);
        if (found) { found.focus(); found.click(); return true; }
      }
    }
    return false;
  });

  if (!focused) return false;
  await randomDelay(200, 400);
  await page.keyboard.type(text, { delay: 30 });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Click Connect from More dropdown — ALL via JS click
// ─────────────────────────────────────────────────────────────────────────────

async function clickConnectFromMore(page) {
  console.log('[actions] Opening More dropdown…');

  // Step 1: Click the More button via JS
  const moreClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const more = buttons.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!moreClicked) {
    console.log('[actions] More button not found.');
    return false;
  }

  // Step 2: Wait 5 seconds for dropdown to fully render
  console.log('[actions] More clicked. Waiting 5s for dropdown…');
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Find and click "Connect" in dropdown via JS
  const connectClicked = await page.evaluate(() => {
    // Search dropdown items — look for exact "Connect" text
    const selectors = 'li, [role="menuitem"], [role="option"], .artdeco-dropdown__item';
    const items = Array.from(document.querySelectorAll(selectors));

    for (const el of items) {
      const text = (el.textContent || '').trim();
      if (text === 'Connect') {
        el.click();
        return 'dom';
      }
    }

    // Also try clicking a span/div with exact text "Connect" inside a dropdown
    const allEls = Array.from(document.querySelectorAll('span, div'));
    for (const el of allEls) {
      // Must be exact match and small element (not a big container)
      const text = (el.textContent || '').trim();
      const directText = el.childNodes.length <= 2 ? text : '';
      if (directText === 'Connect' && el.offsetWidth > 0) {
        // Click the list item parent if possible, otherwise the element itself
        const parent = el.closest('li') || el.closest('[role="menuitem"]') || el;
        parent.click();
        return 'dom-span';
      }
    }

    // Shadow DOM dropdown
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) {
      const shadowItems = Array.from(outlet.shadowRoot.querySelectorAll(selectors));
      for (const el of shadowItems) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect') {
          el.click();
          return 'shadow';
        }
      }
    }

    return null;
  });

  if (connectClicked) {
    console.log(`[actions] ✓ Connect clicked from dropdown (${connectClicked}).`);
    return true;
  }

  // Debug: log what IS in the dropdown
  const dropdownItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li, [role="menuitem"]'))
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length < 50)
      .slice(0, 10);
  });
  console.log('[actions] Dropdown items found:', JSON.stringify(dropdownItems));

  // Close dropdown
  await page.evaluate(() => document.body.click());
  console.log('[actions] Connect not in dropdown.');
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendConnectionRequest
// ═════════════════════════════════════════════════════════════════════════════

export async function sendConnectionRequest(page, note, { tryMoreFirst = false } = {}) {
  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(300, 500);

  let connectClicked = false;

  // PRIORITY 1: Always try the direct Connect button first
  // Only falls back to More dropdown if this returns null
  const directClicked = await page.evaluate(() => {
    // 1. aria-label "Invite X to connect" — works on both <a> and <button>
    const ariaConnect = document.querySelector('[aria-label*="Invite"][aria-label*="to connect"]');
    if (ariaConnect) { ariaConnect.click(); return 'aria-invite'; }

    // 2. Button or link with exact text "Connect" — primary action on profile page
    //    Check both regular DOM and Shadow DOM roots
    const allEls = Array.from(document.querySelectorAll('button, a'));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) allEls.push(...Array.from(el.shadowRoot.querySelectorAll('button, a')));
    });

    for (const el of allEls) {
      const text = (el.textContent || '').trim();
      if (text === 'Connect' && el.offsetWidth > 30) {
        el.click();
        return 'text-connect';
      }
    }

    return null;
  });

  if (directClicked) {
    console.log(`[actions] ✓ Direct Connect button clicked (${directClicked}).`);
    connectClicked = true;
    console.log('[actions] Waiting 5s for modal…');
    await new Promise(r => setTimeout(r, 5000));
  }

  // Only try More dropdown if direct button wasn't found
  if (!connectClicked) {
    console.log('[actions] No direct Connect → trying More dropdown…');
    connectClicked = await clickConnectFromMore(page);
    if (connectClicked) {
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (!connectClicked) throw new Error('Connect button not found');

  // ── Wait for modal or Pending (8 attempts = ~24s max, up from 5/15s) ──
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (await isPending(page)) {
      console.log('[actions] ✓ Connection sent directly.');
      return;
    }

    const modal = await detectModal(page);

    if (modal.found) {
      console.log(`[actions] Modal (attempt ${attempt}):`, JSON.stringify({
        addNote: modal.hasAddNote, sendWithout: modal.hasSendWithout,
        send: modal.hasSend, withdraw: modal.hasWithdraw,
      }));

      // Withdraw → already pending
      if (modal.hasWithdraw) {
        await clickByText(page, 'cancel');
        console.log('[actions] Already pending (withdraw).');
        return;
      }

      // Weekly/invitation limit → abort this profile
      if (modal.hasWeeklyLimit) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Got it').catch(() => {});
        throw new Error('WEEKLY_LIMIT');
      }

      // Email required to connect → skip this lead
      if (modal.hasEmailRequired) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Cancel').catch(() => {});
        throw new Error('EMAIL_REQUIRED');
      }

      // "How do you know"
      if (modal.hasHowDoYouKnow) {
        await clickByText(page, 'Other');
        await randomDelay(600, 1000);
        await clickByText(page, 'Connect');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // "Add a note" flow
      if (note && modal.hasAddNote) {
        console.log('[actions] Clicking "Add a note"…');
        await clickByAria(page, 'Add a note');
        await new Promise(r => setTimeout(r, 2000));
        await typeIntoField(page, note);
        console.log('[actions] Note typed.');
        await randomDelay(500, 800);
      }

      // ── Click Send — all via JS ──
      let sent = false;

      if (!sent && modal.hasSendWithout && !note) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" clicked (${r}).`); }
      }

      if (!sent && modal.hasSend) {
        const r = await clickByAria(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" clicked (${r}).`); }
      }

      if (!sent) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" fallback (${r}).`); }
      }

      if (!sent) {
        const r = await clickByText(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" by text (${r}).`); }
      }

      if (!sent) {
        // Last resort: click any primary button in modal that isn't "Add" or "Cancel"
        sent = await page.evaluate(() => {
          const allBtns = [];
          allBtns.push(...Array.from(document.querySelectorAll('button')));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) {
            allBtns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          }
          for (const b of allBtns) {
            const cls = b.className?.toLowerCase() || '';
            const text = b.textContent?.trim().toLowerCase() || '';
            if (cls.includes('primary') && !text.includes('add') && !text.includes('cancel') && !text.includes('follow')) {
              b.click();
              return true;
            }
          }
          return false;
        });
        if (sent) console.log('[actions] ✓ Primary button fallback clicked.');
      }

      if (!sent) {
        const allBtns = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) btns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          return btns.filter(b => b.offsetWidth > 0).map(b => ({
            text: b.textContent?.trim().substring(0, 30),
            aria: (b.getAttribute('aria-label') || '').substring(0, 40),
          }));
        });
        console.error('[actions] Send not found. Buttons:', JSON.stringify(allBtns.slice(0, 15)));
        throw new Error('Send button not found in modal');
      }

      await new Promise(r => setTimeout(r, 3000));
      if (await isPending(page)) console.log('[actions] ✓ Confirmed: Pending.');
      return;
    }

    if (attempt < 8) {
      console.log(`[actions] No modal yet (${attempt}/8), waiting 3s…`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Debug dump
  const btns = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button'));
    for (const root of getAllShadowRoots()) {
      all.push(...Array.from(root.querySelectorAll('button')));
    }
    function getAllShadowRoots() {
      const roots = [];
      const outlet = document.getElementById('interop-outlet');
      if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
      // Search all elements with shadow roots
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
      });
      return roots;
    }
    return all.filter(b => b.offsetWidth > 0).slice(0, 12).map(b => ({
      text: b.textContent?.trim().substring(0, 25),
      aria: (b.getAttribute('aria-label') || '').substring(0, 35),
      src: b.getRootNode() === document ? 'dom' : 'shadow',
    }));
  });
  console.error('[actions] No modal after 8 attempts. Buttons:', JSON.stringify(btns));
  throw new Error('No modal appeared and connection not sent');
}

// ═════════════════════════════════════════════════════════════════════════════
// sendMessage
// ═════════════════════════════════════════════════════════════════════════════

export async function sendMessage(page, message) {
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a')).find(b =>
      b.textContent?.trim().toLowerCase() === 'message' &&
      (b.getAttribute('aria-label') || '').toLowerCase().includes('message')
    );
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!clicked) throw new Error('Message button not found');

  await new Promise(r => setTimeout(r, 3000));

  for (const sel of ['.msg-overlay-conversation-bubble', '.msg-form', 'div[contenteditable="true"]']) {
    try { await page.waitForSelector(sel, { timeout: 5000 }); break; } catch { /* */ }
  }

  await randomDelay(400, 800);
  const typed = await typeIntoField(page, message);
  if (!typed) throw new Error('Could not type message');

  await randomDelay(500, 800);

  let sent = await clickByAria(page, 'Send');
  if (!sent) sent = await clickByText(page, 'Send');
  if (!sent) {
    sent = await page.evaluate(() => {
      const btn = document.querySelector('.msg-form__send-button, button[type="submit"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
  }
  if (!sent) throw new Error('Send button not found');

  console.log('[actions] ✓ Message sent.');
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label*="Close"]');
    if (close) close.click();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// sendInMail
// ═════════════════════════════════════════════════════════════════════════════

export async function sendInMail(page, subject, message) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.trim().includes('InMail')) ||
                btns.find(b => b.textContent?.trim() === 'Message');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) throw new Error('InMail button not found');

  await new Promise(r => setTimeout(r, 2500));

  if (subject) {
    for (const sel of ['input[name="subject"]', 'input[aria-label*="Subject"]']) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        await page.type(sel, subject, { delay: 30 });
        break;
      } catch { /* */ }
    }
  }

  await randomDelay(300, 600);
  await typeIntoField(page, message);

  await randomDelay(500, 800);
  let sent = await clickByAria(page, 'Send');
  if (!sent) sent = await clickByText(page, 'Send');
  if (!sent) throw new Error('InMail Send not found');

  console.log('[actions] ✓ InMail sent.');
  await new Promise(r => setTimeout(r, 2000));
}
