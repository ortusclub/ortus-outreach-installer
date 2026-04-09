import 'dotenv/config';

// ── Startup env validation (D-06) ──────────────────────────────────
const REQUIRED_ENV = ['GOLOGIN_API_TOKEN', 'SHEETS_WEBAPP_URL', 'DASHBOARD_USER', 'DASHBOARD_PASS'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n  FATAL: Missing required environment variables:\n${missing.map(k => '    - ' + k).join('\n')}\n\n  Copy .env.example to .env and fill in all values.\n`);
  process.exit(1);
}

import express from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCampaign, stopCampaign, getCampaignStatus, campaign } from './src/campaign.js';
import { fetchSheet } from './src/sheets.js';
import { getProfiles, closeAllProfiles } from './src/gologin-launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Basic Auth (D-01, D-02) ────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Ortus Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASS) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Ortus Dashboard"');
  return res.status(401).send('Invalid credentials');
});

app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GoLogin profiles
// ---------------------------------------------------------------------------
app.get('/api/profiles', async (_req, res) => {
  try {
    const profiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    res.json(profiles);
  } catch (err) {
    console.error('Error fetching profiles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Google Sheet preview
// ---------------------------------------------------------------------------
app.get('/api/sheet/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const rows = await fetchSheet(url);
    res.json({
      totalRows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      preview: rows.slice(0, 5),
    });
  } catch (err) {
    console.error('Sheet preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Campaign control
// ---------------------------------------------------------------------------
app.post('/api/campaign/start', (req, res) => {
  try {
    const { profileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles } = req.body;

    if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!dailyLimit || dailyLimit < 1) return res.status(400).json({ error: 'dailyLimit must be >= 1' });

    // Fire and forget — campaign runs in background
    startCampaign({
      profileIds,
      sheetUrl,
      templates: templates || {},
      dailyLimit: Number(dailyLimit),
      mode: mode || 'auto',
      messageOpenProfiles: !!messageOpenProfiles,
    }).catch(err => console.error('Campaign error:', err.message));

    res.json({ ok: true, message: 'Campaign started' });
  } catch (err) {
    console.error('Campaign start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/stop', (_req, res) => {
  const result = stopCampaign();
  res.json(result);
});

app.get('/api/campaign/status', (_req, res) => {
  res.json(getCampaignStatus());
});

// ---------------------------------------------------------------------------
// Templates (save/load named template sets)
// ---------------------------------------------------------------------------
const TEMPLATES_PATH = resolve(__dirname, 'data', 'templates.json');

async function loadTemplates() {
  try {
    const raw = await readFile(TEMPLATES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTemplates(data) {
  await mkdir(dirname(TEMPLATES_PATH), { recursive: true });
  await writeFile(TEMPLATES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/templates', async (_req, res) => {
  const templates = await loadTemplates();
  res.json(templates);
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, templates: tpl } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const all = await loadTemplates();
    all[name] = tpl;
    await saveTemplates(all);
    res.json({ saved: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:name', async (req, res) => {
  try {
    const all = await loadTemplates();
    delete all[req.params.name];
    await saveTemplates(all);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n  ✦ Ortus GoLogin Clone v2.0`);
  console.log(`  ✦ Dashboard: http://localhost:${PORT}`);
  console.log(`  ✦ GoLogin token: ${process.env.GOLOGIN_API_TOKEN ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  ✦ Sheet tracking: ${process.env.SHEETS_WEBAPP_URL ? '✓ configured' : '✗ not configured (set SHEETS_WEBAPP_URL)'}\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received. Shutting down... waiting for current lead`);
  stopCampaign();

  // Wait for current lead to finish (campaign loop checks _abort between leads)
  const deadline = Date.now() + 30000;
  while (campaign.running && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  const count = await closeAllProfiles();
  console.log(`[shutdown] Closing ${count} profiles...`);
  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
