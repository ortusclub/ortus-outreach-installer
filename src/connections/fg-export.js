// FG Invites row schema + pure helpers for the Follower Growth campaign.
// One row per target × operator, written to the central FG sheet's `FG Invites`
// tab. Every cell is coerced to a string (Apps Script setValues needs
// rectangular string data — no undefineds). Mirror of export.js.

// Column order of the `FG Invites` tab. KEEP IN SYNC with fg-apps-script.js —
// tests/connections/fg-export.test.js enforces it rather than trusting this
// comment, which is how the two drifted apart in the first place.
//
// The tab is written in two halves. fgRow builds the BASE columns, which are
// everything known when a row is queued; stampRunCells then appends the RUN
// columns, which only exist once a run has an id. Both widths are derived from
// these two arrays — a fixed 13 used to be written into stampRunCells by hand,
// so adding a 14th base column would have silently truncated it.
export const FG_BASE_COLUMNS = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
];
export const FG_RUN_COLUMNS = ['Run ID', 'Run At', 'Reason'];
export const FG_HEADER = [...FG_BASE_COLUMNS, ...FG_RUN_COLUMNS];

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

// One `FG Invites` row in FG_BASE_COLUMNS order — the row as it is known at
// queue time. It is NOT a full FG_HEADER row: stampRunCells appends the three
// run columns on the way to the sheet, and every write path goes through
// queueFgInvites, which always stamps.
// `record` is an annotated row ({ contact, warmVia, ... }); operatorName /
// account / month come from the campaign.
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
