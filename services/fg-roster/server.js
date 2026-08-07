// Entry: pull the DB from GCS, point the app's search-service at it, then listen.
// The DB dir is set BEFORE importing search-service so its DEFAULT_DIR/DEFAULT_CACHE
// resolve to the pulled copy.
import path from 'node:path';
import os from 'node:os';
import { pullDb } from './pull-db.js';
import { Storage } from '@google-cloud/storage';
import { makeRunStore } from '../../src/connections/fg-cloud-launch.js';
import { startCloudCampaign, getCloudCampaign, getCloudCampaignLeads, getCloudCampaignAccounts } from '../../src/campaigns-client.js';
import { makeConfigStore } from './config-store.js';
import { makeMailer } from './mailer.js';
import { makeAutopilotHandler } from './autopilot.js';
import { reconcileAll } from './reconcile.js';
// Same FG-sheet I/O the manual /api/fg/team-launch/start path uses (Apps Script
// over FG_WEBAPP_URL — no service-account creds needed), so an auto run behaves
// identically: skips already-invited + writes "Queued" proof back to the sheet.
import { getFgState, queueFgInvites, updateFgListLedger, markFgInvited, observeFgCredits, writeFgList, invitedKeysFromState } from '../../src/connections/fg-sync.js';
import { generateListRows } from '../../src/connections/fg-list-generate.js';
// The Ortus page "Invite to follow" URL — SAME constant the manual/local FG path
// hardcodes (server.js:2469/2515). Without it the engine's FG primitive skips
// openModal entirely (follower-invite.js `if (inviteUrl)` guard) and sends 0.
import { ORTUS_PAGE_INVITE_URL } from '../../src/sheets-webapp-url.js';

const DEST = process.env.CONNECTIONS_DIR || path.join(os.tmpdir(), 'fg-connections');
process.env.CONNECTIONS_DB_DIR = DEST; // consumed by search-service path resolution (Step 7)

const { makeApp } = await import('./app.js');
const searchService = await import('../../src/connections/search-service.js');

const BUCKET = process.env.FG_ROSTER_BUCKET || 'ortus-fg-connections-db';
const storage = new Storage();
const putObject = (name, buf) => storage.bucket(BUCKET).file(name).save(buf, { resumable: false });

const configStore = makeConfigStore({ path: path.join(DEST, 'fg-autopilot.json'), putObject });
const runStore = makeRunStore(path.join(DEST, 'fg-autopilot-runs.json'));
const saveRuns = () => { Promise.resolve(putObject('fg-autopilot-runs.json', JSON.stringify(runStore.load(), null, 2))).catch(() => {}); };
const mailer = makeMailer({});

const autopilot = makeAutopilotHandler({
  searchService,
  startCloud: (payload) => startCloudCampaign(payload),
  queueInvites: (rows, opts) => queueFgInvites(rows, opts), // write "Queued" proof to the FG sheet
  getFgState,                                    // skip already-invited people
  runStore,
  loadConfig: () => configStore.load(),
  saveRuns,
  sendAlert: (s, b) => mailer.sendAlert(s, b),
  now: () => new Date().toISOString(),
  log: (m) => console.log(`[fg-autopilot] ${m}`),
  inviteUrl: process.env.ORTUS_PAGE_INVITE_URL || ORTUS_PAGE_INVITE_URL,
  monthlyBudget: Number(process.env.FG_DEFAULT_MONTHLY_ALLOWANCE || 30),
  // Pre-generate the upcoming run's invite-list tab so a scheduled run never
  // depends on someone remembering to press Generate. Same builder + same writer
  // the desktop app's Generate button uses (generateListRows), so the tab a
  // human would have made and the one the cloud makes are identical.
  leadDays: Number(process.env.FG_PREGENERATE_LEAD_DAYS || 3),
  generateList: async (tab, { pairs, keywords, month }) => {
    const snap = await getFgState();
    const built = await generateListRows(pairs, {
      criteria: { jobTitles: keywords, companies: [], geo: [] },
      month,
      alreadyInvited: invitedKeysFromState(snap.invites),
      budget: Number(process.env.FG_DEFAULT_MONTHLY_ALLOWANCE || 30),
    }, { buildTargets: async (c, o) => searchService.buildFgTargets(c, o) });
    await writeFgList(tab, built.rows, { header: built.header });
    return { count: built.rows.length, perAccount: built.perAccount };
  },
});

const reconcileDeps = {
  getCampaign: (id) => getCloudCampaign(id),
  getLeads: (id) => getCloudCampaignLeads(id),
  getAccounts: (id) => getCloudCampaignAccounts(id),
  updateLedger: (tab, updates) => updateFgListLedger(tab, updates),
  markInvited: (args) => markFgInvited(args),
  observeCredits: (args) => observeFgCredits(args),
  log: (m) => console.log(`[fg-reconcile] ${m}`),
};
const reconciler = {
  async run() {
    return reconcileAll(runStore, reconcileDeps);
  },
};

let ready = false;
async function refresh() { await pullDb({ destDir: DEST }); ready = true; }

const TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
const PORT = Number(process.env.PORT || 8080);

const app = makeApp({ impl: searchService, token: TOKEN, isReady: () => ready, onRefresh: refresh, autopilot, reconciler, configStore, runStore });
app.listen(PORT, () => console.log(`[fg-roster] listening on :${PORT}`));

refresh().catch((e) => console.error('[fg-roster] initial DB pull failed (will 503 until /admin/refresh):', e.message));
