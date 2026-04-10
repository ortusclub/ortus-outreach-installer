import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';

let activeBrowser = null;

// Separate profile dir — never touches the user's real Chrome
const LOCAL_DATA_DIR = resolve('./data/local-chrome');

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
 * Get the user's real Chrome Default profile directory.
 */
function getRealChromeProfileDir() {
  const platform = process.platform;
  let base;
  if (platform === 'darwin') {
    base = join(process.env.HOME, 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (platform === 'win32') {
    base = join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  } else {
    base = join(process.env.HOME, '.config', 'google-chrome');
  }
  return join(base, 'Default');
}

/**
 * Copy essential cookie/session files from the user's Chrome profile
 * into our local campaign profile so LinkedIn session is available.
 * NEVER modifies the source files.
 */
function syncCookiesFromChrome() {
  const src = getRealChromeProfileDir();
  const dest = join(LOCAL_DATA_DIR, 'Default');

  if (!existsSync(src)) {
    console.warn(`[local] Chrome profile not found at ${src} — launching without cookies`);
    return;
  }

  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  // Files that hold the LinkedIn session
  const sessionFiles = ['Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences'];

  for (const file of sessionFiles) {
    const srcFile = join(src, file);
    const destFile = join(dest, file);
    if (existsSync(srcFile)) {
      try {
        copyFileSync(srcFile, destFile);
      } catch (e) {
        // File may be locked by running Chrome — that's OK, skip it
        console.log(`[local] Could not copy ${file}: ${e.message} (non-fatal)`);
      }
    }
  }

  console.log('[local] Synced session cookies from Chrome default profile.');
}

/**
 * Launch a separate Chrome instance with copied cookies from the user's profile.
 * Does NOT touch the user's running Chrome in any way.
 * Returns { browser, page } — same interface as GoLogin launcher.
 */
export async function launchLocalBrowser() {
  console.log('[local] Starting local browser...');

  const chromePath = process.env.CHROME_PATH || findChromePath();
  if (!chromePath) {
    throw new Error(
      'No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.'
    );
  }

  // Ensure our isolated profile dir exists
  if (!existsSync(LOCAL_DATA_DIR)) mkdirSync(LOCAL_DATA_DIR, { recursive: true });

  // Copy cookies from the user's real Chrome profile
  syncCookiesFromChrome();

  // Launch a completely separate Chrome instance
  console.log(`[local] Launching separate Chrome: ${chromePath}`);
  console.log(`[local] Campaign profile dir: ${LOCAL_DATA_DIR}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: LOCAL_DATA_DIR,
    args: [
      // Off-screen like GoLogin — doesn't steal focus
      '--window-position=-2400,-2400',
      '--window-size=1366,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
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

  console.log('[local] ✓ Chrome launched with copied session cookies.');
  return { browser, page };
}

/**
 * Close the local browser instance completely.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    const pages = await activeBrowser.pages();
    for (const p of pages) {
      try { await p.close(); } catch { /* ignore */ }
    }
    await activeBrowser.close();
    console.log('[local] Campaign browser closed.');
  } catch (err) {
    console.warn(`[local] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
