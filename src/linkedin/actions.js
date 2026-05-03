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

// Matches Sales Navigator profile URLs (/sales/people/… or /sales/lead/…).
// Kept in sync with the identical constant in outreach.js — duplication here
// is deliberate (avoids cross-coupling the two files for a 1-line regex).
const SALES_NAV_URL_RE = /\/sales\/(people|lead)\//;

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

    const sendWithout = findByAria('Send without a note') || findByText('Send without a note');
    const addNote = findByAria('Add a note') || findByText('Add a note');
    const send = findByAria('Send') || findByText('Send') || findByText('send invitation');
    const withdraw = findByText('withdraw');

    // Gather all visible text (regular + all shadow DOMs)
    let pageText = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) pageText += (el.shadowRoot.textContent || '').substring(0, 3000).toLowerCase();
    });

    const hasHowDoYouKnow = pageText.includes('how do you know');

    // Weekly/invitation limit detection — matches both modal text and inline banner text
    // Banner says: "weekly limit for connection invitations"
    // Modal says: "weekly invitation limit"
    const hasWeeklyLimit = pageText.includes('weekly invitation limit') ||
                           pageText.includes('weekly limit for connection') ||
                           pageText.includes('invitation was not sent') ||
                           pageText.includes("you've reached") ||
                           pageText.includes('reached the weekly limit') ||
                           pageText.includes('invitation limit') ||
                           pageText.includes('too many pending') ||
                           pageText.includes('try again next week');

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
  // Step 1: Check for Pending as a visible button in the profile's action bar
  // ONLY check buttons and actionable elements — NOT divs/spans (too many false positives)
  const directPending = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
    const firstName = profileName.split(/\s+/)[0] || '';

    // Find the "More" button to locate the action bar
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });

    // Scope: only check buttons in the action bar area (same parent as More button)
    const actionBar = moreBtn ? (moreBtn.closest('div, section, ul') || moreBtn.parentElement) : null;
    const searchAreas = actionBar ? [actionBar] : [];
    // Also check the h1's parent section
    if (h1) {
      const h1Section = h1.closest('main, section, [class*="top-card"]');
      if (h1Section && !searchAreas.includes(h1Section)) searchAreas.push(h1Section);
    }

    for (const area of searchAreas) {
      const buttons = Array.from(area.querySelectorAll('button, a, [role="button"]'));
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        const a = (b.getAttribute('aria-label') || '').toLowerCase();

        if (a.includes('pending')) {
          if (firstName && !a.includes(firstName)) continue;
          return 'aria-scoped';
        }
        if (t === 'pending' && b.offsetWidth > 0) {
          return 'text-scoped';
        }
      }
    }
    return null;
  });

  if (directPending) return true;

  // Step 2: Open the "More" dropdown and check for "Pending" inside it
  const morePending = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const more = buttons.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!morePending) return false;

  await new Promise(r => setTimeout(r, 2000));

  const pendingInDropdown = await page.evaluate(() => {
    // Only check dropdown-specific elements
    const items = Array.from(document.querySelectorAll('li, [role="menuitem"], .artdeco-dropdown__item'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'pending') return true;
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      if (a.includes('pending')) return true;
    }
    return false;
  });

  // Close the dropdown
  await page.evaluate(() => document.body.click());
  await new Promise(r => setTimeout(r, 500));

  return pendingInDropdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type into message/note field
// ─────────────────────────────────────────────────────────────────────────────

