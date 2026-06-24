#!/usr/bin/env node
// Populate/refresh the local HubSpot cache for the in-app Connections search.
// Thin CLI wrapper around src/connections/cache-builder.js (incremental + resumable).
// Usage: node scripts/build-connections-cache.js [csv-dir]
import dotenv from 'dotenv';
dotenv.config();

import { buildCache, DEFAULT_DIR } from '../src/connections/cache-builder.js';

const dir = process.argv[2] || DEFAULT_DIR;

const r = await buildCache({
  dir,
  onProgress: ({ processed, total, contacts }) => console.log(`  ${processed}/${total} slugs → ${contacts} contacts cached`),
});

console.log(`DONE: looked up ${r.lookedUp} new slugs (+${r.added} contacts) → ${r.totalContacts} contacts for ${r.totalSlugs} slugs across ${r.networks} networks`);
