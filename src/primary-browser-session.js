export function primaryBrowserProblemFromUrl(url = '') {
  const value = String(url || '');
  if (/linkedin\.com\/(?:authwall|login|uas\/login)/i.test(value)) return { state: 'logged-out', reason: 'The primary browser is logged out of LinkedIn.' };
  if (/linkedin\.com\/checkpoint/i.test(value)) return { state: 'checkpoint', reason: 'The primary browser is stopped at a LinkedIn security checkpoint.' };
  return null;
}

export async function inspectPrimarySession(page) {
  if (!page) return null;
  if (typeof page.goto === 'function') await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/received/', {
    waitUntil: 'domcontentloaded', timeout: 45_000,
  }).catch(() => {});
  return primaryBrowserProblemFromUrl(typeof page.url === 'function' ? page.url() : '');
}

export function waitForPrimaryRecovery(campaign, problem, source, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = accepted => {
      signal?.removeEventListener('abort', abort);
      if (campaign._retryPrimary === retry) {
        campaign._retryPrimary = null;
        campaign.primaryRecovery = null;
      }
      resolve(accepted);
    };
    const abort = () => finish(false);
    const retry = () => finish(true);
    campaign.primaryRecovery = { ...problem, source };
    campaign._retryPrimary = retry;
    signal?.addEventListener('abort', abort, { once: true });
  });
}