async function typeIntoField(page, text) {
  // Order matters: most-specific message/note selectors first. Otherwise the
  // generic `div[contenteditable="true"]` can match LinkedIn's top-nav search
  // bar (also contenteditable) and silently type into it.
  // For message composers specifically, if multiple are present we take the
  // LAST one (most recently mounted) — LinkedIn appends new bubbles to the
  // end of `.msg-overlay-list-bubble`, and the most recent is the current lead.
  const SELECTORS = [
    // Connect-note modal
    'textarea[name="message"]', 'textarea#custom-message',
    // Message composer (Quill editor) — scoped to the form container
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
    'div[aria-label*="Add a note"]',
    // InMail / other dialogs
    'div[role="dialog"] textarea',
    'div[role="dialog"] div[contenteditable="true"]',
    // Generic textarea fallback
    'textarea',
  ];
  // Selectors for which we should pick the LAST match (most recently mounted).
  const PICK_LAST_SELECTORS = new Set([
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
  ]);

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Inject value directly using React's native setter so the synthetic
    // onChange fires and LinkedIn's controlled component accepts it.
    const injected = await page.evaluate((selectors, pickLastSelectors, value) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };

      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) return { ok: false, reason: 'field-not-found' };

      el.focus();

      const isTextarea = el.tagName === 'TEXTAREA';
      const isInput = el.tagName === 'INPUT';

      if (isTextarea || isInput) {
        const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable path — LinkedIn's message composer is a Quill
        // editor. Quill maintains its own document model and listens for
        // `paste` events via its Clipboard module, so dispatching a real
        // ClipboardEvent with a DataTransfer is the most reliable way to
        // populate it.
        // 2.8.34: trust the paste; the outer post-400ms verification
        // re-tries on mismatch. The previous synchronous lengthRatio check
        // raced Quill's async render and forced an execCommand fallback that
        // overwrote the in-flight paste, leaving a malformed editor.
        el.focus();
        // Select + delete any existing content
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        } catch { /* */ }

        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(pasteEvent);
        } catch { /* */ }

        // 2.8.45: dispatch InputEvent so React's onChange fires. Without this,
        // LinkedIn's React state thinks the composer is empty and keeps the
        // Send button disabled even though the text is visible. Mirrors what
        // the LinkedIn DM Assistant extension does after paste.
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertText',
            data: value,
          }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { /* */ }
      }

      const got = isTextarea || isInput ? el.value : (el.textContent || el.innerText || '');
      return { ok: true, got };
    }, SELECTORS, [...PICK_LAST_SELECTORS], text);

    if (!injected.ok) {
      console.warn(`[actions] Field not found on attempt ${attempt}: ${injected.reason}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    await new Promise(r => setTimeout(r, 400));

    // Read back authoritative content after React re-render
    const fieldContent = await page.evaluate((selectors, pickLastSelectors) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };
      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      // 2.8.35: prefer innerText over textContent for contenteditable. Quill
      // renders multi-line as <p>line</p><p>line</p>; textContent strips the
      // tags AND the implicit newlines between blocks ("line1line2"), but
      // innerText respects block layout and emits "line1\nline2". Without
      // this the verification below fails on every multi-line template,
      // returning false and leaving the message un-sent in the composer.
      return el.innerText || el.textContent || '';
    }, SELECTORS, [...PICK_LAST_SELECTORS]);

    // Verification: strict equality for textareas (connect-note modal),
    // whitespace-normalized match for contenteditable (Quill message composer,
    // which wraps content in <p> tags and collapses newlines in textContent).
    const expected = text.replace(/\r\n/g, '\n');
    const got = fieldContent.replace(/\r\n/g, '\n');
    const normalize = s => s.replace(/\s+/g, ' ').trim();
    // 2.8.35: third compare — strip ALL whitespace. Belt-and-suspenders for
    // edge cases where Quill emits a different whitespace pattern than the
    // template (e.g. drops a blank line between paragraphs).
    const stripWs = s => s.replace(/\s+/g, '');

    if (
      got === expected ||
      normalize(got) === normalize(expected) ||
      stripWs(got) === stripWs(expected)
    ) {
      if (attempt > 1) console.log(`[actions] Note verified on attempt ${attempt}.`);
      return true;
    }

    console.warn(
      `[actions] Note mismatch (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
      `Expected ${expected.length} chars, got ${got.length}. ` +
      `Expected head: "${expected.substring(0, 60)}…" Got head: "${got.substring(0, 60)}…"`
    );

    // 2.8.34: keyboard.type fallback removed. Prior runs showed the typing
    // path producing visible mistakes (Quill mid-render fights with synthetic
    // keystrokes). Paste-only is safer: if all paste attempts fail, return
    // false and let the caller surface the error rather than typing.
  }

  console.error('[actions] Failed to type note correctly after all attempts. Will NOT send.');
  return false;
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

    // Try spans inside the actual dropdown container only
    const dropdowns = document.querySelectorAll('.artdeco-dropdown__content, [role="menu"], .artdeco-dropdown__content--is-open');
    for (const dropdown of dropdowns) {
      if (!dropdown.offsetWidth) continue; // skip hidden dropdowns
      const spans = dropdown.querySelectorAll('span, div, a');
      for (const el of spans) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect' && el.offsetWidth > 0) {
          const parent = el.closest('li') || el.closest('[role="menuitem"]') || el;
          parent.click();
          return 'dropdown-connect';
        }
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

export async function sendConnectionRequest(page, noteArg) {
  let note = noteArg;
  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(300, 500);

  let connectClicked = false;

  // Retry loop: keep looking for Connect button for up to 30 seconds
  // Accounts for slow page loads and lazy-rendered elements
  const MAX_WAIT_MS = 30000;
  const POLL_INTERVAL_MS = 3000;
  const startTime = Date.now();

  while (!connectClicked && (Date.now() - startTime) < MAX_WAIT_MS) {
    const directClicked = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
      const firstName = profileName.split(/\s+/)[0] || '';

      // METHOD 1: aria-label "Invite [name] to connect" — name MUST match
      if (firstName) {
        const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
        for (const el of allInvites) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes(firstName)) {
            el.click();
            return 'aria-invite-matched';
          }
        }
      }

      // METHOD 2: <a href="...custom-invite..."> link — unique to profile owner
      const allLinks = Array.from(document.querySelectorAll('a'));
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) allLinks.push(...Array.from(el.shadowRoot.querySelectorAll('a')));
      });
      for (const el of allLinks) {
        const href = (el.getAttribute('href') || '');
        if (href.includes('custom-invite')) {
          el.click();
          return 'custom-invite-link';
        }
      }

      // NO OTHER FALLBACKS — if neither matched, go to More dropdown
      return null;
    });

    if (directClicked) {
      console.log(`[actions] ✓ Direct Connect button clicked (${directClicked}).`);
      connectClicked = true;
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }

    // PRIORITY 2: Only try More dropdown if direct button wasn't found
    console.log(`[actions] No direct Connect — trying More dropdown… (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    connectClicked = await clickConnectFromMore(page);
    if (connectClicked) {
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }

    // Neither found — wait and retry
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[actions] Connect not found yet (${elapsed}s / 60s). Retrying in 5s…`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!connectClicked) throw new Error('Connect button not found after 60s');

  // ── Wait for modal, success toast, or Pending (8 attempts = ~24s max) ──
  for (let attempt = 1; attempt <= 8; attempt++) {
    // Check for "Invitation sent to X" green toast — definitive proof
    const successToast = await page.evaluate(() => {
      const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
      for (const t of toasts) {
        const text = (t.textContent || '').toLowerCase();
        if (text.includes('invitation sent')) return text.trim().substring(0, 100);
      }
      return null;
    });
    if (successToast) {
      console.log(`[actions] ✓ Success toast: "${successToast}"`);
      return;
    }

    // IMPORTANT: Check modal FIRST — if a modal is open, we MUST handle it.
    // Do NOT check isPending before modal, because isPending can false-positive
    // from recommendation Pending buttons while the modal is still open.
    const modal = await detectModal(page);
    if (modal.found) {
      // Modal is open — handle it below (fall through to modal handling code)
    } else {
      // No modal — safe to check Pending
      if (await isPending(page)) {
        console.log('[actions] ✓ Connection sent (Pending detected).');
        return;
      }
    }

    // Check for inline weekly limit banner (appears instead of modal)
    const inlineBanner = await page.evaluate(() => {
      const text = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
      if (text.includes('invitation was not sent') ||
          text.includes('weekly limit for connection') ||
          text.includes('reached the weekly limit') ||
          text.includes('try again next week')) {
        return true;
      }
      let shadowText = '';
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) shadowText += (el.shadowRoot.textContent || '').substring(0, 2000).toLowerCase();
      });
      return shadowText.includes('invitation was not sent') ||
             shadowText.includes('weekly limit') ||
             shadowText.includes('try again next week');
    });
    if (inlineBanner) {
      console.log('[actions] ⚠ Inline weekly limit banner detected on page.');
      throw new Error('WEEKLY_LIMIT');
    }

    // modal was already detected above — reuse it
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
        await new Promise(r => setTimeout(r, 5000));
        const noteTyped = await typeIntoField(page, note);
        if (!noteTyped) {
          console.warn('[actions] Note typing failed after 3 attempts. Clearing field and sending without a note.');
          // Clear any half-typed content so it can't possibly leak
          await page.evaluate(() => {
            const sels = ['textarea[name="message"]', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'];
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.innerHTML = '';
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                return;
              }
            }
          });
          await new Promise(r => setTimeout(r, 300));

          // Dismiss the entire invite modal (Cancel button in the Add-a-note view
          // closes the whole flow on current LinkedIn)
          await clickByText(page, 'Cancel').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          await new Promise(r => setTimeout(r, 1500));

          // Re-click Connect from scratch — reuses the same direct-click logic
          // as the top of this function
          const reconnected = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
            const firstName = profileName.split(/\s+/)[0] || '';
            if (firstName) {
              const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
              for (const el of allInvites) {
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes(firstName)) { el.click(); return 'aria'; }
              }
            }
            return null;
          });

          if (!reconnected) {
            // Fall back to More dropdown
            const moreOk = await clickConnectFromMore(page);
            if (!moreOk) {
              console.error('[actions] Could not re-open Connect after note failure. Aborting.');
              throw new Error('NOTE_TYPING_FAILED: could not re-open Connect to send without a note');
            }
          }

          await new Promise(r => setTimeout(r, 5000));

          // Now the fresh invite modal is showing; click "Send without a note"
          note = '';
          const sentR = await clickByAria(page, 'Send without a note');
          if (!sentR) {
            // Some modals label it just "Send"
            const sendR = await clickByAria(page, 'Send');
            if (!sendR) {
              const byText = await clickByText(page, 'Send without a note');
              if (!byText) {
                console.error('[actions] Fresh invite modal did not expose Send-without-note button.');
                throw new Error('NOTE_TYPING_FAILED: fresh invite modal missing Send-without-note');
              }
            }
          }
          console.log('[actions] ✓ Sent without a note (note typing fallback).');
          // Jump straight to post-send verification
          await new Promise(r => setTimeout(r, 2000));

          // Post-send verification: reload profile and confirm Pending
          console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
          await new Promise(r => setTimeout(r, 30000));
          const currentUrl = page.url();
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* timeout OK */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send).');
            return;
          }
          console.log('[actions] Not Pending yet. Waiting another 30s...');
          await new Promise(r => setTimeout(r, 30000));
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send, 2nd check).');
            return;
          }
          throw new Error('SEND_NOT_CONFIRMED: fallback send without note did not land as Pending');
        }
        console.log('[actions] Note typed and verified.');
        await new Promise(r => setTimeout(r, 5000));
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

      // ── Immediate toast check — success or error ──
      await new Promise(r => setTimeout(r, 2000));

      // Check for success toast first: "Invitation sent to X"
      const sentToast = await page.evaluate(() => {
        const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
        for (const t of toasts) {
          const text = (t.textContent || '').toLowerCase();
          if (text.includes('invitation sent')) return text.trim().substring(0, 100);
        }
        return null;
      });
      if (sentToast) {
        console.log(`[actions] ✓ Verified via toast: "${sentToast}"`);
        return;
      }
      const errorToast = await page.evaluate(() => {
        const toast = document.querySelector(
          'div[data-test-artdeco-toast-item-type="error"], ' +
          '.artdeco-toast-item--error, ' +
          'li-icon[type="error"]'
        );
        if (toast) {
          const container = toast.closest('.artdeco-toast-item') || toast.parentElement;
          return (container?.textContent || toast.textContent || '').trim().substring(0, 200);
        }
        // Also check all Shadow DOM roots
        const roots = [];
        document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
        for (const root of roots) {
          const sToast = root.querySelector(
            'div[data-test-artdeco-toast-item-type="error"], .artdeco-toast-item--error'
          );
          if (sToast) {
            const container = sToast.closest('.artdeco-toast-item') || sToast.parentElement;
            return (container?.textContent || sToast.textContent || '').trim().substring(0, 200);
          }
        }
        return null;
      });
      if (errorToast) {
        console.error(`[actions] ⚠ LinkedIn error toast after send: "${errorToast}"`);
        throw new Error(`LINKEDIN_ERROR_TOAST: ${errorToast}`);
      }

      // Post-send verification: reload the profile and confirm Pending status
      // Wait for modal to fully close and LinkedIn to process the request
      console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
      await new Promise(r => setTimeout(r, 30000));

      // Navigate back to the same profile to get fresh status
      const currentUrl = page.url();
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK — page still usable */ }
      await new Promise(r => setTimeout(r, 5000));
      // Reapply zoom after reload so button positions match expectations
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      // Check 1: is it Pending now?
      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending.');
        return;
      }

      // Wait another 30s and try again — GoLogin is slow
      console.log('[actions] Not Pending yet. Waiting another 30s...');
      await new Promise(r => setTimeout(r, 30000));

      // Reload again for fresh state
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK */ }
      await new Promise(r => setTimeout(r, 5000));
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      // Check 2
      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending (2nd check).');
        return;
      }

      // Not confirmed — LinkedIn silently dropped the request
      console.warn('[actions] ⚠ Send clicked but Pending NOT confirmed after 60s + 2 page reloads.');
      throw new Error('SEND_NOT_CONFIRMED: clicked Send but profile does not show Pending');
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
  // ── 2.8.47 — Mirror LinkedIn DM Assistant flow verbatim ──────────────
  // All helpers below are direct ports of:
  // /Users/antoniovarlese/Desktop/Projects/LinkedIn DM Assistant/content.js
  // The DM Assistant works in Orbita; mirroring its DOM logic exactly is
  // the surest way to make the bot work too.
  const currentUrl = page.url();
  if (!/\/in\/[^/?#]+/.test(currentUrl)) {
    throw new Error(`MESSAGE_SEND_FAILED: not on a profile page (${currentUrl})`);
  }
  console.log(`[actions] sendMessage on ${currentUrl}`);

  // Close any pre-existing message bubbles to prevent bleed from prior lead.
  await page.evaluate(() => {
    document.querySelectorAll(
      '.msg-overlay-bubble-header__control--close, ' +
      '.msg-overlay-conversation-bubble button[aria-label*="Close" i]'
    ).forEach(b => { try { b.click(); } catch { /* */ } });
  });
  await new Promise(r => setTimeout(r, 400));

  // ── Open + Fill: one big browser-side execution mirroring the DM Assistant ──
  const opened = await page.evaluate(async (msg) => {
    // ─── DM Assistant helpers (verbatim port) ───────────────────────────
    const isActionCandidate = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const isVisibleElement = isActionCandidate;
    const activateElement = (el) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isExactish = (v, t) => v === t || v.startsWith(`${t} `) || v.endsWith(` ${t}`);
    const getTextValues = (el) => {
      const root = el.getRootNode?.() || document;
      const labelledBy = (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => root.getElementById?.(id)?.textContent || '')
        .join(' ');
      return [
        el.innerText, el.textContent,
        el.getAttribute('aria-label'), el.getAttribute('title'),
        labelledBy,
      ].map(normalize).filter(Boolean);
    };
    const doesMatch = (el, targets, opts = {}) => {
      const values = getTextValues(el);
      return targets.some((t) => values.some((v) => (
        opts.exact ? isExactish(v, t) : v === t || v.includes(t)
      )));
    };
    const querySelectorAllDeep = (root, sel) => {
      if (!root?.querySelectorAll) return [];
      const out = [], seen = new Set();
      const visit = (r) => {
        if (!r?.querySelectorAll) return;
        r.querySelectorAll(sel).forEach((el) => { if (!seen.has(el)) { seen.add(el); out.push(el); } });
        r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
      };
      visit(root);
      return out;
    };
    const isSidebar = (el) => Boolean(el.closest?.('aside, [role="complementary"], .scaffold-layout__aside, .ad-banner-container'));
    const isUnsafeRightPanel = (el) => {
      if (!el) return true;
      if (isSidebar(el)) return true;
      const r = el.getBoundingClientRect();
      const inRightRail = r.left >= Math.max(window.innerWidth * 0.58, 860);
      if (el.closest?.('.scaffold-layout__aside, .scaffold-layout__sidebar, .pv-profile-sticky-header, .ad-banner-container, [aria-label*="People also viewed"], [aria-label*="People you may know"], [aria-label*="Similar profiles"]')) return true;
      if (!inRightRail) return false;
      const card = el.closest?.('section, article, aside, [role="complementary"]');
      const txt = normalize(card?.innerText || card?.textContent);
      return ['people also viewed', 'people you may know', 'similar profiles', 'more profiles for you', 'other profiles viewed']
        .some((label) => txt.includes(label));
    };
    const findButtonInRoot = (root, texts, opts = {}) => {
      if (!root) return null;
      const targets = texts.map((t) => t.toLowerCase());
      const cands = querySelectorAllDeep(root, 'button, [role="button"], a[role="button"]')
        .filter((el) => isActionCandidate(el) && !isUnsafeRightPanel(el));
      for (const el of cands) {
        if (doesMatch(el, targets, opts)) return el;
      }
      return null;
    };
    const findTextActionInRoot = (root, texts, opts = {}) => {
      if (!root) return null;
      const targets = texts.map((t) => t.toLowerCase());
      return querySelectorAllDeep(root, "button, [role='button'], a[role='button'], button *, [role='button'] *, a[role='button'] *")
        .filter(isVisibleElement)
        .filter((el) => {
          const values = getTextValues(el);
          return targets.some((t) => values.some((v) => (
            opts.exact ? isExactish(v, t) : v === t || v.includes(t)
          )));
        })
        .map((el) => el.closest('button, [role="button"], a[role="button"]') || el)
        .filter((el, i, arr) => arr.indexOf(el) === i)
        .find((el) => isActionCandidate(el) && !isUnsafeRightPanel(el)) || null;
    };
    const findProfileHeaderRoot = (heading, main) => {
      const headingRect = heading.getBoundingClientRect();
      const candidates = [];
      let node = heading;
      while (node && node !== document.body) {
        if (node.nodeType === 1 && (node === main || node.matches?.('section, article, div'))) {
          const r = node.getBoundingClientRect();
          const hasNearbyAction = Array.from(node.querySelectorAll('button, [role="button"], a[role="button"]'))
            .some((b) => isProfileHeaderAction(b, headingRect));
          if (hasNearbyAction && r.height > 0 && r.height <= 760) {
            candidates.push({ node, area: r.width * r.height });
          }
        }
        if (node === main) break;
        node = node.parentElement;
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0]?.node || null;
    };
    const isProfileHeaderAction = (el, headingRect) => {
      if (!isActionCandidate(el) || isUnsafeRightPanel(el)) return false;
      const r = el.getBoundingClientRect();
      const near = (
        r.top >= headingRect.top - 80 &&
        r.top <= headingRect.bottom + 520 &&
        r.left < Math.max(window.innerWidth * 0.72, headingRect.left + 780)
      );
      const hasText = doesMatch(el, ['message', 'more', 'more actions', 'connect', 'follow'], { exact: false });
      return near && hasText;
    };
    const getTopCardRoot = () => {
      const main = document.querySelector('main');
      // 2.8.47: also accept h2 — the 2026 redesign demoted profile name to h2.
      const heading = main?.querySelector('h1, h2') ||
                      document.querySelector('main .text-heading-xlarge, main h1, main h2');
      if (heading) {
        const root = findProfileHeaderRoot(heading, main);
        if (root) return root;
      }
      for (const sel of ['main .pv-top-card', 'main .pv-top-card-v2-ctas__custom', 'main section.artdeco-card']) {
        const root = document.querySelector(sel);
        if (root) return root;
      }
      return main; // 2.8.47: fall back to the whole main, not null
    };
    const getProfileMessageButton = () => {
      const topCard = getTopCardRoot();
      const tcBtn = findTextActionInRoot(topCard, ['Message'], { exact: true }) ||
                    findButtonInRoot(topCard, ['Message'], { exact: true });
      if (tcBtn) return tcBtn;
      const selectors = [
        'main button[aria-label^="Message " i]',
        'main button[aria-label*=" Message " i]',
        'main button:has([data-test-icon="send-privately-small"])',
        'button[aria-label^="Message " i]',
        'button:has([data-test-icon="send-privately-small"])',
      ];
      for (const sel of selectors) {
        try {
          const b = document.querySelector(sel);
          if (b && isActionCandidate(b) && !isUnsafeRightPanel(b)) return b;
        } catch { /* :has unsupported */ }
      }
      const icon = document.querySelector('[data-test-icon="send-privately-small"]');
      const btn = icon?.closest?.('button');
      return (btn && isActionCandidate(btn) && !isUnsafeRightPanel(btn)) ? btn : null;
    };

    const isTypingTarget = (t) => {
      if (!t) return false;
      const tag = (t.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true ||
        t.closest?.('[contenteditable="true"], [role="textbox"]');
    };
    const getComposeRoots = () => {
      const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
      return dialog ? [dialog, document] : [document];
    };
    const getMessageInputTarget = (opts = {}) => {
      const active = document.activeElement;
      if (!opts.ignoreActive && isTypingTarget(active)) return active;
      for (const root of getComposeRoots()) {
        const t = root.querySelector(
          'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"], .msg-form__contenteditable'
        );
        if (t) return t;
      }
      return null;
    };
    const fillTextTarget = (target, text) => {
      target.focus();
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(target, text); else target.value = text;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // contenteditable — DM Assistant's path verbatim.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
      let pasted = false;
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        pasted = !target.dispatchEvent(evt);
      } catch { pasted = false; }
      if (!pasted) {
        document.execCommand('selectAll', false);
        const ok = document.execCommand('insertText', false, text);
        if (!ok) target.textContent = text;
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };

    // ─── Step 1: open the message bubble ──────────────────────────────
    const messageBtn = getProfileMessageButton();
    if (!messageBtn) {
      return { ok: false, step: 'open', reason: 'message-btn-not-found' };
    }
    activateElement(messageBtn);

    // ─── Step 2: wait for composer ────────────────────────────────────
    let target = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      target = getMessageInputTarget({ ignoreActive: true });
      if (target) break;
    }
    if (!target) {
      return { ok: false, step: 'composer', reason: 'composer-not-found' };
    }

    // ─── Step 3: fill text using DM Assistant's exact paste path ──────
    fillTextTarget(target, msg);

    return { ok: true };
  }, message);

  if (!opened.ok) {
    throw new Error(`MESSAGE_SEND_FAILED: ${opened.step} (${opened.reason})`);
  }
  console.log('[actions] Bubble opened and message typed');

  // Let React register the input.
  await new Promise(r => setTimeout(r, 700));

  // ─── Step 4: click Send (DM Assistant's clickSendMessageButton, ported) ─
  const sentByButton = await page.evaluate(() => {
    const isActionCandidate = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activateElement = (el) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const getComposeRoots = () => {
      const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
      const overlays = [...document.querySelectorAll('.msg-overlay-conversation-bubble, [class*="msg-overlay-conversation"]')];
      const roots = [];
      if (dialog) roots.push(dialog);
      roots.push(...overlays);
      roots.push(document);
      return roots;
    };
    const findSendInRoot = (root) => {
      // Prefer text "Send message" / "Send" inside the root.
      const cands = [...(root.querySelectorAll?.('button, [role="button"]') || [])];
      for (const b of cands) {
        if (!isActionCandidate(b)) continue;
        const t = (b.textContent || '').trim().toLowerCase();
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        if (t === 'send message' || t === 'send' || a === 'send' || a === 'send message') return b;
      }
      return null;
    };
    for (const root of getComposeRoots()) {
      const b = findSendInRoot(root);
      if (b) return activateElement(b);
    }
    const icon = document.querySelector('[data-test-icon*="send"], .msg-form__send-button');
    const btn = icon?.closest?.('button') || icon;
    if (btn && isActionCandidate(btn)) return activateElement(btn);
    return false;
  });

  // ─── Step 5: if button click failed, fall back to keyboard sending ──
  if (!sentByButton) {
    console.log('[actions] Send button not found — falling back to plain Enter');
    await page.evaluate(() => {
      const t = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!t) return;
      t.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(t);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
    });
    // Plain Enter — Zhelena and other accounts have "Press Enter to send".
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 250));
    // Belt-and-suspenders.
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  } else {
    console.log('[actions] Clicked Send button');
  }

  // ─── Step 6: HONEST verification ────────────────────────────────────
  // Old logic falsely returned "sent" whenever a class selector didn't
  // match (null editor → '' → empty=true). New logic requires positive
  // proof: composer found AND empty, OR our message tail is in the thread.
  await new Promise(r => setTimeout(r, 2500));
  const verified = await page.evaluate((sentText) => {
    const editor = document.querySelector(
      'div[role="textbox"][aria-label*="Write a message" i], ' +
      '.msg-form__contenteditable, ' +
      '.msg-form div[contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message" i]'
    );
    let composerEmpty = null;
    let editorText = '';
    if (editor) {
      editorText = (editor.textContent || editor.innerText || '').replace(/​/g, '').trim();
      composerEmpty = editorText.length === 0;
    }
    let foundInThread = false;
    const tail = (sentText || '').slice(-40).trim();
    if (tail.length >= 8) {
      const messages = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event"], ' +
        '[class*="msg-event-listitem"], .msg-s-message-list-content li'
      );
      for (const m of messages) {
        if ((m.textContent || '').includes(tail)) { foundInThread = true; break; }
      }
    }
    return {
      composerEmpty,
      foundInThread,
      editorText: editorText.substring(0, 60),
      editorFound: !!editor,
    };
  }, message);

  const success = verified.composerEmpty === true || verified.foundInThread === true;
  if (!success) {
    const why = verified.editorFound
      ? `composer still has text: "${verified.editorText}"`
      : 'composer not found and message not in thread';
    throw new Error(`MESSAGE_SEND_FAILED: send not confirmed (${why})`);
  }
  console.log(`[actions] ✓ Message sent (composerEmpty=${verified.composerEmpty}, foundInThread=${verified.foundInThread})`);

  // Close the floating bubble cleanly.
  await page.evaluate(() => {
    const bubble = document.querySelector(
      '.msg-overlay-conversation-bubble, [class*="msg-overlay-conversation"]'
    );
    if (!bubble) return;
    const closeBtn = bubble.querySelector(
      'button[aria-label*="Close your conversation" i], ' +
      'button[aria-label="Close" i], ' +
      '.msg-overlay-bubble-header__control--close, ' +
      'button[aria-label*="Close" i]'
    );
    if (closeBtn) { try { closeBtn.click(); } catch { /* */ } }
  });
  await new Promise(r => setTimeout(r, 500));
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveSalesNavUrlFromInProfile
// ═════════════════════════════════════════════════════════════════════════════
// Pure helper: clicks the More dropdown on a /in/ profile and extracts the
// "View in Sales Navigator" href via a three-tier lookup (dropdown-scoped
// anchor → any anchor with /sales/{lead,people}/ → text-match item with
// child a[href]). Does NOT navigate. Returns the absolute URL string on
// success or null on failure. Never throws — callers choose their own
// failure mode.
// ═════════════════════════════════════════════════════════════════════════════

