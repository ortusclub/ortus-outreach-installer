// Receiving accounts must be positively identified as active; missing status is
// not permission to use an account for warm connections.
export function matureAccountEligibility(row = {}) {
  const status = String(row.Status ?? row.status ?? row.accountStatus ?? '').trim().toLowerCase();
  const flagged = row.restricted === true || /^(true|yes|1)$/i.test(String(row.restricted ?? ''));
  const restricted = flagged || status.includes('restricted') || status === 'inaccessible';
  const active = !restricted && (status ? status === 'active' : row.active === true);
  return { active, restricted };
}

export function matureProfileIdentity(profile, accounts) {
  const emails = `${profile.email || ''} ${profile.name || ''}`.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  const rows = accounts.filter(a=>emails.includes(String(a.email || '').trim().toLowerCase()));
  if (rows.length !== 1) return null;
  const fields = Object.fromEntries(Object.entries(rows[0]).map(([k,v])=>[k.toLowerCase().replace(/[^a-z]/g,''),String(v || '').trim()]));
  const name=fields.nameasitappearsonlinkedin || fields.linkedinname || fields.fullname || fields.name || [fields.firstname,fields.lastname || fields.surname].filter(Boolean).join(' ');
  const url=fields.linkedinurl || fields.linkedinprofileurl || fields.linkedinprofile || fields.profileurl || fields.linkedin || '';
  return {...matureAccountEligibility(rows[0]),name,linkedinUrl:/^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[^\s/]+/i.test(url) ? url : ''};
}

// A maturing campaign is always named after the login email of the profile it
// matures: the address used to sign in to the LinkedIn account today. That is a
// company-run mailbox, not the owner's personal Gmail/Yahoo, so a known login
// email (Linked Velocity records one per account) wins, and among the emails in
// the GoLogin profile name a personal-mail address is the last choice.
const PERSONAL_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|gmx|mail)\.[a-z.]+$/;
export function matureCampaignName(profile, loginEmail = '') {
  const known = String(loginEmail || '').trim().toLowerCase();
  if (known) return known;
  const emails = `${profile?.email || ''} ${profile?.name || ''}`.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return emails.find(e => !PERSONAL_MAIL.test(e)) || emails[0] || String(profile?.name || profile?.id || '').trim();
}
