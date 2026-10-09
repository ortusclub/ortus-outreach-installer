// Full local source development, including API changes. Close the installed
// app first: both use its existing data and browser session, with one worker.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const installedEnv = '/Applications/The Ortus Outreach.app/Contents/Resources/.env';
if (fs.existsSync(installedEnv)) {
  const values = dotenv.parse(fs.readFileSync(installedEnv));
  // Admin policy belongs to this source version, not the older installed build.
  delete values.ADMIN_EMAILS;
  for (const [key, value] of Object.entries(values)) if (process.env[key] == null) process.env[key] = value;
}
app.setName('The Ortus Outreach');
app.setPath('userData', path.join(app.getPath('appData'), 'The Ortus Outreach'));
process.env.ORTUS_DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.ORTUS_DEV_HOT_RELOAD = '1';
// UI assets can change while node --watch is restarting the backend. Recover
// that temporary failed navigation without requiring the user to reopen the app.
app.on('browser-window-created', (_event, window) => {
  let recovering = false;
  window.webContents.on('did-fail-load', async (_event, code, _description, url, mainFrame) => {
    if (recovering || !mainFrame || code !== -102 || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return;
    recovering = true;
    try {
      for (let attempt = 0; attempt < 30 && !window.isDestroyed(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
          if (response.ok) { await window.loadURL(url); break; }
        } catch { /* the backend is still restarting */ }
      }
    } finally { recovering = false; }
  });
});
import('../electron/main.js');
