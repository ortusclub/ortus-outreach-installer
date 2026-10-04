const normalized = value => String(value || '').trim().toLowerCase();
const priority = item => item.bucket === 'running' ? 3 : item.bucket === 'queued' ? 2 : item.bucket === 'done' ? 1 : 0;
// Mirrors Basics' latestLocalCampaignHistory, extended to cloud run records.
export function groupCampaignRuns(items) {
  const groups = new Map();
  for (const item of items) {
    const owner = item.mine ? 'mine' : normalized(item.owner);
    const identity = item.campaignId || normalized(item.name) || item.id;
    const key = `${owner}:${identity}`;
    const runs = groups.get(key) || [];
    runs.push(item); groups.set(key, runs);
  }
  return [...groups.values()].map(runs => {
    const ordered = runs.slice().sort((a,b) => priority(b)-priority(a)
      || (Date.parse(b.createdAt || b.hist?.date || '') || 0)-(Date.parse(a.createdAt || a.hist?.date || '') || 0));
    return { ...ordered[0], previousRuns: ordered.slice(1), activeRunCount: ordered.filter(r => ['running','queued'].includes(r.bucket)).length };
  });
}
