import { companyCampaigns, sameCompanyCampaign } from '../public/js/company-access.mjs';

export function scopeAdminSources(sources, email) {
  const result = { ...sources };
  for (const key of ['cloud', 'history', 'queue', 'scrapes', 'connections', 'schedules']) {
    // Preserve source history indexes: its log routes use the unfiltered file.
    const records = key === 'history' ? (sources[key] || []).map((r, index) => ({ ...r, historyIndex: index })) : sources[key];
    result[key] = companyCampaigns(records, email);
  }
  result.local = sameCompanyCampaign(sources.local, email) ? sources.local : null;
  return result;
}

export function scopeBasicsSchedules(basics, email) {
  const schedules = companyCampaigns(basics.schedules, email);
  return { ...basics, schedules, scheduled: new Set(schedules.map(r => r.campaignId || `${r.source}:${r.id}`)).size };
}
