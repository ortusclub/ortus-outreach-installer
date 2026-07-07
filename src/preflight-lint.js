// src/preflight-lint.js
// Pure pre-flight lead-sheet linter. No I/O, no browser — takes rows already
// fetched by sheets.js and returns structured findings for the launch gate.
// Spec: docs/superpowers/specs/2026-07-07-preflight-linter-blocklist-design.md
import { extractLinkedInUrl } from './campaign.js';

const STAMP_NAME_MISMATCH = 'Skipped: name≠URL';

// ── helpers ────────────────────────────────────────────────────────────────

/** Vanity slug from a LinkedIn URL, or null when encoded/unparseable. */
export function vanitySlug(url) {
  const m = String(url || '').match(/linkedin\.com\/(?:in|pub)\/([^/?#,]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).trim();
  // Encoded member IDs start with ACw/ACo etc. — never a vanity slug.
  if (/^AC[a-zA-Z0-9_-]{6,}/.test(slug)) return null;
  return slug.toLowerCase();
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * True when the slug plausibly belongs to this person: ANY name token of
 * length ≥3 appears in the slug. Missing/short names → true (cannot judge —
 * never false-alarm on partial data).
 */
export function nameMatchesSlug(firstName, lastName, slug) {
  const s = norm(slug);
  const tokens = [
    ...String(firstName || '').split(/\s+/),
    ...String(lastName || '').split(/\s+/),
  ].map(norm).filter((t) => t.length >= 3);
  if (!tokens.length || !s) return true;
  return tokens.some((t) => s.includes(t));
}

function leadName(row) {
  const f = row['First Name'] || row.firstName || row.first_name || '';
  const l = row['Last Name'] || row.lastName || row.last_name || '';
  return `${f} ${l}`.trim();
}

function stageOf(row) {
  return String(row.Stage || row.stage || '').trim();
}

function normalizeUrl(url) {
  return String(url || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '')
    .split('?')[0];
}

// ── main ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
export function lintLeads({ rows, linkedinColumn, mode, templates = {}, blocklist = [], tabCount = 1, gidExplicit = true }) {
  const blockers = [];
  const warnings = [];
  const passed = [];

  // Only rows the campaign would process: blank Stage (cold) / non-terminal.
  const targets = (rows || []).filter(({ row }) => !stageOf(row));

  const seenUrls = new Map(); // normalized url → [rowNumbers]
  for (const { rowNumber, row } of targets) {
    const name = leadName(row);
    const rawCell = linkedinColumn ? row[linkedinColumn] : '';
    let url = '';
    try { url = extractLinkedInUrl(row, linkedinColumn) || ''; } catch { url = ''; }

    // Detect malformed: raw cell has content that doesn't contain linkedin.com,
    // meaning extractLinkedInUrl used the slug-fallback on junk input, OR
    // extractLinkedInUrl returned null (truly empty / no URL found).
    const rawTrimmed = String(rawCell || '').trim();
    const cellIsLinkedIn = rawTrimmed.toLowerCase().includes('linkedin.com');
    if (!rawTrimmed) {
      // Empty cell — simply not a target, no finding
      continue;
    }
    if (!url || !cellIsLinkedIn) {
      blockers.push({
        check: 'malformed_url', severity: 'blocker', rowIndex: rowNumber, leadName: name,
        detail: `URL cell contains "${rawTrimmed.slice(0, 60)}" — not a LinkedIn profile URL`,
        stampText: 'Skipped: malformed URL', url: '',
      });
      continue;
    }

    const nu = normalizeUrl(url);
    if (!seenUrls.has(nu)) seenUrls.set(nu, []);
    seenUrls.get(nu).push(rowNumber);

    const slug = vanitySlug(url);
    if (slug && !nameMatchesSlug(
      row['First Name'] || row.firstName || row.first_name,
      row['Last Name'] || row.lastName || row.last_name,
      slug,
    )) {
      blockers.push({
        check: 'name_url_mismatch', severity: 'blocker', rowIndex: rowNumber, leadName: name,
        detail: `Name "${name}" doesn't match URL slug "${slug}"`,
        stampText: STAMP_NAME_MISMATCH, url,
      });
    }
  }

  for (const [nu, rowNums] of seenUrls) {
    if (rowNums.length > 1) {
      warnings.push({
        check: 'duplicate_url', severity: 'warning', rowIndex: rowNums[0], leadName: '',
        detail: `Same profile in rows ${rowNums.join(', ')} (${nu}) — only the first would be contacted`,
        stampText: '', url: nu,
      });
    }
  }

  return {
    blockers, warnings, passed,
    targetCount: targets.length,
    _targets: targets, // consumed internally by Task 3's checks
  };
}
