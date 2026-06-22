#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFolder } from '../src/connections/csv-ingest.js';
import { searchContacts } from '../src/connections/hubspot-client.js';
import { annotate } from '../src/connections/match.js';
import { writeLeadCsv } from '../src/connections/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let colleagues = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, '../src/connections/colleagues.json'), 'utf8');
  colleagues = JSON.parse(raw);
} catch { /* optional */ }

function die(msg) { console.error('ERROR:', msg); process.exit(1); }
function parseArgs() {
  const a = process.argv.slice(2);
  const lists = { country: [], region: [], city: [], title: [], company: [] };
  const o = { ...lists, all: false, 'csv-dir': undefined, out: undefined };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'all') { o.all = true; continue; }
    if (k === 'csv-dir' || k === 'out') { const v = a[++i]; if (v == null || v.startsWith('--')) die(`--${k} needs a value`); o[k] = v; continue; }
    if (k in lists) { const v = a[++i]; if (v == null || v.startsWith('--')) die(`--${k} needs a value`); o[k].push(v); continue; }
    die(`unknown flag --${k}`);
  }
  return o;
}

(async () => {
  const o = parseArgs();
  const dir = o['csv-dir'] || './data/connections';
  const out = o.out || `./out/warm-reach-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  if (!fs.existsSync(dir)) die(`CSV folder not found: ${dir} — create it and drop the <email>.csv files in.`);
  const { index, stats } = ingestFolder(dir);
  if (stats.files === 0) die(`No .csv files in ${dir} — nothing to match against.`);
  console.log('Ingested networks:', JSON.stringify(stats, null, 2));
  if (o.title.length > 5) console.log(`! ${o.title.length} titles given; HubSpot caps at 5 — using the first 5.`);

  const contacts = await searchContacts({
    countries: o.country, regions: o.region, cities: o.city, jobTitles: o.title, companies: o.company,
  });
  console.log(`HubSpot returned ${contacts.length} contacts`);

  const annotated = annotate(contacts, index);
  const warm = annotated.filter(r => r.hasWarm);
  console.log(`\n${warm.length} warm / ${annotated.length} total (after DNC + dedupe)\n`);
  for (const r of warm.slice(0, 25)) {
    console.log(`  • ${r.contact.firstname || ''} ${r.contact.lastname || ''} — ${r.contact.company || '?'}  →  via ${r.warmVia.join(', ')}`);
  }

  const rowsToWrite = o.all ? annotated : warm;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeLeadCsv(rowsToWrite, out, colleagues);
  console.log(`\nWrote ${rowsToWrite.length} rows (${o.all ? 'all results' : 'warm only'}) → ${out}`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
