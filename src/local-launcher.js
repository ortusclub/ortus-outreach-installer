import puppeteer from 'puppeteer-core';
import { startupAdmission } from './startup-admission.js';
import { withTimeout } from './promise-timeout.js';
import { existsSync, mkdirSync } from 'fs';
import { dataPath } from './paths.js';
import { hideByPid, unhideByPids } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';
import { confirmOwnedProcessExit } from './process-exit-evidence.js';

let activeBrowser = null;
let pendingLaunch = false;
let closingBrowser = null;
let lastCloseEvidence = { browserClosed: false };

// Persistent profile — cookies survive across runs
const LOCAL_PROFILE_DIR = dataPath('local-profile');

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
export async function launchLocalBrowser({ visible = false, signal } = {}) {
  startupAdmission.assertRuntimeReady();
  if (pendingLaunch) throw new Error('Local browser launch is already in progress');
  pendingLaunch = true;
  try {
  if (signal?.aborted) throw signal.reason || new Error('Local launch cancelled');
  if (closingBrowser) throw new Error('Local browser shutdown is still in progress');
  if (activeBrowser && lastCloseEvidence.unconfirmed) throw new Error('Local browser shutdown is unconfirmed; do not start another session');
  // Phase 2.8.20 (W3-C2): disk-space pre-flight (same gate as GoLogin launcher).
  const disk = await checkDiskFree();
  startupAdmission.assertRuntimeReady();
  if (closingBrowser) throw new Error('Local browser shutdown is still in progress');
  if (signal?.aborted) throw signal.reason || new Error('Local launch cancelled');
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }
  console.log('[local] Starting local browser...');

  const chromePath = process.env.CHROME_PATH || findChromePath();
  if (!chromePath) {
    throw new Error('No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.');
  }

  if (!existsSync(LOCAL_PROFILE_DIR)) mkdirSync(LOCAL_PROFILE_DIR, { recursive: true });

  // The sign-in/recovery button can be pressed more than once, and the
  // operator can press Retry without first closing Chrome. Starting another
  // Puppeteer process against the same user-data-dir either hits Chrome's
  // profile lock or leaves two controllers fighting over the same profile.
  // Reuse the one process and deliberately switch it between a normal visible
  // recovery window and the parked automated window.
  if (activeBrowser && activeBrowser.connected) {
    const pages = await activeBrowser.pages();
    const page = pages.find((p) => !p.isClosed()) || await activeBrowser.newPage();
    const pid = activeBrowser.process?.()?.pid;
    if (visible) {
      // setViewport() installs CDP device emulation. That is useful for stable
      // automation, but an operator reported that the resulting LinkedIn login
      // page behaved like a locked automation window. Clear the emulation and
      // return control to the real headed Chrome viewport for manual recovery.
      await page.setViewport(null).catch(() => {});
      if (pid) await unhideByPids([pid]);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: 60, top: 60, width: 1600, height: 1000, windowState: 'normal' },
        });
        await client.detach();
      } catch { /* visibility is best-effort */ }
      await page.bringToFront().catch(() => {});
    } else if (pid) {
      await hideByPid(pid);
    }
    return { browser: activeBrowser, page };
  }

  console.log(`[local] Chrome: ${chromePath}`);
  console.log(`[local] Profile: ${LOCAL_PROFILE_DIR}`);

  const launchPromise = puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    // A human recovery browser must use Chrome's real viewport. Puppeteer's
    // synthetic viewport is reserved for hidden automated campaign work.
    defaultViewport: visible ? null : { width: 1600, height: 1000 },
    userDataDir: LOCAL_PROFILE_DIR,
    args: [
      // Parked off-screen for automated runs, on-screen when the operator is
      // being asked to DO something in it. The operator's own words, 2026-09-01:
      // "it has never really opened my local browser" — it always had, at
      // -2400,-2400, where nobody could see it.
      ...(visible ? ['--window-position=60,60'] : ['--window-position=-2400,-2400']),
      '--window-size=1600,1000',
      '--no-first-run',
      '--no-default-browser-check',
      // Anti-detection stealth flags (inspired by playwright-stealth)
      '--disable-blink-features=AutomationControlled',  // Hides navigator.webdriver
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',                              // No "Chrome is controlled" bar
    ],
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000,
  });
  const browser = await withTimeout(launchPromise, {
    ms: 120_000,
    label: 'Local Chrome launch',
    onTimeout: async () => {
      // A late-resolving launch must not leak a browser after its caller has
      // already released the campaign slot.
      launchPromise.then((late) => late?.close?.()).catch(() => {});
    },
  });

  activeBrowser = browser;
  lastCloseEvidence = { browserClosed: false };
  if (signal?.aborted) {
    await closeLocalBrowser();
    throw signal.reason || new Error('Local launch cancelled');
  }

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  if (!visible) await page.setViewport({ width: 1600, height: 1000 });
  page.setDefaultNavigationTimeout(30000);
  // v2.86: 15s → 30s default action timeout (match gologin-launcher) — slow
  // operator machines were timing out clicks / waitForSelector too early.
  page.setDefaultTimeout(30000);

  // Stealth: hide automation indicators from page JS
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Normal plugins array (headless Chrome has 0)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Normal languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    // Chrome runtime object (missing in automation)
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  console.log('[local] ✓ Chrome launched with persistent profile (stealth enabled).');

  // Phase 11.2 (D-16): hide automated work only. A visible recovery browser is
  // explicitly handed to the operator and must remain visible and interactive.
  const pid = browser.process?.()?.pid;
  if (pid && !visible) { hideByPid(pid).catch(() => {}); }

  return { browser, page };
  } finally { pendingLaunch = false; }
}

/**
 * Close the local browser completely.
 */
export async function closeLocalBrowser() {
  if (closingBrowser) return closingBrowser;
  if (!activeBrowser) return lastCloseEvidence;
  const browser = activeBrowser;
  closingBrowser = (async () => {
    Promise.resolve().then(() => browser.close()).catch(err => console.warn(`[local] Close warning: ${err.message}`));
    const evidence = await confirmOwnedProcessExit(browser.process?.());
    if (!evidence.browserClosed) lastCloseEvidence = { ...evidence, unconfirmed: true };
    if (evidence.browserClosed && activeBrowser === browser) {
      activeBrowser = null;
      lastCloseEvidence = evidence;
      console.log('[local] Campaign browser exit confirmed.');
    }
    return evidence;
  })();
  try { return await closingBrowser; }
  finally { closingBrowser = null; }
}
