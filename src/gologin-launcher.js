import GoLogin from 'gologin';
import puppeteer from 'puppeteer-core';

const activeProfiles = new Map();

// Profile list cache — loaded once, reused across the entire campaign
let profileCache = null;
let profileCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getProfiles(token) {
  // Return cache if fresh
  if (profileCache && Date.now() - profileCacheTime < CACHE_TTL) {
    return profileCache;
  }

  const allProfiles = [];
  let page = 1;
  let totalCount = Infinity;

  while (allProfiles.length < totalCount) {
    const res = await fetch(`https://api.gologin.com/browser/v2?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GoLogin API ${res.status}`);

    const data = await res.json();
    totalCount = data.allProfilesCount || 0;
    const profiles = data.profiles || [];
    if (!profiles.length) break;

    for (const p of profiles) {
      allProfiles.push({ id: p.id, name: p.name, notes: p.notes || '' });
    }

    console.log(`[gologin] Page ${page}: ${allProfiles.length}/${totalCount}`);
    page++;
  }

  console.log(`[gologin] Total: ${allProfiles.length} profiles`);
  profileCache = allProfiles;
  profileCacheTime = Date.now();
  return allProfiles;
}

export function clearProfileCache() {
  profileCache = null;
  profileCacheTime = 0;
}

/**
 * Launch a GoLogin browser profile.
 * The browser window is positioned off-screen to avoid stealing focus.
 */
export async function launchProfile(profileId, token) {
  console.log(`[gologin] Starting ${profileId}…`);

  const GL = new GoLogin({
    token,
    profile_id: profileId,
    // Push the window off-screen so it doesn't steal focus
    extra_params: [
      '--window-position=-2400,-2400',
      '--window-size=1366,900',
    ],
  });

  const { status, wsUrl } = await GL.start();

  if (status !== 'success') {
    await GL.stop().catch(() => {});
    throw new Error(`GoLogin start failed: status="${status}"`);
  }

  activeProfiles.set(profileId, GL);

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000, // Prevent "Runtime.callFunctionOn timed out"
  });

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  return { browser, page };
}

export async function closeProfile(profileId) {
  const GL = activeProfiles.get(profileId);
  if (!GL) return;

  try { await GL.stop(); }
  catch (err) { console.warn(`[gologin] Stop warning: ${err.message}`); }

  activeProfiles.delete(profileId);
}
