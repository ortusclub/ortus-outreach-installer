/**
 * src/linkedin/thread-message.js — net-new. Reopen a known group thread (the
 * one created when the intro was sent) and post the automated first follow-up.
 * Off-limits actions.js/outreach.js are NOT touched.
 *
 * isUsableThreadUrl is pure + tested; sendInThread is verified manually.
 */

/** A captured page.url() is a usable thread target only if it's a real
 *  /messaging/thread/<id> URL — not a /compose, /feed, or empty fallback. */
export function isUsableThreadUrl(url) {
  if (!url) return false;
  return /\/messaging\/thread\/[^/?#]+/.test(String(url));
}

/**
 * Type `body` into the composer of the thread at `threadUrl` and send it.
 * Falls back to searching messaging by lead name when the URL is unusable.
 * Throws on failure so the runner can mark the task failed/retry.
 */
export async function sendInThread(page, threadUrl, body, { introTitle = '', leadName = '', log = () => {} } = {}) {
  if (!body || !body.trim()) throw new Error('FOLLOWUP_EMPTY_BODY');

  let target = threadUrl;
  if (!isUsableThreadUrl(target)) {
    log(`  ↻ Follow-up: thread URL unusable, searching messaging for "${leadName}"…`);
    target = await _findThreadByLead(page, leadName, introTitle);
    if (!target) throw new Error('FOLLOWUP_THREAD_NOT_FOUND');
  }

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));

  const box = await page.waitForSelector(
    'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    { timeout: 15000 },
  ).catch(() => null);
  if (!box) throw new Error('FOLLOWUP_COMPOSER_NOT_FOUND');

  await box.click();
  await page.keyboard.type(body, { delay: 12 });
  await new Promise(r => setTimeout(r, 400));

  const sent = await page.evaluate(() => {
    const btn = document.querySelector('button.msg-form__send-button, button[type="submit"].msg-form__send-button');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  });
  if (!sent) {
    await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
  }
  await new Promise(r => setTimeout(r, 1500));
  log(`  ✓ Follow-up sent in the group thread${leadName ? ` (${leadName})` : ''}.`);
}

async function _findThreadByLead(page, leadName, introTitle) {
  try {
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const needle = (leadName || introTitle || '').trim();
    if (!needle) return '';
    return await page.evaluate((want) => {
      const rows = Array.from(document.querySelectorAll('a.msg-conversation-listitem__link, a[href*="/messaging/thread/"]'));
      const lc = want.toLowerCase();
      const hit = rows.find(a => (a.textContent || '').toLowerCase().includes(lc));
      return hit ? hit.href : '';
    }, needle);
  } catch {
    return '';
  }
}
