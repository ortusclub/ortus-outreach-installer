export function matureProfileIdentity(profile, accounts) {
  const emails = `${profile.email || ''} ${profile.name || ''}`.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  const rows = accounts.filter(a=>emails.includes(String(a.email || '').trim().toLowerCase()));
  if (rows.length !== 1) return null;
  const fields = Object.fromEntries(Object.entries(rows[0]).map(([k,v])=>[k.toLowerCase().replace(/[^a-z]/g,''),String(v || '').trim()]));
  const name=fields.nameasitappearsonlinkedin || fields.linkedinname || fields.fullname || fields.name || [fields.firstname,fields.lastname || fields.surname].filter(Boolean).join(' ');
  const url=fields.linkedinurl || fields.linkedinprofileurl || fields.linkedinprofile || fields.profileurl || fields.linkedin || '';
  return {name,linkedinUrl:/^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[^\s/]+/i.test(url) ? url : ''};
}
