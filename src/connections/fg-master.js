// src/connections/fg-master.js
// The FG Master tab — the whole warm network as one flat, human-readable table.
// One row per person: who they are, every Ortus account that holds them as a
// 1st-degree connection, and whether we have invited them yet. Generated from the
// annotated Connections DB (the same join the FG target builder uses), with the
// FG Invites ledger folded in so a rebuild never loses invite history.
// Pure module: no I/O, unit-testable.
import { normUrl } from './fg-list.js';

// KEEP IN SYNC with FG_MASTER_HEADER in fg-apps-script.js.
export const FG_MASTER_HEADER = [
  'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
  'LinkedIn URL', 'Member ID', 'Connected Accounts',
  'Invited', 'Invited At', 'Invited By',
];

const norm = (v) => String(v == null ? '' : v).trim();

// Identity for a person: the numeric Member ID when we have one (load-bearing
// everywhere else in FG), else the normalised URL. Same rule as inviteIdentity()
// in fg-list.js — a person must key identically on both sides of the stamp.
export function masterKey({ memberId = '', url = '' } = {}) {
  return norm(memberId) || normUrl(url);
}

// FG Invites rows → key → { invitedAt, invitedBy } for rows actually Invited.
// Keyed with masterKey (Member ID, else normalised URL) so a master row keyed
// the same way finds it.
export function invitedIndexFromFgInvites(invites = []) {
  const idx = new Map();
  for (const r of invites || []) {
    if (!r || String(r.Status || '') !== 'Invited') continue;
    const key = masterKey({ memberId: r['Member ID'], url: r['LinkedIn URL'] });
    if (!key) continue;
    idx.set(key, { invitedAt: norm(r['Invited At']), invitedBy: norm(r.Account) });
  }
  return idx;
}

// One FG_MASTER_HEADER-order row from an annotated record, or null when the
// contact has no LinkedIn URL (it can never be invited, and cannot be keyed).
export function masterRowFromRecord(record = {}, invitedIndex = null) {
  const c = (record && record.contact) || {};
  const url = norm(c.linkedinbio);
  if (!url) return null;
  const memberId = norm(c.linkedin_membership_id);
  const geo = [c.city, c.state, c.country].map(norm).filter(Boolean).join(', ');
  const accounts = (record.warmVia || []).map(norm).filter(Boolean).join(', ');
  const hit = invitedIndex ? invitedIndex.get(masterKey({ memberId, url })) : null;
  return [
    norm(c.firstname), norm(c.lastname), norm(c.jobtitle), norm(c.company), geo,
    url, memberId, accounts,
    hit ? 'Invited' : '', hit ? norm(hit.invitedAt) : '', hit ? norm(hit.invitedBy) : '',
  ];
}

// Every warm, non-DNC, URL-bearing contact as rectangular string rows.
export function buildMasterRows(annotated = [], invitedIndex = null) {
  const rows = [];
  let droppedNoUrl = 0;
  for (const r of annotated || []) {
    if (!r || r.dnc || !r.hasWarm) continue;
    const row = masterRowFromRecord(r, invitedIndex);
    if (!row) { droppedNoUrl += 1; continue; }
    rows.push(row);
  }
  return { rows, count: rows.length, droppedNoUrl };
}

// Split rows into POST-sized chunks. ~279k rows cannot go over the wire (or into
// one setValues) in a single call.
export function chunkRows(rows = [], size = 5000) {
  const out = [];
  const n = Math.max(1, size);
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}
