// Entry: pull the DB from GCS, point the app's search-service at it, then listen.
// The DB dir is set BEFORE importing search-service so its DEFAULT_DIR/DEFAULT_CACHE
// resolve to the pulled copy.
import path from 'node:path';
import os from 'node:os';
import { pullDb } from './pull-db.js';

const DEST = process.env.CONNECTIONS_DIR || path.join(os.tmpdir(), 'fg-connections');
process.env.CONNECTIONS_DB_DIR = DEST; // consumed by search-service path resolution (Step 7)

const { makeApp } = await import('./app.js');
const searchService = await import('../../src/connections/search-service.js');

let ready = false;
async function refresh() { await pullDb({ destDir: DEST }); ready = true; }

const TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
const PORT = Number(process.env.PORT || 8080);

const app = makeApp({ impl: searchService, token: TOKEN, isReady: () => ready, onRefresh: refresh });
app.listen(PORT, () => console.log(`[fg-roster] listening on :${PORT}`));

refresh().catch((e) => console.error('[fg-roster] initial DB pull failed (will 503 until /admin/refresh):', e.message));
