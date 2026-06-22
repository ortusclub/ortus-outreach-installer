import fs from 'node:fs';
import path from 'node:path';
import { normalizeSlug } from './slug.js';

// Minimal RFC4180-ish parser: handles quoted fields, "" escapes, commas, CRLF.
export function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function ingestFile(text, colleague, index, stats) {
  const rows = parseCsv(text);
  const h = rows.findIndex(r => r[0] && r[0].trim() === 'First Name' && r.map(x => x.trim()).includes('URL'));
  if (h === -1) { stats.filesNoHeader++; return; }
  const header = rows[h].map(x => x.trim());
  const urlIdx = header.indexOf('URL');
  const connIdx = header.indexOf('Connected On');
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || (r.length === 1 && r[0].trim() === '')) continue;
    stats.rows++;
    const slug = normalizeSlug(r[urlIdx]);
    if (!slug) { stats.skippedNoUrl++; continue; }
    stats.withUrl++;
    if (!index.has(slug)) index.set(slug, []);
    index.get(slug).push({ colleague, connectedOn: connIdx >= 0 ? (r[connIdx] || '').trim() : '' });
  }
}

export function ingestFolder(dirPath) {
  const index = new Map();
  const stats = { files: 0, filesNoHeader: 0, rows: 0, withUrl: 0, skippedNoUrl: 0, perColleague: {} };
  for (const f of fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.csv'))) {
    stats.files++;
    const colleague = f.replace(/\.csv$/i, '');
    const before = stats.withUrl;
    ingestFile(fs.readFileSync(path.join(dirPath, f), 'utf8'), colleague, index, stats);
    stats.perColleague[colleague] = stats.withUrl - before;
  }
  stats.uniqueSlugs = index.size;
  return { index, stats };
}
