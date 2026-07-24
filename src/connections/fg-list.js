// src/connections/fg-list.js
// The Follower Growth *invite list* — one Google Sheet tab per run that is BOTH
// the editable intent list AND the ledger. It is the source of truth for who
// gets invited and which GoLogin account sends each invite, and it is where the
// post-run reconcile writes Status / Invited At / Note back. Two entry points
// feed the same tab:
//   1. Auto-generate  — the role-keyword builder writes it (listRowFromContact).
//   2. Bring-your-own — the operator provides a sheet with these columns.
// At fire time BOTH are read with parseListRows() → engine `leads` (each pinned
// to its account via routeAccount), so a hand-edit before the run is honoured.
// The tab NAME encodes the run (e.g. "FG 2026-08-01"), so Run ID / Run At / Month
// are implicit — no need for those columns. Pure module: no I/O, unit-testable.

// Column order of an FG invite-list tab. Human-facing columns first (what the
// operator types / reads), then the ledger columns the reconcile fills in, then
// Member ID last — auto-filled on the auto path, optional/blank on a BYO sheet,
// used only as a robust writeback key alongside the LinkedIn URL.
export const FG_LIST_HEADER = [
  'First Name', 'Last Name', 'LinkedIn URL', 'Job Title', 'Company', 'Account Email',
  'Status', 'Invited At', 'Note', 'Member ID',
];

// Canonical field key → accepted header spellings (lower-cased, trimmed). Keeps
// parseListRows tolerant of column re-ordering and the small wording differences
// a human or a BYO sheet will inevitably have.
const HEADER_ALIASES = {
  firstName: ['first name', 'first', 'firstname', 'given name'],
  lastName: ['last name', 'last', 'lastname', 'surname', 'family name'],
  url: ['linkedin url', 'linkedin', 'url', 'profile url', 'linkedin profile', 'profile'],
  title: ['job title', 'title', 'role', 'position'],
  company: ['company', 'company name', 'organisation', 'organization', 'employer'],
  accountEmail: ['account email', 'account', 'email', 'gologin account', 'gologin', 'sender', 'sending account', 'invited by'],
  status: ['status'],
  invitedAt: ['invited at', 'invited', 'invited on'],
  note: ['note', 'fg note', 'reason', 'notes'],
  memberId: ['member id', 'memberid', 'member', 'linkedin id', 'urn'],
};

const norm = (v) => String(v == null ? '' : v).trim();
const lc = (v) => norm(v).toLowerCase();

