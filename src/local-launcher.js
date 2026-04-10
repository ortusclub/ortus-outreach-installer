import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

let activeBrowser = null;

// Persistent profile — cookies survive across runs
const LOCAL_PROFILE_DIR = resolve('./data/local-profile');

/**
 * Find Chrome executable path based on OS.
 */
function findChromePath() {
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Launch a separate Chrome with a persistent profile.
 * First run: user must log into LinkedIn (cookies are saved).
 * Every run after: LinkedIn session is remembered automatically.
 *
 * Returns { browser, page } — same interface as GoLogin launcher.
 */
export async function launchLocalBrowser() {
  console.log('[local] Starting local browser...');

  const chromePath = process.env.CHROME_PATH || findChromePath();
  if (!chromePath) {
    throw new Error('No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.');
  }

  if (!existsSync(LOCAL_PROFILE_DIR)) mkdirSync(LOCAL_PROFILE_DIR, { recursive: true });

  console.log(`[local] Chrome: ${chromePath}`);
  console.log(`[local] Profile: ${LOCAL_PROFILE_DIR}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: LOCAL_PROFILE_DIR,
    args: [
      '--window-position=-2400,-2400',
      '--window-size=1366,900',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000,
  });

  activeBrowser = browser;

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  console.log('[local] ✓ Chrome launched with persistent profile.');
  return { browser, page };
}

/**
 * Close the local browser completely.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    const pages = await activeBrowser.pages();
    for (const p of pages) {
      try { await p.close(); } catch { /* */ }
    }
    await activeBrowser.close();
    console.log('[local] Campaign browser closed.');
  } catch (err) {
    console.warn(`[local] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
