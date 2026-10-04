const ACTIVE = new Set(['queued', 'pending', 'scheduled', 'running', 'paused', 'monitoring', 'stopping', 'waiting_daily_reset', 'needs_review']);
const key = value => String(value || '').trim().toLowerCase();
const pending = new Map();
export async function withCampaignLaunch(campaignId, work) {
  const previous = pending.get(campaignId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  pending.set(campaignId, next);
  try { return await next; } finally { if (pending.get(campaignId) === next) pending.delete(campaignId); }
}
export async function findActiveCampaign(campaigns, identity, owner, readSnapshot) {
  for (const campaign of campaigns) {
    if (!ACTIVE.has(campaign.status) || key(campaign.owner) !== key(owner)) continue;
    const snapshot = await readSnapshot(campaign.id);
    const savedId = campaign.config?.campaignId || snapshot?.config?.campaignId;
    if (savedId === identity.campaignId || key(campaign.name) === key(identity.name)) return campaign;
  }
  return null;
}
