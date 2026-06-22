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

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { country: [], region: [], city: [], title: [], company: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'csv-dir' || k === 'out' || k === 'warm-only') o[k] = (k === 'warm-only') ? true : a[++i];
    else if (o[k]) o[k].push(a[++i]);
  }
  return o;
}

(async () => {
  const o = parseArgs();
  const dir = o['csv-dir'] || './data/connections';
  const out = o.out || `./out/warm-reach-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  const { index, stats } = ingestFolder(dir);
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

  const rowsToWrite = o['warm-only'] === false ? annotated : warm;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeLeadCsv(rowsToWrite, out, colleagues);
  console.log(`\nWrote ${rowsToWrite.length} rows → ${out}`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
