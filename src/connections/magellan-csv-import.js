/**
 * OP Magellan — "Import from CSV" for accounts that are NOT in GoLogin.
 *
 * The normal Magellan flow collects an account's 1st-degree connections with a
 * live GoLogin browser. Some accounts we want in HubSpot are simply not in
 * GoLogin — but the operator can run the **Ortus Connections Collector** browser
 * extension on that logged-in LinkedIn account. Its export carries the one thing
 * the raw LinkedIn "Export connections" CSV lacks: the numeric LinkedIn member id.
 * That id is what Magellan keys every contact on, so the extension export is
 * enough to import without this app ever touching a browser.
 *
 * This module maps the extension export onto Magellan's own connection-CSV shape
 * and stages it under the owner's email, so the existing Check → Import path runs
 * against it unchanged. The Collect step is the only GoLogin-dependent half, and
 * this replaces it.
 *
 * The extension writes exactly this header (see the collector's popup.js):
 *   LinkedIn Membership ID, Location, First Name, Last Name, LinkedIn Bio,
 *   Company Name, Job Title, Email, Linkedin First Connections, HubSpot Link
 * — and the "Linkedin First Connections" cell holds `;<owner-email>`, so the
 * owner is recoverable from the file itself and need not be re-typed.
 */

import { writeAccountCsv } from './magellan-pull.js';

// Header name → Magellan field. Matched case-insensitively and trimmed, so a
// stray capitalisation or a spreadsheet round-trip does not break the mapping.
// Each field lists its accepted header spellings in preference order.
const COLUMN_MAP = {
  memberId: ['linkedin membership id', 'member id'],
  firstName: ['first name'],
  lastName: ['last name'],
  url: ['linkedin bio', 'url'],
  company: ['company name', 'company'],
  position: ['job title', 'position'],
  location: ['location'],
  owner: ['linkedin first connections'],
};

/**
 * A quote-aware splitter for one delimited line. Handles the CSV export
 * (commas, quoted fields with embedded commas/quotes) and a TSV copy (tabs)
 * with the same code — the delimiter is passed in.
 */
export function splitDelimited(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Tab vs comma — the extension writes commas, but tolerate a TSV paste too. */
export function detectDelimiter(headerLine) {
  const tabs = (headerLine.match(/\t/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

/** The owners tagged in one "Linkedin First Connections" cell (`;a@x;b@y`). */
function ownersInCell(cell) {
  return String(cell || '').split(';').map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
}

/**
 * Map a Connections Collector export (raw text) onto Magellan connection rows.
 *
 * @returns {{rows:Array, total:number, skippedNoMemberId:number,
 *            hadMemberIdColumn:boolean, owner:(string|null), header:string[]}}
 *   `rows` are ready for writeAccountCsv. `total` counts every data row seen;
 *   `skippedNoMemberId` is how many had a blank/non-numeric member id (they
 *   cannot be imported — Magellan has nothing to key them on). `hadMemberIdColumn`
 *   is false when the file is not a collector export at all (e.g. the raw
 *   LinkedIn "Export connections" CSV) — the caller turns that into a clear error
 *   rather than importing nothing. `owner` is the single owner tagged across the
 *   rows (from "Linkedin First Connections"), or null when absent/ambiguous.
 */
export function mapExtensionRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  // The header is the first line that carries the member-id column. Finding it
  // defensively (rather than assuming line 0) tolerates a mis-uploaded file with
  // a preamble — it simply won't match, and the file fails cleanly below.
  const looksLikeHeader = (l) => /(^|[\t,])\s*"?(linkedin membership id|member id)"?\s*([\t,]|$)/i.test(l);
  const headerIdx = lines.findIndex(looksLikeHeader);
  if (headerIdx === -1) {
    return { rows: [], total: 0, skippedNoMemberId: 0, hadMemberIdColumn: false, owner: null, header: [] };
  }
  const delim = detectDelimiter(lines[headerIdx]);
  const header = splitDelimited(lines[headerIdx], delim).map((h) => h.trim().toLowerCase());
  const cols = Object.fromEntries(Object.entries(COLUMN_MAP).map(
    ([k, names]) => [k, names.map((n) => header.indexOf(n)).filter((i) => i !== -1)],
  ));

  const rows = [];
  const owners = new Set();
  let total = 0;
  let skippedNoMemberId = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i] || !lines[i].trim()) continue;
    const f = splitDelimited(lines[i], delim);
    const get = (key) => {
      for (const ci of cols[key]) { const v = (f[ci] || '').trim(); if (v) return v; }
      return '';
    };
    total += 1;

    const memberId = get('memberId');
    if (!memberId || !/^\d+$/.test(memberId)) { skippedNoMemberId += 1; continue; }

    for (const o of ownersInCell(get('owner'))) owners.add(o);

    rows.push({
      firstName: get('firstName'),
      lastName: get('lastName'),
      url: get('url'),
      email: '', // Magellan generates the synthetic <memberId>@… key at import
      company: get('company'),
      position: get('position'),
      connectedOn: '', // not imported to HubSpot — internal metadata only
      memberId,
      location: get('location'),
    });
  }
  // Only auto-adopt the owner when the file agrees on exactly one — a mixed file
  // must be disambiguated by the operator typing the owner explicitly.
  const owner = owners.size === 1 ? [...owners][0] : null;
  return { rows, total, skippedNoMemberId, hadMemberIdColumn: true, owner, header };
}

/**
 * Map a collector export and stage it under the owner's email, so the normal
 * Magellan Check → Import runs against it. The owner is taken from the explicit
 * argument when given, otherwise from the file's own "Linkedin First Connections"
 * tag; it is lower-cased to match how buildPreview compares accounts.
 */
export function stageConnectionsCsv(ownerEmail, text, deps = {}) {
  const { write = writeAccountCsv, dir } = deps;
  const mapped = mapExtensionRows(text);
  if (!mapped.hadMemberIdColumn) {
    throw new Error('This file has no "LinkedIn Membership ID" column — it doesn\'t look like a Connections Collector export. Run the Ortus Connections Collector extension on that account and upload the CSV it downloads.');
  }
  // Explicit field wins; fall back to the owner the extension tagged in the file.
  const account = String(ownerEmail || mapped.owner || '').trim().toLowerCase();
  if (!account || !account.includes('@')) {
    throw new Error('A valid owner email is required (e.g. kenji@ortusclub.com). The file didn\'t carry one, so please type it.');
  }
  if (!mapped.rows.length) {
    throw new Error(`No importable rows — ${mapped.total} row(s) were read but none had a LinkedIn member id.`);
  }
  const file = write(account, mapped.rows, dir ? { dir } : undefined);
  return {
    account,
    staged: mapped.rows.length,
    skippedNoMemberId: mapped.skippedNoMemberId,
    total: mapped.total,
    ownerFromFile: !ownerEmail && !!mapped.owner,
    file,
  };
}
