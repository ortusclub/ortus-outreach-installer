// src/preflight-lint.js
// Pure pre-flight lead-sheet linter. No I/O, no browser — takes rows already
// fetched by sheets.js and returns structured findings for the launch gate.
// Spec: docs/superpowers/specs/2026-07-07-preflight-linter-blocklist-design.md
import { extractLinkedInUrl } from './campaign.js';
import { findUnresolvedPlaceholders } from './linkedin/helpers.js';

const COLD_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message', 'inmail_only', 'open_profile_only']);

const COMPANY_ALIASES = ['Company', 'company', 'Company Name', 'Organization'];
const EMAIL_ALIASES = ['Email', 'email', 'E-mail', 'Email Address'];

function firstCell(row, aliases) {
  for (const a of aliases) if (row[a] != null && String(row[a]).trim()) return String(row[a]).trim();
  return '';
}

function companyMatches(company, entryValue) {
  const re = new RegExp(`(^|[^a-z0-9])${entryValue.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
  return re.test(company);
}

function domainMatches(email, entryValue) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const dom = email.slice(at + 1).toLowerCase();
  const v = entryValue.toLowerCase();
  return dom === v || dom.endsWith('.' + v);
}

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

export function lintLeads({ rows, linkedinColumn, mode, templates = {}, blocklist = [], tabCount = 1, gidExplicit = true, dailyLimit = 0, accountCount = 0 }) {
  const blockers = [];
  const warnings = [];
  const passed = [];

  // Only rows the campaign would process: blank Stage (cold) / non-terminal.
  const targets = (rows || []).filter(({ row }) => !stageOf(row));

  const seenUrls = new Map(); // normalized url → [rowNumbers]
  const actionableTargets = []; // rows with a non-empty URL cell (for targetCount + template check)
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

    // Track as actionable (has a URL cell, even if malformed)
    actionableTargets.push({ rowNumber, row });

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

    // Blocklist — cold modes only
    if (COLD_MODES.has(mode)) {
      for (const entry of blocklist) {
        const hit = entry.kind === 'domain'
          ? domainMatches(firstCell(row, EMAIL_ALIASES), entry.value)
          : companyMatches(firstCell(row, COMPANY_ALIASES), entry.value);
        if (hit) {
          blockers.push({
            check: 'blocklist_match', severity: 'blocker', rowIndex: rowNumber, leadName: name,
            detail: `${entry.kind === 'domain' ? 'Email domain' : 'Company'} matches blocklist entry "${entry.value}"${entry.reason ? ` (${entry.reason})` : ''}`,
            stampText: `Skipped: blocklist — ${entry.value}`, url,
          });
          break;
        }
      }
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

  // Template variables that resolve empty for target rows.
  const activeTemplates = Object.values(templates).filter((t) => typeof t === 'string' && t.includes('{'));
  if (activeTemplates.length && actionableTargets.length) {
    const missCount = new Map(); // token → rowNumbers[]
    for (const { rowNumber, row } of actionableTargets) {
      for (const tpl of activeTemplates) {
        for (const token of findUnresolvedPlaceholders(tpl, row)) {
          if (/primary|event|intro/i.test(token)) continue;
          if (!missCount.has(token)) missCount.set(token, []);
          const arr = missCount.get(token);
          if (!arr.includes(rowNumber)) arr.push(rowNumber);
        }
      }
    }
    for (const [token, rowNums] of missCount) {
      warnings.push({
        check: 'empty_template_var', severity: 'warning', rowIndex: rowNums[0], leadName: '',
        detail: `{${token}} is empty in ${rowNums.length} row(s) (${rowNums.slice(0, 10).join(', ')}${rowNums.length > 10 ? ', …' : ''}) — the message would render with a gap`,
        stampText: '', url: '',
      });
    }
  }

  // Sheet-level: configured LinkedIn column must exist in the headers.
  const headerSample = rows?.[0]?.row || {};
  if (linkedinColumn && !(linkedinColumn in headerSample)) {
    blockers.push({
      check: 'column_invalid', severity: 'blocker', rowIndex: null, leadName: '',
      detail: `Column "${linkedinColumn}" not found — headers are: ${Object.keys(headerSample).slice(0, 12).join(', ')}`,
      stampText: '', url: '',
    });
  } else {
    passed.push({ check: 'column_found', detail: `LinkedIn column "${linkedinColumn || '(auto)'}" found` });
  }

  // Sheet-level: ambiguous tab (no explicit gid on a multi-tab spreadsheet).
  if (!gidExplicit && tabCount > 1) {
    blockers.push({
      check: 'ambiguous_tab', severity: 'blocker', rowIndex: null, leadName: '',
      detail: `Sheet URL has no explicit tab (#gid) and the spreadsheet has ${tabCount} tabs — the FIRST tab would be read`,
      stampText: '', url: '',
    });
  } else {
    passed.push({ check: 'tab_resolved', detail: gidExplicit ? 'Tab explicitly selected' : 'Single-tab sheet' });
  }

  if (actionableTargets.length) passed.push({ check: 'targets_found', detail: `${actionableTargets.length} target row(s) ready` });

  // Sanity: list far larger than 2 weeks of capacity.
  if (dailyLimit && accountCount && actionableTargets.length > 14 * dailyLimit * accountCount) {
    warnings.push({
      check: 'list_vs_limit', severity: 'warning', rowIndex: null, leadName: '',
      detail: `${actionableTargets.length} targets vs ~${dailyLimit * accountCount}/day capacity — over two weeks of sending`,
      stampText: '', url: '',
    });
  }

  return {
    blockers, warnings, passed,
    targetCount: actionableTargets.length,
  };
}
