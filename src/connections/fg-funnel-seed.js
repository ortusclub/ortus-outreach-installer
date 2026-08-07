// src/connections/fg-funnel-seed.js
// The team's MANUAL funnel sheet (Project Internal Template FUNNEL_I) as a
// second source for the FG Master tab. Three of its tabs are people-with-
// accounts lists in the same shape we build: "Marketing Leaders 1st Degree
// Connections" (which also records who was invited, by whom), "Sandbox" and
// "Connection Phase AV". Roughly 27k of those people are NOT in the Connections
// DB at all, and ~6k carry an invite the DB has never heard of — so the master
// tab is only honest if it folds them in.
//
// The tabs are exported to CSV (gviz `tqx=out:csv`) into data/funnel-i/ and read
// from there: no live dependency on someone else's spreadsheet at build time, and
// nothing about that sheet's structure can break a build. Re-export the CSVs to
// refresh. Pure module apart from readSeedDir's fs read.
import fs from 'node:fs';
import path from 'node:path';
import { normUrl } from './fg-list.js';
import { masterKey } from './fg-master.js';

const norm = (v) => String(v == null ? '' : v).trim();

// Minimal RFC4180 CSV parse — quoted fields, doubled quotes, embedded newlines.
// The exports are machine-generated so this stays small on purpose.
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Accepted header spellings per field — the three tabs each name things slightly
// differently ("Company" vs "Company Name", "Linkedin Bio" vs "LinkedIn URL").
const ALIASES = {
  name: ['name', 'full name'],
  company: ['company', 'company name'],
  title: ['job title', 'title'],
  memberId: ['membership id', 'linkedin membership id', 'member id'],
  // The /in/ URL. On the 1st-degree tab "Linkedin URL" is the Sales Nav link and
  // "Linkedin Bio" is the real profile URL, so Bio wins where both exist.
  url: ['linkedin bio', 'linkedin url', 'linkedin profile url'],
  accounts: ['linkedin 1st degree connections', 'linkedin 1st connections', 'linkedin account'],
  invited: ['invited'],
  invitedBy: ['if invited, who by', 'invited by'],
};

function headerIndex(headerRow) {
  const lower = (headerRow || []).map((h) => norm(h).toLowerCase());
  const idx = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const at = lower.indexOf(n);
      if (at >= 0) { idx[field] = at; break; }
    }
  }
  return idx;
}

// "Ada Lovelace King" → { first: 'Ada', last: 'Lovelace King' }.
function splitName(full) {
  const parts = norm(full).split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

/**
 * Parse one exported tab into seed records, de-duped by identity within the tab.
 * @returns {Array<{ firstName, lastName, title, company, url, memberId,
 *                   accounts: string[], invited: boolean, invitedBy: string }>}
 */
export function parseSeedCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const idx = headerIndex(rows[0]);
  if (idx.url === undefined && idx.memberId === undefined) return [];
  const out = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((c) => norm(c))) continue;
    const url = norm(row[idx.url]);
    const memberId = norm(row[idx.memberId]);
    const key = masterKey({ memberId, url });
    if (!key || seen.has(key)) continue;      // a person listed twice in one tab
    seen.add(key);
    const { first, last } = splitName(row[idx.name]);
    // Accounts are a "a@x.com; b@y.com" list of the colleagues connected to them.
    const accounts = norm(row[idx.accounts]).split(/[;,]/).map(norm).filter(Boolean);
    out.push({
      firstName: first,
      lastName: last,
      title: norm(row[idx.title]),
      company: norm(row[idx.company]),
      url,
      memberId,
      accounts,
      invited: /invited/i.test(norm(row[idx.invited])),
      invitedBy: norm(row[idx.invitedBy]),
    });
  }
  return out;
}

// Read every *.csv in the seed folder. A missing folder means "no manual funnel
// export on this machine" — a normal state, not a fault, so it yields [].
export function readSeedDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const f of files.sort()) out.push(...parseSeedCsv(fs.readFileSync(path.join(dir, f), 'utf8')));
  return out;
}

/**
 * Fold seed records into already-built FG_MASTER_HEADER-order rows.
 * Matching people gain the seed's accounts (unioned, never replaced) and, only
 * where the row is otherwise blank, its title/company and its manual invite
 * stamp. Unmatched people are appended as new rows. `FG Invites` always wins:
 * a row already stamped from our own ledger is never overwritten by the sheet's
 * hand-typed value.
 * @param {string[][]} rows   rows from buildMasterRows (mutated in place)
 * @param {object[]} seeds    records from parseSeedCsv / readSeedDir
 * @returns {{ rows: string[][], added: number, enriched: number, stamped: number }}
 */
export function mergeFunnelSeeds(rows = [], seeds = []) {
  const I = { title: 2, company: 3, url: 5, memberId: 6, accounts: 7, invited: 8, invitedAt: 9, invitedBy: 10 };
  const byKey = new Map();
  const add = (k, row) => { if (k && !byKey.has(k)) byKey.set(k, row); };
  for (const row of rows) {
    add(masterKey({ memberId: row[I.memberId], url: row[I.url] }), row);
    add(normUrl(row[I.url]), row);            // findable by URL even when keyed by id
  }

  let added = 0, enriched = 0, stamped = 0;
  for (const s of seeds) {
    const key = masterKey({ memberId: s.memberId, url: s.url });
    if (!key) continue;
    let row = byKey.get(key) || (s.url ? byKey.get(normUrl(s.url)) : null);

    if (!row) {
      row = [
        s.firstName, s.lastName, s.title, s.company, '',   // no geo on the manual sheet
        s.url, s.memberId, s.accounts.join(', '),
        '', '', '',
      ];
      rows.push(row);
      add(key, row); add(normUrl(s.url), row);
      added++;
      if (s.invited) { row[I.invited] = 'Invited'; row[I.invitedBy] = s.invitedBy; stamped++; }
      continue;
    }

    // Union the accounts — the manual sheet often knows connections our CSV
    // exports don't, and vice versa.
    const have = new Set(String(row[I.accounts] || '').split(',').map(norm).filter(Boolean).map((e) => e.toLowerCase()));
    let touched = false;
    for (const a of s.accounts) {
      if (have.has(a.toLowerCase())) continue;
      have.add(a.toLowerCase());
      row[I.accounts] = row[I.accounts] ? `${row[I.accounts]}, ${a}` : a;
      touched = true;
    }
    if (!norm(row[I.title]) && s.title) { row[I.title] = s.title; touched = true; }
    if (!norm(row[I.company]) && s.company) { row[I.company] = s.company; touched = true; }
    if (touched) enriched++;

    // Our own ledger wins; only fill an invite the FG Invites backfill left blank.
    if (s.invited && !norm(row[I.invited])) {
      row[I.invited] = 'Invited';
      row[I.invitedBy] = s.invitedBy;         // Invited At stays blank — the sheet never recorded one
      stamped++;
    }
  }
  return { rows, added, enriched, stamped };
}
