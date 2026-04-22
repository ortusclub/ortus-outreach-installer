// The Ortus Outreach — Electron main process.
//
// Wraps the existing Express server inside Electron. No campaign/outreach
// logic is touched. The server is loaded as a module after we've set up:
//   1. ORTUS_DATA_DIR  → app.getPath('userData')/data  (per-user writable storage)
//   2. ORTUS_ELECTRON_MODE = '1'                       (server uses email-only auth)
//   3. PORT                                            (free ephemeral port)
//   4. dotenv loaded from the bundled .env             (production) or repo root (dev)
//
// Phase 11.2 (D-19..D-22): tray-first boot. No dock icon on macOS, no window on
// boot. Dashboard is a child surface opened on tray click. Close (X) hides to
// tray; only Cmd+Q or tray Quit actually terminates the process.

import { app, BrowserWindow, Tray, Menu, shell, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Paths: where to find bundled .env + repo root depending on dev/packaged ──
const REPO_ROOT = app.isPackaged
  ? process.resourcesPath
  : resolve(__dirname, '..');

// Load .env from the right place. In packaged builds, .env is shipped via
// `extraResources` so it lands at process.resourcesPath/.env.
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ── Per-user data dir — server modules read this via src/paths.js ────────────
const userDataDir = join(app.getPath('userData'), 'data');
process.env.ORTUS_DATA_DIR = userDataDir;
process.env.ORTUS_ELECTRON_MODE = '1';

// ── Pick a free port before importing the server ─────────────────────────────
function pickFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

let mainWindow = null;
let serverPort = null;
let tray = null;

async function startServer() {
  serverPort = await pickFreePort();
  process.env.PORT = String(serverPort);

  // Resolve the bundled server.js. In dev, ../server.js. In packaged builds,
  // electron-builder includes the source under app.asar so the same relative
  // path works.
  const serverEntry = resolve(__dirname, '..', 'server.js');
  await import(serverEntry);

  // Wait for the server to actually be listening (the import returns
  // immediately; app.listen is async). Poll /api/health up to ~10s.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start within 10 seconds');
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 11.2 — tray-first boot. NO dock icon on macOS. NO auto-window.
// Dashboard is a child surface opened on demand via tray click / menu item.
// ──────────────────────────────────────────────────────────────────────────

function trayIconPath() {
  // macOS auto-inverts files whose name ends in Template.png. On non-darwin
  // platforms the Template suffix is ignored and the PNG renders as-is.
  return resolve(__dirname, '..', 'build', 'tray-iconTemplate.png');
}

function getOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'The Ortus Outreach',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // D-21 (T-11.2-10 mitigation): close hides to tray; only before-quit lets the
  // window actually destroy. Prevents the DoS of "X quits the whole app" that
  // would orphan an in-flight campaign.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  return mainWindow;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => getOrCreateWindow() },
    {
      label: 'Start Campaign…',
      click: () => {
        const w = getOrCreateWindow();
        w.webContents.once('did-finish-load', () => {
          w.webContents.executeJavaScript(
            "document.getElementById('nav-pace')?.scrollIntoView({ behavior: 'smooth' })"
          ).catch(() => {});
        });
      },
    },
    {
      label: 'Show Browsers',
      click: () => {
        // Best-effort; the dashboard alerts on error. The main-process fetch
        // runs without a session cookie, but POST /api/browsers/show is the
        // dashboard-internal path (session check is enforced at the server).
        if (!serverPort) return;
        fetch(`http://127.0.0.1:${serverPort}/api/browsers/show`, { method: 'POST' })
          .catch(() => {});
      },
    },
    { type: 'separator' },
    {
      label: 'Quit The Ortus Outreach',
      accelerator: 'CmdOrCtrl+Q',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);
}

// ── Single-instance lock — second launch opens the dashboard instead of
// spawning a separate process. ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    getOrCreateWindow();
  });

  app.whenReady().then(async () => {
    try {
      await startServer();

      // D-19 (T-11.2-11 mitigation): hide the dock BEFORE creating any window.
      // Calling dock.hide AFTER a window is created leaves the dock icon
      // sticky until the next app activate.
      if (process.platform === 'darwin' && app.dock?.hide) app.dock.hide();

      tray = new Tray(trayIconPath());
      tray.setToolTip('The Ortus Outreach');
      tray.setContextMenu(buildTrayMenu());

      // macOS left-click toggles the dashboard. On Win/Linux left-click shows
      // the context menu by default — we keep that.
      tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          getOrCreateWindow();
        }
      });

      // Do NOT call getOrCreateWindow here — tray-first means we stay dockless
      // until the operator asks for the window.
    } catch (err) {
      dialog.showErrorBox(
        'The Ortus Outreach',
        `Failed to start.\n\n${err.message}\n\nMake sure GoLogin desktop is running, then quit and reopen the app.`,
      );
      app.quit();
    }

    app.on('activate', () => {
      // Fallback for Win/Linux tray re-activation; with the dock hidden on
      // macOS this rarely fires, but tray click handles the same intent.
      if (BrowserWindow.getAllWindows().length === 0) getOrCreateWindow();
    });
  });
}

// D-22: NEVER quit on window close. Tray keeps the app alive on every
// platform. Previously: `if (process.platform !== 'darwin') app.quit();`.
app.on('window-all-closed', () => {
  // intentional no-op — tray drives lifecycle.
});

// Quit path: explicit Cmd+Q or tray Quit menu sets the flag, allowing
// mainWindow.on('close') to proceed normally.
app.on('before-quit', () => {
  app.isQuitting = true;
});
