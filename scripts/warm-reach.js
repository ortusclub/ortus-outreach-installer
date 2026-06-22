#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFolder } from '../src/connections/csv-ingest.js';
import { lookupBySlugs } from '../src/connections/hubspot-client.js';
import { annotate, matchesCriteria } from '../src/connections/match.js';
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
  const o = { ...lists, 'csv-dir': undefined, out: undefined };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
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

  const criteria = { countries: o.country, regions: o.region, cities: o.city, jobTitles: o.title, companies: o.company };

  const slugs = [...index.keys()];
  console.log(`Looking up ${slugs.length} connections in HubSpot (network-first)…`);
  const contacts = await lookupBySlugs(slugs, {});
  console.log(`HubSpot has ${contacts.length} of these connections as contacts`);

  const annotated = annotate(contacts, index);                  // dedupe + DNC + warmVia
  const filtered = annotated.filter((r) => matchesCriteria(r.contact, criteria));
  console.log(`\n${filtered.length} match your criteria (of ${annotated.length} warm-and-in-HubSpot)\n`);
  for (const r of filtered.slice(0, 25)) {
    console.log(`  • ${r.contact.firstname || ''} ${r.contact.lastname || ''} — ${r.contact.company || '?'} — ${r.contact.jobtitle || '?'}  →  via ${r.warmVia.join(', ')}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeLeadCsv(filtered, out, colleagues);
  console.log(`\nWrote ${filtered.length} rows → ${out}`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
