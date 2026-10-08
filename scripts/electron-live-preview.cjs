// Develop the interface against the installed app's running backend. No second
// campaign worker, scheduler, credential store or permission system is started.
const { app, BrowserWindow, shell, ipcMain, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const upstream = new URL(process.env.ORTUS_LIVE_APP_URL || 'http://127.0.0.1:7848');
if (upstream.hostname !== '127.0.0.1' || upstream.protocol !== 'http:') throw Error('The live backend must be local.');
app.setName('Ortus Outreach Live Preview');
app.setPath('userData', path.join(app.getPath('appData'), 'Ortus Outreach Live Preview'));
process.env.ORTUS_DATA_DIR = path.join(app.getPath('appData'), 'The Ortus Outreach', 'data');
let window, previewWindow, server, watcher, timer;

async function history(req, res, campaignId) {
  const headers = { Cookie: req.headers.cookie || '' };
  const meResponse = await fetch(new URL('/api/me', upstream), { headers });
  if (!meResponse.ok) { res.writeHead(meResponse.status); res.end(await meResponse.text()); return; }
  const me = await meResponse.json();
  const configResponse = await fetch(new URL(`/api/campaign-configs/by-id/${encodeURIComponent(campaignId)}`, upstream), { headers });
  if (!configResponse.ok) { res.writeHead(configResponse.status); res.end(await configResponse.text()); return; }
  const entry = await configResponse.json();
  const { readSavedCampaignHistory } = await import('../src/saved-campaign-history.js');
  const { getOperatorId } = await import('../src/operator-id.js');
  const result = await readSavedCampaignHistory(entry, { email: me.operatorEmail || me.email, maturingEmail: me.email, admin: me.admin, operatorId: getOperatorId() });
  res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
}

async function pushWorkspaceToken(req, res) {
  if (req.headers.origin && !['http://127.0.0.1:7850', upstream.origin].includes(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request origin.' })); return;
  }
  const auth = await fetch(new URL('/api/me', upstream), { headers: { Cookie: req.headers.cookie || '' } });
  if (!auth.ok) { res.writeHead(auth.status); res.end(await auth.text()); return; }
  const me = await auth.json();
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) { res.writeHead(413); res.end(); return; }
  }
  let input;
  try { input = JSON.parse(body); }
  catch { res.writeHead(400); res.end('Invalid JSON'); return; }
  const { applyCredentials } = await import('../src/gologin-credentials.js');
  const { pushSavedGoLoginToken } = await import('../src/gologin-cloud-push.js');
  applyCredentials();
  const result = await pushSavedGoLoginToken({ workspace: input.workspace,
    confirmReplaceLive: input.confirmReplaceLive, operatorEmail: me.operatorEmail || me.email });
  res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result.body));
}

app.whenReady().then(async () => {
  const { isLivePreviewUrl, previewWindowBounds, restorePreviewWindow } = await import('../electron/live-preview-window.mjs');
  function openPreview(url) {
    if (!isLivePreviewUrl(url, 'http://127.0.0.1:7850')) throw Error('Invalid preview URL');
    if (previewWindow && !previewWindow.isDestroyed()) {
      if (previewWindow.webContents.getURL() !== url) previewWindow.loadURL(url);
      restorePreviewWindow(previewWindow); return;
    }
    const bounds = window.getBounds();
    previewWindow = new BrowserWindow({
      ...previewWindowBounds(bounds, screen.getDisplayMatching(bounds).workArea),
      title: 'Live preview — Ortus Outreach', minWidth: 360, minHeight: 260, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const child = previewWindow;
    child.on('closed', () => { if (previewWindow === child) previewWindow = null; });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.loadURL(url);
    restorePreviewWindow(child);
  }
  ipcMain.handle('ortus:open-live-preview', (event, url) => {
    if (event.sender !== window?.webContents) throw Error('Invalid preview sender');
    openPreview(url);
  });
  ipcMain.handle('ortus:close-live-preview', event => {
    if (event.sender !== window?.webContents) throw Error('Invalid preview sender');
    previewWindow?.close();
  });
  // An unavailable backend is an error, never a silent switch to test data.
  await fetch(new URL('/api/me', upstream));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/gologin-token' && req.method === 'POST') {
      pushWorkspaceToken(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Could not update the cloud connection.' }));
      });
      return;
    }
    const match = /^\/api\/campaign-configs\/by-id\/([^/]+)\/history$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      history(req, res, decodeURIComponent(match[1])).catch(error => {
        console.error('[preview] History:', error.message);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not load campaign history.' }));
      });
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    // Translate only this preview's same-origin requests. Foreign origins stay
    // untouched so the backend's CSRF check still rejects them normally.
    if (headers.origin === 'http://127.0.0.1:7850') headers.origin = upstream.origin;
    if (headers.referer?.startsWith('http://127.0.0.1:7850/')) {
      headers.referer = upstream.origin + headers.referer.slice('http://127.0.0.1:7850'.length);
    }
    const proxy = http.request(new URL(url.pathname + url.search, upstream), { method: req.method, headers }, response => {
      const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      // Ask the real backend first: page authentication, redirects and every API
      // retain exactly the installed app's behavior. Replace only static assets.
      if (req.method === 'GET' && response.statusCode === 200 && !url.pathname.startsWith('/api/')
          && file.startsWith(path.join(root, 'public') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        response.resume();
        const body = fs.readFileSync(file);
        const out = { ...response.headers, 'content-length': body.length, 'cache-control': 'no-store' };
        delete out['content-encoding']; delete out['transfer-encoding']; delete out.etag;
        res.writeHead(200, out); res.end(body);
      } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
    });
    proxy.on('error', error => {
      console.error('[preview] Backend:', error.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('The installed Outreach app must remain open.');
    });
    req.pipe(proxy);
  });
  await new Promise(resolve => server.listen(7850, '127.0.0.1', resolve));
  window = new BrowserWindow({ width: 1440, height: 1000, title: 'Outreach · live development',
    webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Keep live browser previews in Electron's authenticated session. Opening
    // them externally loses the session cookie and shows the sign-in page.
    if (isLivePreviewUrl(url, 'http://127.0.0.1:7850')) {
      openPreview(url);
      return { action: 'deny' };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL('http://127.0.0.1:7850');
  watcher = fs.watch(path.join(root, 'public'), { recursive: true }, (_event, filename) => {
    if (!/\.(html|css|js|mjs|svg)$/.test(filename || '')) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!window.isDestroyed()) window.webContents.reloadIgnoringCache(); }, 500);
  });
  console.log('[preview] http://127.0.0.1:7850 — installed backend ' + upstream.origin);
  console.log('[preview] Live reload: ' + path.join(root, 'public'));
}).catch(error => { console.error('[preview]', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { watcher?.close(); server?.close(); clearTimeout(timer); });
