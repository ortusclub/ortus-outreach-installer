// FG Invites row schema + pure helpers for the Follower Growth campaign.
// One row per target × operator, written to the central FG sheet's `FG Invites`
// tab. Every cell is coerced to a string (Apps Script setValues needs
// rectangular string data — no undefineds). Mirror of export.js.

// Column order of the `FG Invites` tab. KEEP IN SYNC with fg-apps-script.js.
export const FG_HEADER = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
];

// Which function/title keyword matched this job title (first hit), for the
// Function Match column. v1 function filter = keyword-on-title.
export function functionMatch(jobTitle, keywords = []) {
  const t = (jobTitle || '').toLowerCase();
  return keywords.find((k) => t.includes(String(k).toLowerCase())) || '';
}

// Dedupe identity for a contact: numeric Member ID when present (the load-bearing
// identifier), else the raw LinkedIn URL. Used both to dedupe a build against
// already-invited rows and by the Apps Script to reject duplicate queue writes.
export function inviteKey(contact = {}) {
  return String(contact.linkedin_membership_id || '') || (contact.linkedinbio || '');
}

// One `FG Invites` row in FG_HEADER order. `record` is an annotated row
// ({ contact, warmVia, ... }); operatorName/account/month come from the campaign.
export function fgRow(record, colleagues = {}, { operatorName = '', account = '', month = '', keywords = [], status = 'Queued', note = '' } = {}) {
  const c = record.contact || {};
  const geo = [c.city, c.state, c.country].filter(Boolean).join(', ');
  return [
    `${c.firstname || ''} ${c.lastname || ''}`.trim(),
    c.linkedinbio || '',
    c.linkedin_membership_id || '',
    c.company || '',
    c.jobtitle || '',
    functionMatch(c.jobtitle, keywords),
    geo,
    operatorName,
    account,
    status,
    '',     // Invited At — stamped when marked invited
    note,   // FG Note
    month,
  ].map((v) => (v == null ? '' : String(v)));
}
