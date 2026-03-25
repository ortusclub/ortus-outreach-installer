/**
 * LinkedIn helpers — v18.
 * ALL clicks use element.click() via page.evaluate().
 * NEVER page.mouse.click(). No coordinates. No viewport dependencies.
 */

export function randomDelay(min = 500, max = 2000) {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

/**
 * Click a button by aria-label — searches BOTH regular DOM and Shadow DOM.
 * Uses element.click() which works regardless of visibility or viewport.
 */
export async function clickByAria(page, ariaLabel) {
  return page.evaluate((label) => {
    // Regular DOM
    const btn = document.querySelector(`button[aria-label="${label}"]`);
    if (btn) { btn.click(); return 'dom'; }

    // Shadow DOM
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) {
      const sBtn = outlet.shadowRoot.querySelector(`button[aria-label="${label}"]`);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, ariaLabel);
}

/**
 * Click a button by its exact text content — searches BOTH DOMs.
 */
export async function clickByText(page, text) {
  return page.evaluate((t) => {
    // Regular DOM
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.trim() === t);
    if (btn) { btn.click(); return 'dom'; }

    // Shadow DOM
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) {
      const sBtns = Array.from(outlet.shadowRoot.querySelectorAll('button'));
      const sBtn = sBtns.find(b => b.textContent?.trim() === t);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, text);
}

/**
 * Find a button by text and click it via JS (regular DOM only).
 */
export async function findButtonByText(page, text) {
  const byAria = await page.$(`button[aria-label*="${text}"]`);
  if (byAria) return byAria;

  const byText = await page.evaluateHandle((t) => {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === t) || null;
  }, text);
  return byText.asElement();
}

/**
 * Get connection status. Uses aria-label + text only.
 */
export async function getConnectionStatus(page) {
  try {
    const result = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));

      // Profile name from h1 or title
      let profileName = '';
      const h1 = document.querySelector('h1');
      if (h1) profileName = h1.textContent.trim().split('\n')[0].trim();
      if (!profileName) {
        const title = document.title || '';
        const m = title.match(/^(.+?)(?:\s*[\|–-]\s*LinkedIn)?$/);
        if (m) profileName = m[1].trim();
      }
      const firstName = profileName ? profileName.split(' ')[0].toLowerCase() : '';

      const debug = buttons.slice(0, 12).map(b => ({
        text: (b.textContent || '').trim().substring(0, 35),
        aria: (b.getAttribute('aria-label') || '').substring(0, 50),
      }));

      // 1. Pending
      for (const btn of buttons) {
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'pending' || a.includes('pending')) {
          return { status: 'pending', debug, profileName };
        }
      }

      // 2. Message
      for (const btn of buttons) {
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'message' && a.includes('message')) {
          if (firstName && a.includes(firstName)) return { status: 'message', debug, profileName };
          if (buttons.indexOf(btn) < 15) return { status: 'message', debug, profileName };
        }
      }

      // 3. Connect
      for (const btn of buttons) {
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        const t = (btn.textContent || '').trim().toLowerCase();
        if (a.includes('invite') && a.includes('to connect')) {
          if (firstName && a.includes(firstName)) return { status: 'connect', debug, profileName };
          if (buttons.indexOf(btn) < 15) return { status: 'connect', debug, profileName };
        }
        if (t === 'connect' && buttons.indexOf(btn) < 10) {
          return { status: 'connect', debug, profileName };
        }
      }

      // 4. Follow
      for (const btn of buttons) {
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'follow' && a.includes('follow')) {
          if (firstName && a.includes(firstName)) return { status: 'follow', debug, profileName };
          if (buttons.indexOf(btn) < 15) return { status: 'follow', debug, profileName };
        }
      }

      return { status: 'unknown', debug, profileName };
    });

    console.log(`[helpers] Status: ${result.status} (name: "${result.profileName || '?'}")`);
    if (result.status === 'unknown') {
      console.log('[helpers] Buttons:', JSON.stringify(result.debug));
    }
    return result.status;
  } catch (err) {
    console.warn(`[helpers] Error: ${err.message}`);
    return 'unknown';
  }
}

export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result.replace(/\{[a-zA-Z]+\}/g, '').trim();
}
