export function isIdentityRestrictedStatus(value) {
  const status = String(value == null ? '' : value).trim().toLowerCase();
  return status.includes('restricted') || status === 'inaccessible';
}

export function identityRestrictionLabel(row) {
  if (!row || !isIdentityRestrictedStatus(row.Status ?? row.status)) return '';
  return String(row.Status ?? row.status).trim() || 'Identity Restricted';
}
