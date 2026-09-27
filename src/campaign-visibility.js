/** Ownership is explicit; an unnamed owner never means a public campaign. */
export function canViewCampaign(record, { admin = false, email = '', operatorId = '' } = {}) {
  if (admin) return true;
  const owner = String(record?.owner || record?.ownerEmail || record?.owner_email || '').trim().toLowerCase();
  const viewer = String(email || '').trim().toLowerCase();
  if (owner) return !!viewer && owner === viewer;
  return !!operatorId && record?.operatorId === operatorId;
}
export function visibleCampaigns(records, viewer) {
  return (Array.isArray(records) ? records : []).filter(record => canViewCampaign(record, viewer));
}