export async function resolveSalesNavUrlFromInProfile(page) {
  console.log('[actions] resolveSalesNavUrlFromInProfile: opening More dropdown…');

  let moreOk = false;
  try {
    moreOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const more = btns.find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent || '').trim().toLowerCase();
        return a === 'more actions' || a === 'more' || t === 'more';
      });
      if (more) { more.click(); return true; }
      return false;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: More click failed: ${e.message}`);
    return null;
  }

  if (!moreOk) {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: More button not found');
    return null;
  }

  await new Promise(r => setTimeout(r, 2500));

  let salesNavUrl = null;
  try {
    salesNavUrl = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) {
          const inDropdown = a.closest('.artdeco-dropdown__content, [role="menu"]');
          if (inDropdown) return a.href;
        }
      }
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) return a.href;
      }
      const items = Array.from(document.querySelectorAll('[role="button"], .artdeco-dropdown__item, li'));
      for (const el of items) {
        const text = (el.textContent || '').trim();
        if (text.includes('View in Sales Navigator')) {
          const a = el.querySelector('a[href]');
          if (a) return a.href;
        }
      }
      return null;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: href extract failed: ${e.message}`);
    return null;
  }

  if (salesNavUrl) {
    console.log(`[actions] resolveSalesNavUrlFromInProfile: resolved → ${salesNavUrl}`);
  } else {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: no Sales Nav href found in dropdown');
  }
  return salesNavUrl || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendInMail
