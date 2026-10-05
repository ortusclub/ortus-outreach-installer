// Called after ownership, deletion and dashboard filters have been applied.
export function splitMaturingCampaigns(items) {
  const regular = [], maturing = [];
  for (const item of items) {
    const isRun = item.bucket !== 'saved' && item.bucket !== 'draft';
    (item.mode === 'mature_profile' && isRun ? maturing : regular).push(item);
  }
  return { regular, maturing };
}
