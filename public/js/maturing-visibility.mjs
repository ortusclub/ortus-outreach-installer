/** Maturing is shared by the creator's company, never by the target profile. */
export function isMaturingCampaign(record) {
  return !!(record?.config?.matureWarm || record?.maturing || record?.mode === 'mature_profile');
}
export function maturingCompany(email) {
  const value = String(email || '').trim().toLowerCase();
  const parts = value.split('@');
  return parts.length === 2 && parts[0] && ['ortusclub.com', 'linkedvelocity.com'].includes(parts[1]) ? parts[1] : '';
}
export function canViewMaturingCampaign(record, email) {
  const owner = String(record?.owner || record?.ownerEmail || record?.owner_email || '').trim().toLowerCase();
  const viewer = String(email || '').trim().toLowerCase();
  const company = maturingCompany(viewer);
  return company ? company === maturingCompany(owner) : !!viewer && owner === viewer;
}