// ═════════════════════════════════════════════════════════════════════════════

export async function sendInMail(page, subject, message) {
  // InMail goes through Sales Navigator for both local and gologin accounts.
  // Path: More dropdown → extract Sales Nav href → page.goto(href) →
  // click Message on the Sales Nav lead page → type → Send.
  //
  // If caller already navigated to Sales Nav (performOutreach's upfront
  // conversion for OP/InMail modes), skip the internal resolve+goto —
  // backward-compatible for /in/ callers, no-op for Sales Nav callers.
  const alreadyOnSalesNav = SALES_NAV_URL_RE.test(page.url());
  if (!alreadyOnSalesNav) {
    const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
    if (!salesNavUrl) throw new Error('INMAIL_SEND_FAILED: View in Sales Navigator href not found');

    console.log(`[actions] Navigating to Sales Nav: ${salesNavUrl}`);
    try {
      await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn(`[actions] Sales Nav navigation issue: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // Click Message on the Sales Nav lead page, inspect panel, type and send.
  // Uses the shared Sales Nav primitives defined below.
  const msgClicked = await clickSalesNavMessageButton(page);
  if (!msgClicked) throw new Error('INMAIL_SEND_FAILED: Sales Nav Message button missing');

  await new Promise(r => setTimeout(r, 3500));

  const panel = await readSalesNavComposerState(page);
  if (panel.creditsAvailable === 0) {
    throw new Error('INMAIL_NO_CREDITS: 0 InMail credits remaining — stopping InMail sends');
  }
  if (panel.creditsAvailable !== null) {
    console.log(`[actions] InMail credits available before send: ${panel.creditsAvailable}`);
  } else {
    console.warn('[actions] Could not read InMail credit counter (regex miss)');
  }

  const sendResult = await typeAndSendSalesNavComposer(page, subject, message);
  if (!sendResult.ok) throw new Error(`INMAIL_SEND_FAILED: ${sendResult.error}`);

  const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
  console.log(`[actions] ✓ InMail sent via Sales Navigator. Credits remaining: ${creditsLeft ?? 'unknown'}`);
  return { creditsLeft };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sales Nav router — shared primitives + entry point
// ═════════════════════════════════════════════════════════════════════════════
// Some sheets contain direct Sales Navigator URLs (linkedin.com/sales/people/…
// or /sales/lead/…) instead of standard /in/… profile URLs. The regular
// /in/-shaped status check + Open Profile / InMail flows misread the Sales
// Nav DOM. This router short-circuits both flows for Sales Nav URLs and
// drives the Sales Nav Message composer directly.
//
// The same three primitives are also reused by sendInMail, which ends up on a
// Sales Nav page via the /in/ More-dropdown. Zero duplicated Sales Nav logic.
// ═════════════════════════════════════════════════════════════════════════════

async function clickSalesNavMessageButton(page) {
  return await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      if ((t === 'message' || aria.startsWith('message') || aria.includes('message')) && b.offsetWidth > 0) {
        b.click();
        return true;
      }
    }
    return false;
  });
}

async function readSalesNavComposerState(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const isFree = /free message/i.test(text);
    // Positive Open Profile signal — LinkedIn renders the literal badge text
    // "Free to Open Profile" in the Sales Nav message panel for free-send
    // targets. Using the presence of this badge (instead of the absence of
    // a credit counter) avoids false-positives when the panel renders without
    // a credit counter for non-OP reasons (slow render, A/B variant, etc.).
    const isFreeToOpenProfile = /free to open profile/i.test(text);
    const creditMatch = text.match(/Use\s+\d+\s+of\s+(\d+)\s+credits?/i);
    const hasCreditCounter = !!creditMatch;
    const creditsAvailable = creditMatch ? parseInt(creditMatch[1], 10) : null;
    const hasSubject = !!document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
    const hasCompose = !!document.querySelector(
      '.msg-form__contenteditable, ' +
      'div[role="textbox"][aria-label*="message" i], ' +
      'textarea[name="message"], ' +
      'textarea[aria-label*="type your message" i], ' +
      'form[data-x-conversation-widget="compose-form"] textarea'
    );
    return { isFree, isFreeToOpenProfile, hasCreditCounter, creditsAvailable, hasSubject, hasCompose };
  });
}

async function typeAndSendSalesNavComposer(page, subject, body) {
  // Subject (optional — Sales Nav paid panel has it; free panel sometimes doesn't)
  if (subject) {
    await page.evaluate((subj) => {
      const subjInput = document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
      if (!subjInput) return;
      subjInput.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(subjInput, subj);
      subjInput.dispatchEvent(new Event('input', { bubbles: true }));
      subjInput.dispatchEvent(new Event('change', { bubbles: true }));
    }, subject);
    await new Promise(r => setTimeout(r, 600));
  }

  const typedOk = await typeIntoField(page, body);
  if (!typedOk) return { ok: false, error: 'Could not type message (Sales Nav composer)' };

  await new Promise(r => setTimeout(r, 800));
  const sendOk = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const btns = Array.from(document.querySelectorAll('button'));
      const send = btns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const isSend = t === 'send' || aria === 'send' || aria.startsWith('send ');
        const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
        return isSend && !isDisabled && b.offsetWidth > 0;
      });
      if (send) { send.click(); return true; }
      await sleep(150);
    }
    return false;
  });
  if (!sendOk) return { ok: false, error: 'Send button never enabled' };

  await new Promise(r => setTimeout(r, 3000));
  return { ok: true };
}

/**
 * Assumes the page is already on a Sales Nav URL
 * (linkedin.com/sales/people/… or /sales/lead/…).
 * Decision rules match the /in/ flow exactly:
 *   - force_open_profile : free panel → send, paid panel → do NOT send.
 *   - force_inmail       : free panel → send free (OP template),
 *                          paid panel → spend 1 credit (InMail template),
 *                          0 credits  → skip.
 *
 * Returns a status object; never throws.
 */
export async function sendViaSalesNav(page, { mode, opSubject, opBody, inmailSubject, inmailBody, connectionNote }) {
  console.log(`[actions] SalesNavRouter: mode=${mode} — looking for Message button on Sales Nav page…`);

  // For the connect-with-OP-fallback mode, a missing Message button is
  // acceptable — we'll jump straight to the overflow → Connect path.
  const clicked = await clickSalesNavMessageButton(page);
  if (!clicked && mode !== 'force_connect_op_fallback') return { ok: false, reason: 'message_button_not_found' };

  let panel = { hasCompose: false, hasCreditCounter: false, creditsAvailable: null, hasSubject: false, isFree: false };
  if (clicked) {
    await new Promise(r => setTimeout(r, 3500));
    panel = await readSalesNavComposerState(page);
    console.log(`[actions] SalesNavRouter panel: ${JSON.stringify(panel)}`);
  }

  // force_connect_op_fallback intentionally handles the no-composer case by
  // falling through to the "..." → Connect path, so skip the early bail.
  if (!panel.hasCompose && mode !== 'force_connect_op_fallback') {
    return { ok: false, reason: 'no_compose_textbox' };
  }

  if (mode === 'force_open_profile') {
    // Positive-signal gating: only send if the "Free to Open Profile" badge
    // is present. "No credit counter" is not proof of Open Profile — the
    // panel can render without a counter for transient/non-OP reasons.
    if (!panel.isFreeToOpenProfile) {
      return { ok: false, reason: 'not_open_profile' };
    }
    const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    console.log('[actions] ✓ Sales Nav Open Profile message sent');
    return { ok: true, kind: 'op_message_sent' };
  }

  if (mode === 'force_inmail') {
    if (panel.isFreeToOpenProfile) {
      // Explicit OP badge — send free via the OP template.
      const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
      if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
      console.log('[actions] ✓ Sales Nav free message sent (InMail mode, OP path)');
      return { ok: true, kind: 'op_message_sent' };
    }
    if (panel.creditsAvailable === 0) {
      return { ok: false, reason: 'no_credits' };
    }
    const result = await typeAndSendSalesNavComposer(page, inmailSubject, inmailBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
    console.log(`[actions] ✓ Sales Nav InMail sent. Credits remaining: ${creditsLeft ?? 'unknown'}`);
    return { ok: true, kind: 'inmail_sent', creditsLeft };
  }

  if (mode === 'force_connect_op_fallback') {
    // Connection campaign + "Message OPs Directly": try Message → if the
    // "Free to Open Profile" badge is present, send OP; otherwise close
    // and fall through to "..." → Connect.
    if (clicked) {
      if (panel.hasCompose && panel.isFreeToOpenProfile) {
        const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
        if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
        console.log('[actions] ✓ Sales Nav OP message sent (connect-with-OP-fallback)');
        return { ok: true, kind: 'op_message_sent' };
      }
      // Paid InMail panel, no composer, or not OP — close before trying Connect.
      await closeSalesNavComposer(page);
      await new Promise(r => setTimeout(r, 1000));
    }

    const overflowOpen = await clickSalesNavOverflowMenu(page);
    if (!overflowOpen) return { ok: false, reason: 'unreachable', error: 'Overflow menu button not found' };
    await new Promise(r => setTimeout(r, 1500));

    const connectOpened = await clickSalesNavConnectMenuItem(page);
    if (!connectOpened) return { ok: false, reason: 'unreachable', error: 'Connect menu item not found' };
    await new Promise(r => setTimeout(r, 2500));

    const sent = await fillAndSendSalesNavConnectModal(page, connectionNote);
    if (!sent.ok) return { ok: false, reason: 'send_failed', error: sent.error };
    console.log('[actions] ✓ Sales Nav Connect request sent (OP fallback)');
    return { ok: true, kind: 'connection_sent' };
  }

  return { ok: false, reason: 'unknown_mode' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales Nav overflow-menu + Connect modal primitives
// ─────────────────────────────────────────────────────────────────────────────

async function clickSalesNavOverflowMenu(page) {
  return await page.evaluate(() => {
    const candidates = [
      'button[aria-label="Open actions overflow menu"]',
      'button[data-x--lead-actions-bar-overflow-menu]',
      'button[aria-haspopup="true"][aria-expanded="false"]',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetWidth > 0) { btn.click(); return true; }
    }
    return false;
  });
}

async function clickSalesNavConnectMenuItem(page) {
  // The overflow menu renders into #hue-web-menu-outlet and becomes visible
  // when .<something>_visible_... is added. We text-match "Connect" inside
  // the visible menu to find the option regardless of hashed class names.
  return await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const outlet = document.getElementById('hue-web-menu-outlet');
      if (outlet) {
        const menus = outlet.querySelectorAll('[class*="_visible_"]');
        for (const menu of menus) {
          const items = menu.querySelectorAll('li, button, [role="menuitem"], a');
          for (const item of items) {
            const txt = (item.textContent || '').trim();
            if (/^connect$/i.test(txt) && item.offsetWidth > 0) {
              item.click();
              return true;
            }
          }
        }
      }
      await sleep(150);
    }
    return false;
  });
}

async function fillAndSendSalesNavConnectModal(page, note) {
  // Fill the invitation note (optional) and click Send in .artdeco-modal__actionbar.
  if (note) {
    const filled = await page.evaluate((noteText) => {
      const ta = document.querySelector('#connect-cta-form__invitation, textarea[maxlength="300"]');
      if (!ta) return false;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, noteText);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, note.slice(0, 300));
    if (!filled) return { ok: false, error: 'Connect modal note textarea not found' };
    await new Promise(r => setTimeout(r, 600));
  }

  const sent = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const bar = document.querySelector('.artdeco-modal__actionbar');
      if (bar) {
        const btns = Array.from(bar.querySelectorAll('button'));
        const send = btns.find(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const isSend = t === 'send' || t === 'send invitation' || t === 'send now' || aria === 'send' || aria.startsWith('send ');
          const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
          return isSend && !isDisabled && b.offsetWidth > 0;
        });
        if (send) { send.click(); return true; }
      }
      await sleep(150);
    }
    return false;
  });
  if (!sent) return { ok: false, error: 'Send button never enabled in Connect modal' };

  await new Promise(r => setTimeout(r, 2500));
  return { ok: true };
}

async function closeSalesNavComposer(page) {
  // Close the message overlay before attempting Connect — the panel covers
  // the profile header which we need to click into.
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label*="Close" i][class*="_close_"], .msg-overlay-bubble-header__control[aria-label*="close" i]');
    if (close) { close.click(); return; }
    // Fallback: any visible close button inside the message overlay region
    const overlays = document.querySelectorAll('#message-overlay, [data-sn-view-name="subpage-message-overlay"]');
    for (const o of overlays) {
      const closeBtn = o.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i]');
      if (closeBtn && closeBtn.offsetWidth > 0) { closeBtn.click(); return; }
    }
  });
}
