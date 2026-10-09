const BRANDS = {
  'ortusclub.com': 'Ortus Outreach',
  'linkedvelocity.com': 'Linked Velocity Outreach',
  'apexstrategy.io': 'Apex Outreach',
};

export function emailCompany(email) {
  const match = /^[^\s@]+@([^\s@]+)$/.exec(String(email || '').trim().toLowerCase());
  return match && Object.hasOwn(BRANDS, match[1]) ? match[1] : '';
}

export function outreachBrand(email) {
  return BRANDS[emailCompany(email)] || 'Ortus Outreach';
}

export function campaignOwner(record) {
  return String(record?.owner || record?.ownerEmail || record?.owner_email || record?.createdBy || '').trim().toLowerCase();
}

// The campaign creator determines its company. Target accounts, names, device
// operator identity and the person currently browsing never establish ownership.
export function sameCompanyCampaign(record, loginEmail) {
  const company = emailCompany(loginEmail);
  return !!company && emailCompany(campaignOwner(record)) === company;
}

export function companyCampaigns(records, loginEmail) {
  return (Array.isArray(records) ? records : []).filter(record => sameCompanyCampaign(record, loginEmail));
}
