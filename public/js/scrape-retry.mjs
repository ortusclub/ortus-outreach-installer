export function retrySearchPayload(job) {
  if (!job || !['error', 'cancelled'].includes(job.state)) throw new Error('Only failed or stopped searches can be retried.');
  if (!job.searchUrl || !job.sheetUrl || !job.profileId) throw new Error('This search is missing its original URL, sheet or account.');
  return {
    searchUrls: [job.searchUrl], sheetUrl: job.sheetUrl, tabName: job.tabName,
    profileId: job.profileId, accountName: job.accountName || '',
    campaignName: job.campaignName || 'Scrape',
    runId: job.runId || '',
    slowMode: !!job.slowMode, accountPool: job.accountPool || [job.profileId],
  };
}

// Link an original failed row to its newer retry, including after a UI reload.
export function findSearchRetry(original, campaigns, sheetUrl) {
  if (!original || !sheetUrl) return null;
  const name = original.campaignName || 'Scrape';
  let found = null;
  for (const campaign of campaigns || []) {
    if (campaign.name !== name || campaign.sheetUrl !== sheetUrl) continue;
    for (const job of campaign.jobs || []) {
      if (job.tabName !== original.tabName || job.profileId !== original.profileId || Number(job.createdAt) <= Number(original.createdAt)) continue;
      if (!found || Number(job.createdAt) > Number(found.job.createdAt)) found = {campaign, job};
    }
  }
  return found;
}
