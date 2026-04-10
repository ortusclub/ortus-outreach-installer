import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const LOCAL_PROFILE_DIR = resolve('./data/local-profile');

let activeBrowser = null;

/**
 * Find Chrome/Chromium executable on the system.
 * Returns the first path that exists, or null.
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
 * Launch a local Chrome/Chromium browser with a persistent user data directory.
 * Returns { browser, page } — same shape as launchProfile from gologin-launcher.
 */
export async function launchLocalBrowser() {
  if (!existsSync(LOCAL_PROFILE_DIR)) {
    mkdirSync(LOCAL_PROFILE_DIR, { recursive: true });
  }

  const executablePath = process.env.CHROME_PATH || findChromePath();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.\n' +
      'Checked: macOS (/Applications/Google Chrome.app), Linux (/usr/bin/google-chrome, /usr/bin/chromium), Windows (Program Files).'
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: LOCAL_PROFILE_DIR,
    args: [
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

  return { browser, page };
}

/**
 * Close the active local browser instance.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    const pages = await activeBrowser.pages();
    for (const p of pages) {
      try { await p.close(); } catch { /* ignore */ }
    }
    await activeBrowser.close();
  } catch (err) {
    console.warn(`[local-browser] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
