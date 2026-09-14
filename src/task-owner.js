import { randomUUID } from 'node:crypto';

export function taskOwnerOf(value = {}) {
  const campaignId = value.taskCampaignId || value.campaignId || value.id || '';
  const campaignRunId = value.campaignRunId || '';
  return campaignId && campaignRunId ? { campaignId, campaignRunId } : null;
}

export function startTaskOwner(options = {}) {
  const previous = taskOwnerOf(options);
  if ((options.resumeTaskRun === true || options.resumeContext) && previous) return previous;
  return { campaignId: 'legacy-singleton', campaignRunId: randomUUID() };
}
