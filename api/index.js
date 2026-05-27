/**
 * Vercel serverless adapter for Ortus GoLogin Clone.
 * Uses native Vercel handler (no Express dependency).
 */

function checkAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ortus Dashboard"');
    res.status(401).send('Authentication required');
    return false;
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASS) {
    return true;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Ortus Dashboard"');
  res.status(401).send('Invalid credentials');
  return false;
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const path = req.url.replace(/\?.*$/, '');

  // ── Health ──
  if (path === '/api/health') {
    return res.json({ ok: true, time: new Date().toISOString(), env: 'vercel' });
  }

  // ── GoLogin profiles ──
  if (path === '/api/profiles') {
    try {
      const token = process.env.GOLOGIN_API_TOKEN;
      if (!token) return res.json([]);

      const allProfiles = [];
      let page = 1;
      let totalCount = Infinity;

      while (allProfiles.length < totalCount) {
        const r = await fetch(`https://api.gologin.com/browser/v2?page=${page}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`GoLogin API ${r.status}`);
        const data = await r.json();
        totalCount = data.allProfilesCount || 0;
        const profiles = data.profiles || [];
        if (!profiles.length) break;
        for (const p of profiles) {
          allProfiles.push({ id: p.id, name: p.name, notes: p.notes || '' });
        }
        page++;
      }
      return res.json(allProfiles);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── SoO Status ──
  if (path === '/api/soo-status') {
    try {
      const sooSheetId = process.env.SOO_SHEET_ID;
      const sooGid = process.env.SOO_SHEET_GID;
      const webappUrl = process.env.SHEETS_WEBAPP_URL;
      if (!sooSheetId || !webappUrl) return res.json({ accounts: [] });

      const response = await fetch(webappUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetId: sooSheetId,
          action: 'getSoO',
          sooSheetId,
          sooGid: sooGid || '',
        }),
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.json({ accounts: [], error: err.message });
    }
  }

  // ── Sheet preview ──
  if (path === '/api/sheet/preview') {
    try {
      const url = req.query?.url;
      if (!url) return res.status(400).json({ error: 'url required' });
      const match = url.match(/\/d\/([^/]+)/);
      if (!match) return res.status(400).json({ error: 'Invalid sheet URL' });
      const csvUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
      const r = await fetch(csvUrl);
      if (!r.ok) return res.status(500).json({ error: `Sheet fetch failed (${r.status})` });
      const text = await r.text();
      const lines = text.split('\n').filter(l => l.trim());
      const columns = lines[0] ? lines[0].split(',').map(c => c.replace(/"/g, '').trim()) : [];
      return res.json({ totalRows: Math.max(0, lines.length - 1), columns, preview: [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Campaign status (stub) ──
  if (path === '/api/campaign/status') {
    return res.json({
      running: false, currentProfile: null, processedToday: 0,
      totalProcessed: 0, totalTargets: 0, mode: '', profileNames: [],
      logs: ['[Vercel demo] Campaign execution only available on local server.'],
      errors: [],
    });
  }

  if (path === '/api/campaign/start') {
    return res.status(400).json({ error: 'Campaign execution is only available on the local server.' });
  }

  if (path === '/api/campaign/stop') {
    return res.json({ message: 'No campaign running (Vercel preview)' });
  }

  // ── Stubs ──
  if (path === '/api/templates') return res.json({});
  if (path === '/api/schedules') return res.json([]);
  if (path === '/api/history') return res.json([]);
  if (path === '/api/server-log') return res.json([]);

  return res.status(404).json({ error: 'Not found' });
}
