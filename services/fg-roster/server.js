// Entry: pull the DB from GCS, point the app's search-service at it, then listen.
// The DB dir is set BEFORE importing search-service so its DEFAULT_DIR/DEFAULT_CACHE
// resolve to the pulled copy.
import path from 'node:path';
import os from 'node:os';
import { pullDb } from './pull-db.js';
import { Storage } from '@google-cloud/storage';
import { makeRunStore } from '../../src/connections/fg-cloud-launch.js';
import { startCloudCampaign } from '../../src/campaigns-client.js';
import { makeConfigStore } from './config-store.js';
import { makeMailer } from './mailer.js';
import { makeAutopilotHandler } from './autopilot.js';

const DEST = process.env.CONNECTIONS_DIR || path.join(os.tmpdir(), 'fg-connections');
process.env.CONNECTIONS_DB_DIR = DEST; // consumed by search-service path resolution (Step 7)

const { makeApp } = await import('./app.js');
const searchService = await import('../../src/connections/search-service.js');

const BUCKET = process.env.FG_ROSTER_BUCKET || 'ortus-fg-connections-db';
const storage = new Storage();
const putObject = (name, buf) => storage.bucket(BUCKET).file(name).save(buf, { resumable: false });

const configStore = makeConfigStore({ path: path.join(DEST, 'fg-autopilot.json'), putObject });
const runStore = makeRunStore(path.join(DEST, 'fg-autopilot-runs.json'));
const saveRuns = () => { try { putObject('fg-autopilot-runs.json', JSON.stringify(runStore.load(), null, 2)); } catch (_) {} };
const mailer = makeMailer({});

const autopilot = makeAutopilotHandler({
  searchService,
  startCloud: (payload) => startCloudCampaign(payload),
  queueInvites: async () => {},
  runStore,
  loadConfig: () => configStore.load(),
  saveRuns,
  sendAlert: (s, b) => mailer.sendAlert(s, b),
  now: () => new Date().toISOString(),
  log: (m) => console.log(`[fg-autopilot] ${m}`),
  inviteUrl: process.env.ORTUS_PAGE_INVITE_URL || '',
  monthlyBudget: Number(process.env.FG_DEFAULT_MONTHLY_ALLOWANCE || 30),
});

let ready = false;
async function refresh() { await pullDb({ destDir: DEST }); ready = true; }

const TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
const PORT = Number(process.env.PORT || 8080);

const app = makeApp({ impl: searchService, token: TOKEN, isReady: () => ready, onRefresh: refresh, autopilot, configStore, runStore });
app.listen(PORT, () => console.log(`[fg-roster] listening on :${PORT}`));

refresh().catch((e) => console.error('[fg-roster] initial DB pull failed (will 503 until /admin/refresh):', e.message));