// Stable identity key for a LinkedIn URL: lower-cased, protocol/host-agnostic,
// no trailing slash or query/hash. Makes de-dupe and reconcile writeback robust
// to the format differences a human paste inevitably introduces.
export function normUrl(url) {
  let s = lc(url);
  if (!s) return '';
  s = s.split(/[?#]/)[0];                       // drop query + fragment
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, ''); // drop scheme + www
  s = s.replace(/\/+$/, '');                    // drop trailing slashes
  return s;
}

// Writeback identity for a contact/row: numeric Member ID when present (the
// load-bearing id the ledger has always used), else the normalised URL. Mirrors
// fg-export.js inviteKey so auto-path rows keep member-id writeback while BYO /
// hand-edited rows fall back to URL.
export function inviteIdentity({ memberId = '', url = '' } = {}) {
  return norm(memberId) || normUrl(url);
}

// Split a display name into first + rest. "Ada Lovelace King" → { first:'Ada',
// last:'Lovelace King' }. A single token has an empty last name.
export function splitName(fullName) {
  const parts = norm(fullName).split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Map a header row to { field: columnIndex }. Unknown columns are ignored; a
// field with no matching header is simply absent from the returned map.
export function mapHeader(headerRow) {
  const idx = {};
  (headerRow || []).forEach((cell, i) => {
    const key = lc(cell);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (idx[field] === undefined && aliases.includes(key)) { idx[field] = i; break; }
    }
  });
  return idx;
}

// FG_LIST_HEADER-order row from a raw contact ({ firstname, lastname, linkedinbio,
// jobtitle, company, linkedin_membership_id }). Used by the auto-generate path,
// which has clean first/last + Member ID on the contact.
export function listRowFromContact(contact = {}, { accountEmail = '', status = 'Queued' } = {}) {
  const c = contact || {};
  return [
    norm(c.firstname),
    norm(c.lastname),
    norm(c.linkedinbio),
    norm(c.jobtitle),
    norm(c.company),
    lc(accountEmail),
    norm(status) || 'Queued',
    '',                              // Invited At — stamped by reconcile
    '',                              // Note
    norm(c.linkedin_membership_id),  // Member ID
  ];
}

// FG_LIST_HEADER-order row from an FG_HEADER-order row (the shape buildFgTargets
// returns). Splits the combined "Target Name" and carries its Member ID.
export function listRowFromFgRow(fgRow = [], { accountEmail = '', status = 'Queued' } = {}) {
  // FG_HEADER indices: 0 Target Name, 1 LinkedIn URL, 2 Member ID, 3 Company, 4 Job Title
  const { first, last } = splitName(fgRow[0]);
  return [first, last, norm(fgRow[1]), norm(fgRow[4]), norm(fgRow[3]), lc(accountEmail),
    norm(status) || 'Queued', '', '', norm(fgRow[2])];
}

/**
 * Parse an invite-list tab (raw sheet values, header row first) into engine leads.
 * Tolerant of column order via mapHeader(). Every kept lead is pinned to its
 * account with routeAccount = the GoLogin profileId resolved from Account Email.
 *
 * @param {Array<Array>} rows           sheet values; rows[0] is the header
 * @param {Object} opts
 * @param {Object} opts.emailToProfileId  lower-cased account email → GoLogin profileId
 * @param {string} [opts.defaultStatus]   status stamped on rows with a blank Status cell
 * @returns {{ leads:Array, perAccount:Array, skipped:Array }}
 *   leads:     [{ leadUrl, fullName, memberUrn:null, routeAccount, row }]
 *   perAccount:[{ profileId, account(email), rows, rowsByUrl, count }]  rowsByUrl: url → Member ID (or '')
 *   skipped:   [{ rowNumber, reason, url, accountEmail }]  (1-based, matching the sheet)
 */
export function parseListRows(rows, { emailToProfileId = {}, defaultStatus = 'Queued' } = {}) {
  const grid = Array.isArray(rows) ? rows : [];
  if (grid.length < 2) return { leads: [], perAccount: [], skipped: [] };

  // Normalise the email→profileId map keys to lower-case for a forgiving lookup.
  const emailMap = {};
  for (const [email, pid] of Object.entries(emailToProfileId || {})) emailMap[lc(email)] = pid;

  const idx = mapHeader(grid[0]);
  const leads = [];
  const skipped = [];
  const seenId = new Set();           // de-dupe a person listed twice in the same tab
  const byProfile = new Map();        // profileId → perAccount entry

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const rowNumber = r + 1;          // 1-based sheet row (header is row 1)
    const url = norm(row[idx.url]);
    const accountEmail = lc(row[idx.accountEmail]);
    const first = norm(row[idx.firstName]);
    const last = norm(row[idx.lastName]);

    if (!url && !accountEmail && !first && !last) continue; // blank line
    if (!url) { skipped.push({ rowNumber, reason: 'missing LinkedIn URL', url, accountEmail }); continue; }
    if (!accountEmail) { skipped.push({ rowNumber, reason: 'missing Account Email', url, accountEmail }); continue; }

    const profileId = emailMap[accountEmail];
    if (!profileId) { skipped.push({ rowNumber, reason: `unknown account email "${accountEmail}"`, url, accountEmail }); continue; }

    const memberId = norm(row[idx.memberId]);
    const identity = inviteIdentity({ memberId, url });
    if (seenId.has(identity)) { skipped.push({ rowNumber, reason: 'duplicate person', url, accountEmail }); continue; }
    seenId.add(identity);

    const fullName = `${first} ${last}`.trim();
    const company = norm(row[idx.company]);
    const title = norm(row[idx.title]);
    const status = norm(row[idx.status]) || defaultStatus;

    leads.push({
      leadUrl: url,
      fullName,
      memberUrn: null,
      routeAccount: profileId,
      row: { memberId, name: fullName, company, title, accountEmail, status },
    });

    if (!byProfile.has(profileId)) {
      byProfile.set(profileId, { profileId, account: accountEmail, rows: [], rowsByUrl: {}, count: 0 });
    }
    const entry = byProfile.get(profileId);
    entry.rows.push([first, last, url, title, company, accountEmail, status, '', '', memberId]);
    entry.rowsByUrl[url] = memberId;  // Member ID when present → keeps member-id writeback; '' → URL-keyed
    entry.count += 1;
  }

  return { leads, perAccount: [...byProfile.values()], skipped };
}
