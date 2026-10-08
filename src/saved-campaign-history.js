import { readFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { canViewCampaign, canAccessSavedCampaign } from './campaign-visibility.js';
import { resolveEngine, PROD_URL, DEV_URL } from './engine-target.js';

// Launch snapshots retain the permanent campaign ID and the engine's run ID.
// Read only those known runs; never search other operators' campaigns by name.
export async function readSavedCampaignHistory(entry, viewer, options = {}) {
  if (!entry || !canAccessSavedCampaign(entry, viewer)) return { status: 404, error: 'Campaign not found.' };
  const snapshots = options.snapshots || JSON.parse(await readFile(dataPath('cloud-launch-configs.json'), 'utf8').catch(() => '{}'));
  const runs = Object.entries(snapshots).filter(([, value]) => value.config?.campaignId === entry.campaignId)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  const engine = options.engine || resolveEngine();
  const bases = [...new Set([engine.url, PROD_URL, DEV_URL])].filter(Boolean);
  const request = options.fetch || fetch;
  for (const [id] of runs) {
    for (const base of bases) {
      const headers = { Authorization: `Bearer ${engine.token}` };
      const response = await request(`${base}/api/campaign/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(12000) });
      if (response.status === 404) continue;
      if (!response.ok) return { status: 502, error: 'Could not load campaign history.' };
      const detail = await response.json();
      if (!detail.campaign || !canViewCampaign(detail.campaign, viewer)) return { status: 404, error: 'Campaign not found.' };
      if (detail.campaign.config?.campaignId && detail.campaign.config.campaignId !== entry.campaignId) return { status: 404, error: 'Campaign not found.' };
      const leadsResponse = await request(`${base}/api/campaign/${encodeURIComponent(id)}/leads`, { headers, signal: AbortSignal.timeout(12000) });
      if (!leadsResponse.ok) return { status: 502, error: 'Could not load campaign history.' };
      const leads = await leadsResponse.json();
      return { status: 200, campaign: detail.campaign, leads: leads.leads || [], monitorLog: detail.monitorLog || [],
        environment: base === DEV_URL ? 'development' : base === PROD_URL ? 'production' : engine.environment };
    }
  }
  return { status: 200, campaign: null, leads: [], monitorLog: [] };
}
