/**
 * OP Magellan — "Import from CSV" for accounts that are NOT in GoLogin.
 *
 * The normal Magellan flow collects an account's 1st-degree connections with a
 * live GoLogin browser. Some accounts we want in HubSpot are simply not in
 * GoLogin — but the team already runs those through LinkedHelper, whose export
 * carries the one thing the raw LinkedIn "Export connections" CSV lacks: the
 * numeric LinkedIn member id (`member_id`). That id is what Magellan keys every
 * contact on, so a LinkedHelper export is enough to import without ever touching
 * a browser.
 *
 * This module maps a LinkedHelper export onto Magellan's own connection-CSV
 * shape and stages it under the owner's email, so the existing Check → Import
 * path runs against it unchanged. The Collect step is the only GoLogin-dependent
 * half, and this replaces it.
 */

import { writeAccountCsv } from './magellan-pull.js';

// LinkedHelper's raw `current_company` is sometimes garbage parsed from the
// headline (e.g. "global scale"); its `cs_*` columns are the cleaned ones, so
// prefer those and fall back to the raw fields only when a cs_ cell is blank.
const COLUMN_MAP = {
  memberId: ['member_id'],
  firstName: ['first_name', 'cs_first_name'],
  lastName: ['last_name', 'cs_last_name'],
  url: ['profile_url', 'cs_url'],
  company: ['cs_company_name', 'current_company'],
  position: ['cs_job_title', 'current_company_position'],
  location: ['location_name'],
};

/** Split "First Last" into parts — only used when first/last columns are blank. */
function splitFullName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * A quote-aware splitter for one delimited line. Handles the CSV export
 * (commas, quoted fields with embedded commas/quotes) and the TSV copy format
 * (tabs) with the same code — the delimiter is passed in.
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

/** Tab vs comma — LinkedHelper exports either; pick whichever the header uses more. */
export function detectDelimiter(headerLine) {
  const tabs = (headerLine.match(/\t/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return tabs >= commas ? '\t' : ',';
}

/**
 * Map a LinkedHelper export (raw text) onto Magellan connection rows.
 *
 * @returns {{rows:Array, total:number, skippedNoMemberId:number, hadMemberIdColumn:boolean, header:string[]}}
 *   `rows` are ready for writeAccountCsv. `total` counts every data row seen;
 *   `skippedNoMemberId` is how many had a blank member id (they cannot be
 *   imported — Magellan has nothing to key them on). `hadMemberIdColumn` is
 *   false when the file is not a LinkedHelper export at all (e.g. the raw
 *   LinkedIn "Export connections" CSV) — the caller turns that into a clear
 *   "run it through LinkedHelper first" error rather than importing nothing.
 */
export function mapLinkedHelperRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  // The header is the first line that actually looks like a LinkedHelper export
  // (has member_id + profile_url). LinkedHelper never prepends a preamble, but
  // finding the header defensively also tolerates the raw LinkedIn export's
  // 3-line "Notes:" preamble, so a mis-uploaded file fails cleanly below.
  const headerIdx = lines.findIndex((l) => /(^|[\t,])member_id([\t,]|$)/.test(l) && /profile_url/.test(l));
  if (headerIdx === -1) {
    return { rows: [], total: 0, skippedNoMemberId: 0, hadMemberIdColumn: false, header: [] };
  }
  const delim = detectDelimiter(lines[headerIdx]);
  const header = splitDelimited(lines[headerIdx], delim).map((h) => h.trim());
  // For each field keep EVERY matching column index in preference order, so the
  // fallback (cs_company_name → current_company) happens per ROW: use the first
  // one whose cell is non-empty, not just the first column that exists.
  const cols = Object.fromEntries(Object.entries(COLUMN_MAP).map(
    ([k, names]) => [k, names.map((n) => header.indexOf(n)).filter((i) => i !== -1)],
  ));
  const iFull = header.indexOf('full_name');

  const rows = [];
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

    let firstName = get('firstName');
    let lastName = get('lastName');
    if (!firstName && !lastName && iFull >= 0) {
      ({ firstName, lastName } = splitFullName((f[iFull] || '').trim()));
    }

    rows.push({
      firstName,
      lastName,
      url: get('url'),
      email: '', // Magellan generates the synthetic <memberId>@… key at import
      company: get('company'),
      position: get('position'),
      connectedOn: '', // not imported to HubSpot — internal metadata only
      memberId,
      location: get('location'),
    });
  }
  return { rows, total, skippedNoMemberId, hadMemberIdColumn: true, header };
}

/**
 * Map a LinkedHelper export and stage it under the owner's email, so the normal
 * Magellan Check → Import runs against it. The owner email is lower-cased to
 * match how buildPreview compares accounts (trimmed + lowercased).
 */
export function stageLinkedHelperCsv(ownerEmail, text, deps = {}) {
  const { write = writeAccountCsv, dir } = deps;
  const account = String(ownerEmail || '').trim().toLowerCase();
  if (!account || !account.includes('@')) {
    throw new Error('A valid owner email is required (e.g. kenji@ortusclub.com).');
  }
  const mapped = mapLinkedHelperRows(text);
  if (!mapped.hadMemberIdColumn) {
    throw new Error('This file has no "member_id" column — it looks like a raw LinkedIn export, not a LinkedHelper export. Run it through LinkedHelper first, then upload that.');
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
    file,
  };
}
