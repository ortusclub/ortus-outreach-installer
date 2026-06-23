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

// Coerce any Month cell value to a plain "YYYY-MM" string for budget matching.
// Google Sheets silently turns a "2026-06" string into a Date cell; read back over
// JSON that's an ISO instant ("2026-05-31T22:00:00.000Z" = midnight June 1 in a
// +2 tz), so a naive `=== "2026-06"` compare misses the row. Nudge +12h before
// taking the UTC year-month so any ±12h tz offset rounds back to the intended
// month. A plain "YYYY-MM" is returned as-is; an unparseable value is left intact.
export function normMonth(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return value;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) return typeof value === 'string' ? value : '';
  const d = new Date(ms + 12 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

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
