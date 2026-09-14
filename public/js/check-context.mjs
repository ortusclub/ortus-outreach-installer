// Freeze the selected campaign's settings before a check crosses an async boundary.
export function checkContext(config, allSenders = false) {
  const t = config.templates || {};
  const profileIds = [...(config.profileIds || [])];
  if (!config.sheetUrl) throw new Error('Select a sheet before running a check.');
  if (!allSenders && !profileIds.length) throw new Error('Select accounts before running a check.');
  return structuredClone({
    explicitCheckContext: true,
    taskOwner: config.taskCampaignId && config.campaignRunId
      ? { campaignId: config.taskCampaignId, campaignRunId: config.campaignRunId } : null,
    taskOwner: config.taskCampaignId && config.campaignRunId
      ? { campaignId: config.taskCampaignId, campaignRunId: config.campaignRunId } : null,
    sheetUrl: config.sheetUrl, linkedinColumn: config.linkedinColumn || '',
    mode: config.mode || '',
    ...(allSenders ? { allSenders: true } : { profileIds }),
    primaryName: t.primaryName || '', primaryUrl: t.primaryUrl || '',
    primaryIntroBody: t.primaryIntroBody || '', introTitle: t.introTitle || '',
    primarySource: t.primarySource || '', autoAcceptPrimary: t.autoAcceptPrimary === true,
    ccDmBody: t.ccDmBody || '', senderFirstNames: config.senderFirstNames || {},
  });
}
