// Read-only: no navigation, menu clicks, sends, account launch, or persistence.
export async function observeOpenInvitation({ browser, url }) {
  const target = profileKey(url);
  if (!target) throw new Error('An exact HTTPS LinkedIn /in/ profile URL is required.');
  if (!browser) return { state: 'unavailable', message: 'This profile has no local recovery browser open. No browser was opened and no invitation was sent. VM-only tabs cannot be inspected by this local reader.' };
  const pages = await browser.pages();
  const matches = pages.filter(page => !page.isClosed() && profileKey(page.url()) === target);
  if (matches.length !== 1) return { state: 'unavailable', message: 'Open exactly one tab for this recipient in the correct profile, then check again. No tab was opened or navigated.' };
  const page = matches[0];
  const result = await page.evaluate(() => {
    const root = document.querySelector('main .pv-top-card, main .pv-top-card-v2-ctas, main section:has(h1)');
    if (!root) return 'unknown';
    const controls = [...root.querySelectorAll('button, [role="button"]')].filter(e => e.getClientRects().length);
    const pending = controls.some(e => /^pending$/i.test((e.textContent || '').trim()));
    return pending ? 'pending_observed' : 'unknown';
  });
  if (page.isClosed() || profileKey(page.url()) !== target) return { state: 'unknown', message: 'The tab changed during verification. No result was recorded; check again when it is stable.' };
  return result === 'pending_observed'
    ? { state: result, message: 'Pending is visible for this recipient in this GoLogin profile. Do not resend. This is a read-only observation; sender login identity and campaign records have not been changed or certified.' }
    : { state: 'unknown', message: 'Pending could not be established from the visible profile controls. This does not mean the invitation failed. Keep the outcome unresolved; do not resend automatically.' };
}

function profileKey(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(u.hostname) && !u.username && !u.password && /^\/in\/[^/]+\/?$/.test(u.pathname) ? u.pathname.replace(/\/$/, '') : null; } catch { return null; }
}
