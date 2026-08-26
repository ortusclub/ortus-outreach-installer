// src/preflight-lint.js
// Pure pre-flight lead-sheet linter. No I/O, no browser — takes rows already
// fetched by sheets.js and returns structured findings for the launch gate.
// Spec: docs/superpowers/specs/2026-07-07-preflight-linter-blocklist-design.md
import { extractLinkedInUrl } from './campaign.js';
import { findUnresolvedPlaceholders } from './linkedin/helpers.js';
import { parsePersonUrl } from './blocklist.js';

const COMPANY_ALIASES = ['Company', 'company', 'Company Name', 'Organization'];
const EMAIL_ALIASES = ['Email', 'email', 'E-mail', 'Email Address'];

function firstCell(row, aliases) {
  for (const a of aliases) if (row[a] != null && String(row[a]).trim()) return String(row[a]).trim();
  return '';
}

// Case/space-insensitive header lookup. The operator-configured column name may
// not byte-match the sheet header (e.g. "LinkedIn URL" vs "linkedin url"). An
// exact-key read then returns undefined and the linter treats every row as an
// empty cell — skipping ALL checks, INCLUDING the blocklist. That silently sent
// a blocklisted company on a VM run (2026-07-10). The real sender resolves the
// URL tolerantly (extractLinkedInUrl scans every column), so the linter must
// resolve the raw cell the same way — otherwise its "empty vs malformed"
// gate short-circuits the blocklist match.
function cellByHeader(row, header) {
  if (!header) return '';
  if (row[header] != null && String(row[header]).trim()) return String(row[header]).trim();
  const want = String(header).trim().toLowerCase();
  for (const k of Object.keys(row)) {
    if (String(k).trim().toLowerCase() === want && row[k] != null && String(row[k]).trim()) {
      return String(row[k]).trim();
    }
  }
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

export function normalizeProfileUrl(url) {
  return String(url || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '')
    .split('?')[0];
}
// Internal alias kept for backward compat within this file.
const normalizeUrl = normalizeProfileUrl;

// ── main ───────────────────────────────────────────────────────────────────

export function lintLeads({ rows, linkedinColumn, mode, templates = {}, blocklist = [], tabCount = 1, gidExplicit = true, dailyLimit = 0, accountCount = 0 }) {
  const blockers = [];
  const warnings = [];
  const passed = [];

  // Only rows the campaign would process: blank Stage (cold) / non-terminal.
  const targets = (rows || []).filter(({ row }) => !stageOf(row));

  // Surface previously-stamped exclusions explicitly — a row stamped
  // "Skipped: …" by an earlier pre-flight is ignored silently otherwise,
  // which reads as "the blocker disappeared" to the operator.
  const priorSkips = (rows || []).filter(({ row }) => /^skipped:/i.test(stageOf(row)));
  if (priorSkips.length) {
    passed.push({
      check: 'previously_excluded',
      detail: `${priorSkips.length} row(s) already excluded by an earlier pre-flight (rows ${priorSkips.map((r) => r.rowNumber).slice(0, 10).join(', ')}${priorSkips.length > 10 ? ', …' : ''} — see their Stage column) — ignored`,
    });
  }

  const seenUrls = new Map(); // normalized url → [rowNumbers]
  const actionableTargets = []; // rows with a non-empty URL cell (for targetCount + template check)
  for (const { rowNumber, row } of targets) {
    const name = leadName(row);
    const rawCell = cellByHeader(row, linkedinColumn);
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

    // This lead's stable identity for person-blocklist matching. urn matches
    // scraped rows (keyed by memberUrn); slug matches manually-added vanity URLs.
    const leadPerson = parsePersonUrl(url);

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

    // Blocklist — applies to ALL modes (operator decision 2026-07-10): a
    // blocklisted company must never be contacted in ANY campaign type,
    // warm modes (message_only / introduce_back) included.
    {
      for (const entry of blocklist) {
        let hit;
        if (entry.kind === 'person') {
          hit = (entry.urn && leadPerson.urn && entry.urn === leadPerson.urn)
            || (entry.slug && leadPerson.slug && entry.slug === leadPerson.slug);
        } else if (entry.kind === 'domain') {
          hit = domainMatches(firstCell(row, EMAIL_ALIASES), entry.value);
        } else {
          hit = companyMatches(firstCell(row, COMPANY_ALIASES), entry.value);
        }
        if (hit) {
          const label = entry.kind === 'person' ? 'Profile' : entry.kind === 'domain' ? 'Email domain' : 'Company';
          blockers.push({
            check: 'blocklist_match', severity: 'blocker', rowIndex: rowNumber, leadName: name,
            detail: `${label} matches blocklist entry "${entry.value}"${entry.reason ? ` (${entry.reason})` : ''}`,
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
          if (/primary|event|intro|sender/i.test(token)) continue;
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

/**
 * Pure helper: given plain row objects (not already wrapped as {rowNumber,row}),
 * return the set of LinkedIn URLs that should be hard-excluded because they
 * match the blocklist. Applies to every mode — a blocklisted company is never
 * contacted in any campaign type (operator decision 2026-07-10).
 *
 * Wraps rows as { rowNumber: i+2, row } before calling lintLeads so the caller
 * does not need to know the internal shape.
 *
 * @param {object[]} rows           - plain row objects from fetchSheetWithRows
 * @param {{ linkedinColumn: string, mode: string, blocklist: object[] }} opts
 * @returns {string[]}              - array of URLs to exclude
 */
export function blocklistExcludedUrls(rows, { linkedinColumn, mode, blocklist }) {
  const wrapped = (rows || []).map((row, i) => ({ rowNumber: i + 2, row }));
  const findings = lintLeads({ rows: wrapped, linkedinColumn, mode, blocklist });
  return findings.blockers
    .filter((f) => f.check === 'blocklist_match' && f.url)
    .map((f) => f.url);
}
